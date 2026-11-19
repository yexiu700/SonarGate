import { request, type Dispatcher } from 'undici';
import { GatewayError, isGatewayError } from './errors.js';
import type { LoggerLike } from './types.js';

export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 4096;
const MAX_LOGGED_ERROR_BODY_CHARS = 512;

const TIMEOUT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_DESTROYED',
  'UND_ERR_ABORTED',
]);

export interface HttpClientOptions {
  maxResponseBytes?: number | undefined;
  logger?: LoggerLike | undefined;
  dispatcher?: Dispatcher | undefined;
}

export interface HttpRequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | undefined;
  headers?: Record<string, string> | undefined;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  maxResponseBytes?: number | undefined;
  engine?: string | undefined;
  provider?: string | undefined;
  requestId?: string | undefined;
}

export interface HttpJsonResponse<T> {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  data: T;
  rawBytes: number;
}

const RFC9110_HTTP_DATE_RE =
  /^(?:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat),\s+\d{2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT|(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),\s+\d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2}\s+\d{2}:\d{2}:\d{2}\s+GMT|(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(?:\d{2}|\s\d)\s+\d{2}:\d{2}:\d{2}\s+\d{4})$/i;

export function parseRetryAfterMs(
  header: string | string[] | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (header === undefined) {
    return undefined;
  }
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.startsWith('-')) {
    return undefined;
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds)) {
      return Math.max(0, Math.ceil(seconds * 1000));
    }
    return undefined;
  }
  if (!RFC9110_HTTP_DATE_RE.test(trimmed)) {
    return undefined;
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    return Math.max(0, parsedDate - nowMs);
  }
  return undefined;
}

export function sanitizeUrlForLog(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '[invalid-url]';
  }
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

const SECRET_HEADER_NAMES = new Set(['authorization', 'x-api-key', 'api-key', 'x-goog-api-key']);
const MIN_REDACTABLE_SECRET_LENGTH = 6;

/** Collects credential values from outbound headers (with and without the auth scheme prefix). */
export function collectSecretHeaderValues(headers: Record<string, string>): string[] {
  const secrets: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!SECRET_HEADER_NAMES.has(name.toLowerCase())) {
      continue;
    }
    const trimmed = value.trim();
    secrets.push(trimmed);
    const schemeMatch = /^(?:Bearer|Basic|Token)\s+(.+)$/i.exec(trimmed);
    if (schemeMatch?.[1] !== undefined) {
      secrets.push(schemeMatch[1].trim());
    }
  }
  return secrets.filter((s) => s.length >= MIN_REDACTABLE_SECRET_LENGTH);
}

/**
 * Turns a raw upstream error body into a short, log-safe string: redacts the
 * credentials we sent plus common token shapes, strips control characters,
 * collapses whitespace and caps the length.
 */
export function sanitizeErrorBodySnippet(body: Buffer, secrets: readonly string[] = []): string {
  let text = body.toString('utf8');
  // Longest first so a full "Bearer xyz" is replaced before its bare "xyz" suffix.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length >= MIN_REDACTABLE_SECRET_LENGTH) {
      text = text.split(secret).join('[REDACTED]');
    }
  }
  text = text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [REDACTED]')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (text.length > MAX_LOGGED_ERROR_BODY_CHARS) {
    text = `${text.slice(0, MAX_LOGGED_ERROR_BODY_CHARS)}…`;
  }
  return text;
}

async function readBoundedBody(
  body: AsyncIterable<unknown> & { destroy?: () => void },
  maxBytes: number,
  throwOnOverflow: boolean,
  engine?: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : Buffer.from(String(chunk), 'utf8');

    totalBytes += buf.byteLength;
    if (totalBytes > maxBytes) {
      if (typeof body.destroy === 'function') {
        body.destroy();
      }
      if (throwOnOverflow) {
        throw new GatewayError(
          502,
          'UPSTREAM_BAD_RESPONSE',
          `Upstream response exceeded ${maxBytes} bytes limit`,
          {
            retryable: false,
            engine,
          },
        );
      }
      const allowed = maxBytes - (totalBytes - buf.byteLength);
      if (allowed > 0) {
        chunks.push(buf.subarray(0, allowed));
      }
      break;
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks);
}

export class HttpClient {
  private readonly defaultMaxResponseBytes: number;
  private readonly logger?: LoggerLike;
  private readonly dispatcher?: Dispatcher;

  constructor(options: HttpClientOptions = {}) {
    this.defaultMaxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (options.logger !== undefined) {
      this.logger = options.logger;
    }
    if (options.dispatcher !== undefined) {
      this.dispatcher = options.dispatcher;
    }
  }

  async requestJson<T = unknown>(options: HttpRequestOptions): Promise<HttpJsonResponse<T>> {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new GatewayError(
        408,
        'UPSTREAM_TIMEOUT',
        `Upstream request timed out (invalid timeoutMs: ${options.timeoutMs})`,
        {
          retryable: true,
          engine: options.engine,
        },
      );
    }

    const method = options.method ?? 'GET';
    const maxBytes = options.maxResponseBytes ?? this.defaultMaxResponseBytes;
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
    const combinedSignal =
      options.signal !== undefined
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;

    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(options.headers ?? {}),
    };

    let serializedBody: string | undefined;
    if (options.body !== undefined) {
      if (typeof options.body === 'string') {
        serializedBody = options.body;
      } else {
        serializedBody = JSON.stringify(options.body);
        const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
        if (!hasContentType) {
          headers['content-type'] = 'application/json';
        }
      }
    }

    try {
      const response = await request(options.url, {
        method,
        headers,
        ...(serializedBody !== undefined ? { body: serializedBody } : {}),
        signal: combinedSignal,
        ...(this.dispatcher !== undefined ? { dispatcher: this.dispatcher } : {}),
      });

      const statusCode = response.statusCode;
      const responseHeaders = response.headers as Record<string, string | string[] | undefined>;

      if (statusCode < 200 || statusCode >= 300) {
        // Drain bounded snippet and destroy remainder to avoid leaking keep-alive sockets
        let upstreamBody: string | undefined;
        try {
          const errorBuf = await readBoundedBody(
            response.body,
            MAX_ERROR_BODY_BYTES,
            false,
            options.engine,
          );
          upstreamBody = sanitizeErrorBodySnippet(errorBuf, collectSecretHeaderValues(headers));
        } catch {
          if (typeof response.body.destroy === 'function') {
            response.body.destroy();
          }
        }

        const logFields: Record<string, unknown> = {
          engine: options.engine,
          provider: options.provider,
          requestId: options.requestId,
          statusCode,
          url: sanitizeUrlForLog(options.url),
          ...(upstreamBody !== undefined && upstreamBody.length > 0 ? { upstreamBody } : {}),
        };

        if (statusCode === 401 || statusCode === 403) {
          this.logger?.error(logFields, 'Upstream authentication or quota error');
          throw new GatewayError(
            503,
            'UPSTREAM_AUTH_OR_QUOTA',
            `Upstream authentication or quota error (HTTP ${statusCode})`,
            {
              retryable: false,
              engine: options.engine,
            },
          );
        }

        const isRetryableStatus =
          statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
        if (isRetryableStatus) {
          this.logger?.debug(logFields, 'Upstream returned retryable HTTP error');
        } else {
          this.logger?.warn(logFields, 'Upstream rejected request');
        }

        if (statusCode === 408) {
          throw new GatewayError(408, 'UPSTREAM_TIMEOUT', 'Upstream request timed out (HTTP 408)', {
            retryable: true,
            engine: options.engine,
          });
        }

        if (statusCode === 429) {
          const retryAfterMs = parseRetryAfterMs(responseHeaders['retry-after']);
          throw new GatewayError(429, 'RATE_LIMITED', 'Upstream rate limited (HTTP 429)', {
            retryable: true,
            engine: options.engine,
            retryAfterMs,
          });
        }

        if (statusCode >= 500 && statusCode <= 599) {
          const retryAfterMs = parseRetryAfterMs(responseHeaders['retry-after']);
          throw new GatewayError(
            502,
            'UPSTREAM_BAD_RESPONSE',
            `Upstream server error (HTTP ${statusCode})`,
            {
              retryable: true,
              engine: options.engine,
              retryAfterMs,
            },
          );
        }

        throw new GatewayError(
          502,
          'UPSTREAM_BAD_RESPONSE',
          `Upstream HTTP error (HTTP ${statusCode})`,
          {
            retryable: false,
            engine: options.engine,
          },
        );
      }

      const rawContentLength = responseHeaders['content-length'];
      const contentLengthStr = Array.isArray(rawContentLength)
        ? rawContentLength[0]
        : rawContentLength;
      if (contentLengthStr !== undefined && /^\d+$/.test(contentLengthStr.trim())) {
        const contentLength = Number(contentLengthStr.trim());
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          if (typeof response.body.destroy === 'function') {
            response.body.destroy();
          }
          throw new GatewayError(
            502,
            'UPSTREAM_BAD_RESPONSE',
            `Upstream response Content-Length (${contentLength}) exceeded ${maxBytes} bytes limit`,
            {
              retryable: false,
              engine: options.engine,
            },
          );
        }
      }

      const rawBuffer = await readBoundedBody(response.body, maxBytes, true, options.engine);
      const rawText = rawBuffer.toString('utf8');

      let parsed: T;
      try {
        parsed = JSON.parse(rawText) as T;
      } catch (err) {
        throw new GatewayError(502, 'UPSTREAM_BAD_RESPONSE', 'Upstream returned invalid JSON', {
          retryable: true,
          engine: options.engine,
          cause: err,
        });
      }

      return {
        statusCode,
        headers: responseHeaders,
        data: parsed,
        rawBytes: rawBuffer.byteLength,
      };
    } catch (err) {
      if (isGatewayError(err)) {
        throw err;
      }

      const errCode = extractErrorCode(err);
      const isTimeoutErr =
        timeoutSignal.aborted ||
        (err instanceof Error && err.name === 'TimeoutError') ||
        (errCode !== undefined && TIMEOUT_ERROR_CODES.has(errCode));

      if (isTimeoutErr) {
        throw new GatewayError(
          408,
          'UPSTREAM_TIMEOUT',
          `Upstream request timed out after ${options.timeoutMs}ms`,
          {
            retryable: true,
            engine: options.engine,
            cause: err,
          },
        );
      }

      if (options.signal?.aborted) {
        throw new GatewayError(408, 'UPSTREAM_TIMEOUT', 'Request aborted by caller deadline', {
          retryable: false,
          engine: options.engine,
          cause: err,
        });
      }

      if (errCode !== undefined && RETRYABLE_NETWORK_ERROR_CODES.has(errCode)) {
        throw new GatewayError(
          502,
          'UPSTREAM_BAD_RESPONSE',
          `Upstream network error (${errCode})`,
          {
            retryable: true,
            engine: options.engine,
            cause: err,
          },
        );
      }

      throw new GatewayError(502, 'UPSTREAM_BAD_RESPONSE', 'Upstream request failed', {
        retryable: true,
        engine: options.engine,
        cause: err,
      });
    }
  }

  async postJson<T = unknown>(
    url: string,
    body: unknown,
    options: Omit<HttpRequestOptions, 'url' | 'method' | 'body'>,
  ): Promise<HttpJsonResponse<T>> {
    return this.requestJson<T>({
      ...options,
      url,
      method: 'POST',
      body,
    });
  }
}
