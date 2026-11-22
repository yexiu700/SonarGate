import type { AppConfig } from '../config.js';
import { buildCacheKey, computeResponseTtlMs, type ResponseCache } from './cache.js';
import type { CollectRequest, CollectResponse, SupportedEngine } from './contract.js';
import { upstreamTimeoutError } from './errors.js';
import { resolveGeoContext } from './locale.js';
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

const DEFAULT_DOUBAO_ADAPTIVE_TIMEOUT_MS = 35_000;

/**
 * Core orchestration service for `/v1/collect`.
 * Coordinates EngineRegistry resolution, Singleflight + LRU caching,
 * locale/region/market geo resolution, request deadline budgeting,
 * Semaphore admission, bounded retries, and GeoMix response normalization
 * independently of HTTP transport.
 */
export class CollectService {
  constructor(private readonly deps: CollectServiceDeps) {}

  async execute(input: CollectExecutionInput): Promise<CollectExecutionOutput> {
    const startedAt = Date.now();
    const { config, registry, cache } = this.deps;
    const { request: parsed, requestId, bypassCache } = input;

    const { adapter, semaphore } = registry.resolve(parsed.engine);
    const geo = resolveGeoContext(parsed, {
      locationCode: config.overseas.dataforseo.locationCode,
      languageCode: config.overseas.dataforseo.languageCode,
      countryIso: config.overseas.dataforseo.countryIso,
    });

    const hasExplicitGeo =
      parsed.market !== undefined || parsed.locale !== undefined || parsed.region !== undefined;
    const cacheKey = buildCacheKey(
      adapter.engine,
      parsed.prompt,
      geo.locationCode,
      geo.languageCode,
      hasExplicitGeo
        ? {
            market: geo.market,
            locale: geo.locale,
            region: geo.region,
          }
        : undefined,
    );

    const requestedEngineNormalized = parsed.engine.trim().toLowerCase();
    const isAliasedEngine = requestedEngineNormalized !== adapter.engine;

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
                  let baseAttemptTimeout: number;
                  if (adapter.engine === 'doubao') {
                    baseAttemptTimeout =
                      config.domestic.doubao.timeoutMs ??
                      Math.min(DEFAULT_DOUBAO_ADAPTIVE_TIMEOUT_MS, config.budget.domesticTimeoutMs);
                  } else if (adapter.region === 'domestic') {
                    baseAttemptTimeout = config.budget.domesticTimeoutMs;
                  } else {
                    baseAttemptTimeout = config.budget.overseasTimeoutMs;
                  }

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
                    locationCode: geo.locationCode,
                    languageCode: geo.languageCode,
                    ...(geo.market !== undefined ? { market: geo.market } : {}),
                    ...(geo.locale !== undefined ? { locale: geo.locale } : {}),
                    ...(geo.region !== undefined ? { region: geo.region } : {}),
                    signal: flightController.signal,
                    timeoutMs: attemptTimeoutMs,
                  });

                  const normalized = normalizeResponse({
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

                  if (hasExplicitGeo) {
                    if (geo.market !== undefined) {
                      normalized.rawMeta.market = geo.market;
                    }
                    if (geo.locale !== undefined) {
                      normalized.rawMeta.locale = geo.locale;
                    }
                    if (geo.region !== undefined) {
                      normalized.rawMeta.countryCode = geo.region;
                    }
                  }

                  return normalized;
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
        ...(isAliasedEngine ? { requestedEngine: requestedEngineNormalized } : {}),
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
