import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { AppConfig } from '../config.js';
import type { ResponseCache } from '../core/cache.js';
import { CollectService } from '../core/collect-service.js';
import { collectRequestSchema, type CollectResponse } from '../core/contract.js';
import { invalidRequestError } from '../core/errors.js';
import type { EngineRegistry } from '../core/registry.js';

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
  const collectService = new CollectService({
    config: options.config,
    registry: options.registry,
    cache: options.cache,
  });

  app.post(
    '/v1/collect',
    {
      preHandler: options.authPreHandler,
    },
    async (request, reply) => {
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
      const result = await collectService.execute({
        request: parsed,
        requestId: request.id,
        bypassCache: shouldBypassCache(request.headers['x-bypass-cache'], parsed.noCache),
      });

      request.log.info(
        {
          requestId: request.id,
          engine: result.engine,
          region: result.region,
          provider: result.provider,
          cached: result.cached,
          attempts: result.response.rawMeta.attempts,
          latencyMs: result.latencyMs,
          citationsCount: result.response.citations.length,
          fanOutCount: result.response.fanOutQueries.length,
          ...(result.response.rawMeta.retrievedSources !== undefined
            ? { retrievedSourcesCount: result.response.rawMeta.retrievedSources.length }
            : {}),
          ...(result.response.rawMeta.openedPages !== undefined
            ? { openedPagesCount: result.response.rawMeta.openedPages.length }
            : {}),
          ...(result.response.rawMeta.costUsd !== undefined
            ? { costUsd: result.response.rawMeta.costUsd }
            : {}),
        },
        'collect completed',
      );

      return reply.code(200).send(result.response);
    },
  );
}
