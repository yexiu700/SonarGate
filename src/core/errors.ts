import type { ErrorEnvelope } from './contract.js';

export type GatewayErrorCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_ENGINE'
  | 'UNAUTHORIZED'
  | 'UPSTREAM_TIMEOUT'
  | 'RATE_LIMITED'
  | 'ENGINE_NOT_CONFIGURED'
  | 'UPSTREAM_BAD_RESPONSE'
  | 'UPSTREAM_AUTH_OR_QUOTA';

export const ERROR_STATUS_MAP: Readonly<Record<GatewayErrorCode, number>> = {
  INVALID_REQUEST: 400,
  UNSUPPORTED_ENGINE: 400,
  UNAUTHORIZED: 401,
  UPSTREAM_TIMEOUT: 408,
  RATE_LIMITED: 429,
  ENGINE_NOT_CONFIGURED: 501,
  UPSTREAM_BAD_RESPONSE: 502,
  UPSTREAM_AUTH_OR_QUOTA: 503,
};

export const ERROR_DEFAULT_RETRYABLE: Readonly<Record<GatewayErrorCode, boolean>> = {
  INVALID_REQUEST: false,
  UNSUPPORTED_ENGINE: false,
  UNAUTHORIZED: false,
  UPSTREAM_TIMEOUT: true,
  RATE_LIMITED: true,
  ENGINE_NOT_CONFIGURED: false,
  UPSTREAM_BAD_RESPONSE: true,
  UPSTREAM_AUTH_OR_QUOTA: false,
};

export interface GatewayErrorOptions {
  retryable?: boolean | undefined;
  engine?: string | undefined;
  retryAfterMs?: number | undefined;
  cause?: unknown;
}

export class GatewayError extends Error {
  readonly statusCode: number;
  readonly code: GatewayErrorCode;
  readonly retryable: boolean;
  readonly engine?: string;
  readonly retryAfterMs?: number;

  constructor(
    statusCode: number,
    code: GatewayErrorCode,
    message: string,
    options: GatewayErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'GatewayError';
    Object.setPrototypeOf(this, new.target.prototype);
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = options.retryable ?? ERROR_DEFAULT_RETRYABLE[code];
    if (options.engine !== undefined) {
      this.engine = options.engine;
    }
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }

  toErrorEnvelope(requestId: string): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.engine !== undefined ? { engine: this.engine } : {}),
        requestId,
      },
    };
  }
}

export function isGatewayError(err: unknown): err is GatewayError {
  return err instanceof GatewayError;
}

export function invalidRequestError(
  message: string,
  options: GatewayErrorOptions = {},
): GatewayError {
  return new GatewayError(400, 'INVALID_REQUEST', message, {
    ...options,
    retryable: false,
  });
}

export function unsupportedEngineError(engine: string): GatewayError {
  return new GatewayError(
    400,
    'UNSUPPORTED_ENGINE',
    `Engine "${engine}" is not supported by SonarGate.`,
    {
      retryable: false,
      engine,
    },
  );
}

export function unauthorizedError(message = 'Missing or invalid Bearer token.'): GatewayError {
  return new GatewayError(401, 'UNAUTHORIZED', message, {
    retryable: false,
  });
}

export function upstreamTimeoutError(
  message: string,
  options: GatewayErrorOptions = {},
): GatewayError {
  return new GatewayError(408, 'UPSTREAM_TIMEOUT', message, {
    ...options,
    retryable: options.retryable ?? true,
  });
}

export function rateLimitedError(message: string, options: GatewayErrorOptions = {}): GatewayError {
  return new GatewayError(429, 'RATE_LIMITED', message, {
    ...options,
    retryable: options.retryable ?? true,
  });
}

export function engineNotConfiguredError(engine: string): GatewayError {
  return new GatewayError(501, 'ENGINE_NOT_CONFIGURED', `Engine "${engine}" is not configured.`, {
    retryable: false,
    engine,
  });
}

export function upstreamBadResponseError(
  message: string,
  options: GatewayErrorOptions = {},
): GatewayError {
  return new GatewayError(502, 'UPSTREAM_BAD_RESPONSE', message, {
    ...options,
    retryable: options.retryable ?? true,
  });
}

export function upstreamAuthOrQuotaError(
  message: string,
  options: GatewayErrorOptions = {},
): GatewayError {
  return new GatewayError(503, 'UPSTREAM_AUTH_OR_QUOTA', message, {
    ...options,
    retryable: false,
  });
}
