import { GatewayError, isGatewayError } from './errors.js';

export const DEFAULT_MAX_BACKOFF_MS = 8_000;
export const DEFAULT_MAX_JITTER_MS = 500;
export const DEFAULT_MIN_REMAINING_BUDGET_MS = 12_000;

const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'EPIPE',
]);

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  deadlineMs: number;
  maxBackoffMs?: number | undefined;
  maxJitterMs?: number | undefined;
  minRemainingBudgetMs?: number | undefined;
  signal?: AbortSignal | undefined;
  engine?: string | undefined;
  now?: (() => number) | undefined;
  random?: (() => number) | undefined;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  onRetry?: ((attempt: number, delayMs: number, err: unknown) => void) | undefined;
}

export interface RetryResult<T> {
  value: T;
  attempts: number;
}

function extractErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const record = err as Record<string, unknown>;
  if (typeof record['code'] === 'string') {
    return record['code'];
  }
  if (record['cause'] !== undefined) {
    return extractErrorCode(record['cause']);
  }
  return undefined;
}

export function isRetryableError(err: unknown): boolean {
  if (isGatewayError(err)) {
    return err.retryable;
  }
  const code = extractErrorCode(err);
  if (code !== undefined && RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }
  return false;
}

export function defaultSleep(ms: number, signal?: AbortSignal, engine?: string): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      new GatewayError(408, 'UPSTREAM_TIMEOUT', 'Request aborted during retry backoff', {
        retryable: false,
        engine,
      }),
    );
  }
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        new GatewayError(408, 'UPSTREAM_TIMEOUT', 'Request aborted during retry backoff', {
          retryable: false,
          engine,
        }),
      );
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<RetryResult<T>> {
  const maxRetries = Math.max(0, options.maxRetries);
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const maxJitterMs = options.maxJitterMs ?? DEFAULT_MAX_JITTER_MS;
  const minRemainingBudgetMs = options.minRemainingBudgetMs ?? DEFAULT_MIN_REMAINING_BUDGET_MS;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep =
    options.sleep ??
    ((ms: number, signal?: AbortSignal) => defaultSleep(ms, signal, options.engine));

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new GatewayError(408, 'UPSTREAM_TIMEOUT', 'Request aborted before upstream attempt', {
        retryable: false,
        engine: options.engine,
      });
    }

    try {
      const value = await fn(attempt);
      return { value, attempts: attempt };
    } catch (err) {
      if (attempt > maxRetries || !isRetryableError(err)) {
        throw err;
      }

      if (options.signal?.aborted) {
        throw new GatewayError(408, 'UPSTREAM_TIMEOUT', 'Request aborted before retry', {
          retryable: false,
          engine: options.engine,
          cause: err,
        });
      }

      const expDelay = Math.min(options.baseDelayMs * Math.pow(2, attempt - 1), maxBackoffMs);
      const jitter = Math.floor(random() * (maxJitterMs + 1));
      let delayMs = expDelay + jitter;

      if (isGatewayError(err) && err.retryAfterMs !== undefined && err.retryAfterMs >= 0) {
        delayMs = err.retryAfterMs;
      }

      const remainingMs = options.deadlineMs - now();
      if (remainingMs - delayMs < minRemainingBudgetMs) {
        throw err;
      }

      options.onRetry?.(attempt, delayMs, err);
      await sleep(delayMs, options.signal);
    }
  }

  throw new GatewayError(502, 'UPSTREAM_BAD_RESPONSE', 'Retry loop exited unexpectedly', {
    retryable: false,
    engine: options.engine,
  });
}
