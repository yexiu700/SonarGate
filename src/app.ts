import { randomUUID } from 'node:crypto';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { getConfigWarnings, loadConfig, type AppConfig } from './config.js';
import { ResponseCache } from './core/cache.js';
import type { CollectResponse } from './core/contract.js';
import { internalError, invalidRequestError, isGatewayError } from './core/errors.js';
import { HttpClient } from './core/http-client.js';
import { EngineRegistry } from './core/registry.js';
import { createAuthPreHandler } from './middleware/auth.js';
import { registerCollectRoutes } from './routes/collect.route.js';
import { registerEnginesRoutes } from './routes/engines.route.js';
import { registerHealthRoutes } from './routes/health.route.js';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_BODY_LIMIT_BYTES = 64 * 1024;

export interface BuildAppOptions {
  config?: AppConfig | undefined;
  httpClient?: HttpClient | undefined;
  registry?: EngineRegistry | undefined;
  cache?: ResponseCache<CollectResponse> | undefined;
  logger?: FastifyServerOptions['logger'] | undefined;
}

export type SonarGateApp = FastifyInstance & {
  markShuttingDown(): void;
  isShuttingDown(): boolean;
};

function resolveLoggerOption(
  config: AppConfig,
  loggerOption: FastifyServerOptions['logger'] | undefined,
): NonNullable<FastifyServerOptions['logger']> {
  if (loggerOption !== undefined) {
    return loggerOption;
  }
  return {
    level: config.server.logLevel,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        '*.apiKey',
        '*.password',
        '*.token',
      ],
      censor: '[REDACTED]',
    },
  };
}

function isBodyTooLargeError(err: FastifyError): boolean {
  return err.statusCode === 413 || err.code === 'FST_ERR_CTP_BODY_TOO_LARGE';
}

function isFastifyParseError(err: FastifyError): boolean {
  if (err.statusCode === 400 || err.statusCode === 415) {
    return true;
  }
  return typeof err.code === 'string' && err.code.startsWith('FST_ERR_CTP_');
}

export function buildApp(options: BuildAppOptions = {}): SonarGateApp {
  const config = options.config ?? loadConfig(process.env);
  let shuttingDown = false;

  const app = Fastify({
    bodyLimit: MAX_BODY_LIMIT_BYTES,
    logger: resolveLoggerOption(config, options.logger),
    genReqId(req): string {
      const incoming = req.headers['x-request-id'];
      if (typeof incoming === 'string' && REQUEST_ID_RE.test(incoming)) {
        return incoming;
      }
      return randomUUID();
    },
  });

  for (const warning of getConfigWarnings(config)) {
    app.log.warn({ config: 'budget' }, warning);
  }

  app.decorate('markShuttingDown', (): void => {
    shuttingDown = true;
  });

  app.decorate('isShuttingDown', (): boolean => {
    return shuttingDown;
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
  });

  const httpClient = options.httpClient ?? new HttpClient({ logger: app.log });
  const registry = options.registry ?? EngineRegistry.fromConfig(config, httpClient, app.log);
  const cache =
    options.cache ??
    new ResponseCache<CollectResponse>({
      ttlSeconds: config.cache.ttlSeconds,
      maxEntries: config.cache.maxEntries,
    });
  const authPreHandler = createAuthPreHandler(config.auth.gatewayApiKeys);

  registerHealthRoutes(app, {
    registry,
    isShuttingDown: () => shuttingDown,
  });

  registerEnginesRoutes(app, {
    config,
    registry,
    cache,
    authPreHandler,
  });

  registerCollectRoutes(app, {
    config,
    registry,
    cache,
    authPreHandler,
  });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    reply.header('X-Request-Id', request.id);

    if (isGatewayError(err)) {
      if (err.code === 'UPSTREAM_AUTH_OR_QUOTA' || err.statusCode >= 500) {
        request.log.error(
          {
            err,
            code: err.code,
            statusCode: err.statusCode,
            ...(err.engine !== undefined ? { engine: err.engine } : {}),
            requestId: request.id,
          },
          err.message,
        );
      } else {
        request.log.warn(
          {
            code: err.code,
            statusCode: err.statusCode,
            ...(err.engine !== undefined ? { engine: err.engine } : {}),
            requestId: request.id,
          },
          err.message,
        );
      }

      return reply.code(err.statusCode).send(err.toErrorEnvelope(request.id));
    }

    if (isBodyTooLargeError(err)) {
      return reply.code(413).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Request body exceeds 64 KB limit',
          retryable: false,
          requestId: request.id,
        },
      });
    }

    if (isFastifyParseError(err)) {
      const parsedError = invalidRequestError(err.message || 'Invalid request payload');
      return reply.code(400).send(parsedError.toErrorEnvelope(request.id));
    }

    request.log.error({ err, requestId: request.id }, 'Unhandled gateway error');
    return reply.code(500).send(internalError().toErrorEnvelope(request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    reply.header('X-Request-Id', request.id);
    return reply.code(404).send({
      error: {
        code: 'INVALID_REQUEST',
        message: `Route ${request.method} ${request.url} not found`,
        retryable: false,
        requestId: request.id,
      },
    });
  });

  return app as unknown as SonarGateApp;
}
