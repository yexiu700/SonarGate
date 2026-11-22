import type { FastifyInstance } from 'fastify';
import { ENGINE_ALIASES } from '../core/contract.js';
import type { EngineRegistry } from '../core/registry.js';

export interface HealthRouteOptions {
  registry: EngineRegistry;
  isShuttingDown: () => boolean;
  version?: string | undefined;
}

export function registerHealthRoutes(app: FastifyInstance, options: HealthRouteOptions): void {
  const version = options.version ?? '1.0.0';

  app.get('/health', async (_request, reply) => {
    return reply.code(200).send({
      status: 'ok',
      service: 'sonargate',
      version,
      uptimeSec: Math.floor(process.uptime()),
    });
  });

  app.get('/ready', async (_request, reply) => {
    const configuredCount = options.registry.getConfiguredCount();
    const totalSupported = options.registry.getTotalSupported();
    const ready = !options.isShuttingDown() && configuredCount > 0;

    return reply.code(ready ? 200 : 503).send({
      ready,
      configuredCount,
      totalSupported,
      engines: options.registry.getReadyEngineSummaries(),
      plannedEngines: options.registry.getPlannedStatuses(),
      aliases: ENGINE_ALIASES,
    });
  });
}
