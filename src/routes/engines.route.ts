import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { AppConfig } from '../config.js';
import type { ResponseCache } from '../core/cache.js';
import { ENGINE_ALIASES, type CollectResponse } from '../core/contract.js';
import type { EngineRegistry } from '../core/registry.js';

export interface EnginesRouteOptions {
  config: AppConfig;
  registry: EngineRegistry;
  cache: ResponseCache<CollectResponse>;
  authPreHandler: preHandlerHookHandler;
}

export function registerEnginesRoutes(app: FastifyInstance, options: EnginesRouteOptions): void {
  app.get(
    '/v1/engines',
    {
      preHandler: options.authPreHandler,
    },
    async (_request, reply) => {
      return reply.code(200).send({
        engines: options.registry.getStatuses(),
        plannedEngines: options.registry.getPlannedStatuses(),
        aliases: ENGINE_ALIASES,
        configuredCount: options.registry.getConfiguredCount(),
        totalSupported: options.registry.getTotalSupported(),
        cache: {
          enabled: options.cache.enabled,
          ttlSeconds: options.config.cache.ttlSeconds,
          maxEntries: options.config.cache.maxEntries,
          size: options.cache.size,
          inflightCount: options.cache.inflightCount,
        },
      });
    },
  );
}
