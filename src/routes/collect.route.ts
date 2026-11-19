import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { AppConfig } from '../config.js';
import { buildCacheKey, computeResponseTtlMs, type ResponseCache } from '../core/cache.js';
import { collectRequestSchema, type CollectResponse } from '../core/contract.js';
import { invalidRequestError, upstreamTimeoutError } from '../core/errors.js';
import { normalizeResponse } from '../core/normalizer.js';
import type { EngineRegistry } from '../core/registry.js';
import { DEFAULT_MIN_REMAINING_BUDGET_MS, withRetry } from '../core/retry.js';

export interface CollectRouteOptions {
  config: AppConfig;
  registry: EngineRegistry;
  cache: ResponseCache<CollectResponse>;
  authPreHandler: preHandlerHookHandler;
}

function shouldBypassCache(
  bypassHeader: string | string[] | undefined,
  noCacheBody: boolean | undefined,
): boolean {
  if (noCacheBody === true) {
    return true;
  }
  const raw = Array.isArray(bypassHeader) ? bypassHeader[0] : bypassHeader;
  return (raw ?? '').trim().toLowerCase() === 'true';
}

export function registerCollectRoutes(app: FastifyInstance, options: CollectRouteOptions): void {
  app.post(
    '/v1/collect',
    {
      preHandler: options.authPreHandler,
    },
    async (request, reply) => {
      const startedAt = Date.now();
      const parsedResult = collectRequestSchema.safeParse(request.body);
      if (!parsedResult.success) {
        const message = parsedResult.error.issues
          .map((issue) => {
            const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
            return `${path}${issue.message}`;
          })
          .join('; ');
        throw invalidRequestError(message || 'Invalid collect request payload');
      }

      const parsed = parsedResult.data;
      const { adapter, semaphore } = options.registry.resolve(parsed.engine);

      const locationCode = parsed.locationCode ?? options.config.overseas.dataforseo.locationCode;
      const languageCode = parsed.languageCode ?? options.config.overseas.dataforseo.languageCode;
      const bypassCache = shouldBypassCache(request.headers['x-bypass-cache'], parsed.noCache);
      const cacheKey = buildCacheKey(adapter.engine, parsed.prompt, locationCode, languageCode);

      const lookup = await options.cache.getOrExecute(
        cacheKey,
        async () => {
          const flightStartedAt = Date.now();
          const deadlineMs = flightStartedAt + options.config.budget.gatewayRequestTimeoutMs;
          const flightController = new AbortController();
          const flightTimer = setTimeout(() => {
            flightController.abort();
          }, options.config.budget.gatewayRequestTimeoutMs);
          flightTimer.unref?.();

          try {
            return await semaphore.run(
              async () => {
                const retryResult = await withRetry(
                  async (attempt) => {
                    const baseAttemptTimeout =
                      adapter.region === 'domestic'
                        ? options.config.budget.domesticTimeoutMs
                        : options.config.budget.overseasTimeoutMs;
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
                      requestId: request.id,
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
                        requestId: request.id,
                        latencyMs: Math.max(0, Date.now() - flightStartedAt),
                        attempts: attempt,
                        cached: false,
                      },
                    });
                  },
                  {
                    maxRetries: options.config.budget.maxUpstreamRetries,
                    baseDelayMs: options.config.budget.retryBaseDelayMs,
                    deadlineMs,
                    minRemainingBudgetMs: DEFAULT_MIN_REMAINING_BUDGET_MS,
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
          getTtlMs: (res) => computeResponseTtlMs(res, options.config.cache.ttlSeconds),
        },
      );

      const latencyMs = Math.max(0, Date.now() - startedAt);
      const response: CollectResponse = {
        ...lookup.value,
        rawMeta: {
          ...lookup.value.rawMeta,
          requestId: request.id,
          latencyMs,
          cached: lookup.cached,
        },
      };

      request.log.info(
        {
          requestId: request.id,
          engine: adapter.engine,
          region: adapter.region,
          provider: adapter.provider,
          cached: lookup.cached,
          attempts: response.rawMeta.attempts,
          latencyMs,
          citationsCount: response.citations.length,
          fanOutCount: response.fanOutQueries.length,
          ...(response.rawMeta.costUsd !== undefined ? { costUsd: response.rawMeta.costUsd } : {}),
        },
        'collect completed',
      );

      return reply.code(200).send(response);
    },
  );
}
