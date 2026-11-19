import type { AppConfig } from '../config.js';
import { buildCacheKey, computeResponseTtlMs, type ResponseCache } from './cache.js';
import type { CollectRequest, CollectResponse, SupportedEngine } from './contract.js';
import { upstreamTimeoutError } from './errors.js';
import { normalizeResponse } from './normalizer.js';
import type { EngineRegistry } from './registry.js';
import { withRetry } from './retry.js';
import type { EngineRegion } from './types.js';

export interface CollectServiceDeps {
  config: AppConfig;
  registry: EngineRegistry;
  cache: ResponseCache<CollectResponse>;
}

export interface CollectExecutionInput {
  request: CollectRequest;
  requestId: string;
  bypassCache: boolean;
}

export interface CollectExecutionOutput {
  response: CollectResponse;
  engine: SupportedEngine;
  region: EngineRegion;
  provider: string;
  cached: boolean;
  latencyMs: number;
}

/**
 * Core orchestration service for `/v1/collect`.
 * Coordinates EngineRegistry resolution, Singleflight + LRU caching,
 * request deadline budgeting, Semaphore admission, bounded retries,
 * and GeoMix response normalization independently of HTTP transport.
 */
export class CollectService {
  constructor(private readonly deps: CollectServiceDeps) {}

  async execute(input: CollectExecutionInput): Promise<CollectExecutionOutput> {
    const startedAt = Date.now();
    const { config, registry, cache } = this.deps;
    const { request: parsed, requestId, bypassCache } = input;

    const { adapter, semaphore } = registry.resolve(parsed.engine);
    const locationCode = parsed.locationCode ?? config.overseas.dataforseo.locationCode;
    const languageCode = parsed.languageCode ?? config.overseas.dataforseo.languageCode;
    const cacheKey = buildCacheKey(adapter.engine, parsed.prompt, locationCode, languageCode);

    const lookup = await cache.getOrExecute(
      cacheKey,
      async () => {
        const flightStartedAt = Date.now();
        const deadlineMs = flightStartedAt + config.budget.gatewayRequestTimeoutMs;
        const flightController = new AbortController();
        const flightTimer = setTimeout(() => {
          flightController.abort();
        }, config.budget.gatewayRequestTimeoutMs);
        flightTimer.unref?.();

        try {
          return await semaphore.run(
            async () => {
              const retryResult = await withRetry(
                async (attempt) => {
                  const baseAttemptTimeout =
                    adapter.region === 'domestic'
                      ? config.budget.domesticTimeoutMs
                      : config.budget.overseasTimeoutMs;
                  const remainingMs = deadlineMs - Date.now();
                  if (remainingMs <= 0) {
                    throw upstreamTimeoutError('Gateway request deadline exceeded', {
                      engine: adapter.engine,
                      retryable: false,
                    });
                  }
                  const attemptTimeoutMs = Math.min(baseAttemptTimeout, remainingMs);

                  const adapterResult = await adapter.collect({
                    prompt: parsed.prompt,
                    engine: adapter.engine,
                    requestId,
                    locationCode,
                    languageCode,
                    signal: flightController.signal,
                    timeoutMs: attemptTimeoutMs,
                  });

                  return normalizeResponse({
                    result: adapterResult,
                    prompt: parsed.prompt,
                    meta: {
                      engine: adapter.engine,
                      region: adapter.region,
                      requestId,
                      latencyMs: Math.max(0, Date.now() - flightStartedAt),
                      attempts: attempt,
                      cached: false,
                    },
                  });
                },
                {
                  maxRetries: config.budget.maxUpstreamRetries,
                  baseDelayMs: config.budget.retryBaseDelayMs,
                  deadlineMs,
                  minRemainingBudgetMs: config.budget.retryMinRemainingBudgetMs,
                  signal: flightController.signal,
                  engine: adapter.engine,
                },
              );

              return retryResult.value;
            },
            {
              signal: flightController.signal,
              engine: adapter.engine,
            },
          );
        } finally {
          clearTimeout(flightTimer);
        }
      },
      {
        bypassCache,
        getTtlMs: (res) => computeResponseTtlMs(res, config.cache.ttlSeconds),
      },
    );

    const latencyMs = Math.max(0, Date.now() - startedAt);
    const response: CollectResponse = {
      ...lookup.value,
      rawMeta: {
        ...lookup.value.rawMeta,
        requestId,
        latencyMs,
        cached: lookup.cached,
      },
    };

    return {
      response,
      engine: adapter.engine,
      region: adapter.region,
      provider: adapter.provider,
      cached: lookup.cached,
      latencyMs,
    };
  }
}
