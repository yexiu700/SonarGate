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

export interface HttpStreamEvent {
  event: string;
  data: string;
  elapsedMs: number;
}

export interface HttpStreamOrJsonOptions extends Omit<
  HttpRequestOptions,
  'url' | 'method' | 'body'
> {
  /** Fast-fail threshold waiting for HTTP headers / first chunk from upstream. */
  firstByteTimeoutMs?: number | undefined;
  /** Fast-fail threshold for silence between consecutive stream chunks (SSE heartbeat stall). */
  idleTimeoutMs?: number | undefined;
  /** Invoked for each parsed SSE frame when upstream responds with `text/event-stream`. */
  onSseEvent?: ((evt: HttpStreamEvent) => void) | undefined;
}

export interface HttpStreamOrJsonResult<TJson = unknown> {
  mode: 'sse' | 'json';
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  data?: TJson | undefined;
  rawBytes: number;
  timingsMs: {
    dispatchMs: number;
    firstByteMs?: number | undefined;
    totalMs: number;
  };
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

type DestroyableBody = AsyncIterable<unknown> & { destroy?: () => void };

function destroyBodySafely(body: DestroyableBody | undefined): void {
  if (body !== undefined && typeof body.destroy === 'function') {
    try {
      body.destroy();
    } catch {
      // Ignore already-destroyed stream errors
    }
  }
}

function toBufferChunk(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return Buffer.from(String(chunk), 'utf8');
}

function readHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

async function readBoundedBody(
  body: DestroyableBody,
  maxBytes: number,
  throwOnOverflow: boolean,
  engine?: string,
  onChunk?: (chunkBytes: number) => void,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of body) {
    const buf = toBufferChunk(chunk);
    onChunk?.(buf.byteLength);

    totalBytes += buf.byteLength;
    if (totalBytes > maxBytes) {
      destroyBodySafely(body);
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

  private async throwForHttpError(params: {
    statusCode: number;
    responseHeaders: Record<string, string | string[] | undefined>;
    responseBody: DestroyableBody;
    requestHeaders: Record<string, string>;
    url: string;
    engine?: string | undefined;
    provider?: string | undefined;
    requestId?: string | undefined;
  }): Promise<never> {
    const { statusCode, responseHeaders, responseBody, requestHeaders } = params;
    let upstreamBody: string | undefined;
    try {
      const errorBuf = await readBoundedBody(
        responseBody,
        MAX_ERROR_BODY_BYTES,
        false,
        params.engine,
      );
      upstreamBody = sanitizeErrorBodySnippet(errorBuf, collectSecretHeaderValues(requestHeaders));
    } catch {
      destroyBodySafely(responseBody);
    }

    const logFields: Record<string, unknown> = {
      engine: params.engine,
      provider: params.provider,
      requestId: params.requestId,
      statusCode,
      url: sanitizeUrlForLog(params.url),
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
          engine: params.engine,
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
        engine: params.engine,
      });
    }

    if (statusCode === 429) {
      const retryAfterMs = parseRetryAfterMs(responseHeaders['retry-after']);
      throw new GatewayError(429, 'RATE_LIMITED', 'Upstream rate limited (HTTP 429)', {
        retryable: true,
        engine: params.engine,
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
          engine: params.engine,
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
        engine: params.engine,
      },
    );
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
        return await this.throwForHttpError({
          statusCode,
          responseHeaders,
          responseBody: response.body,
          requestHeaders: headers,
          url: options.url,
          engine: options.engine,
          provider: options.provider,
          requestId: options.requestId,
        });
      }

      const contentLengthStr = readHeaderValue(responseHeaders, 'content-length');
      if (contentLengthStr !== undefined && /^\d+$/.test(contentLengthStr.trim())) {
        const contentLength = Number(contentLengthStr.trim());
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          destroyBodySafely(response.body);
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

  /**
   * Sends a POST request that seamlessly handles both `text/event-stream` (SSE) and
   * `application/json` responses, enforcing early first-byte stall detection, inter-chunk
   * idle timeouts, strict byte bounds, and guaranteed socket cleanup on abort/timeout.
   */
  async postStreamOrJson<TJson = unknown>(
    url: string,
    body: unknown,
    options: HttpStreamOrJsonOptions,
  ): Promise<HttpStreamOrJsonResult<TJson>> {
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

    const startedAt = Date.now();
    const maxBytes = options.maxResponseBytes ?? this.defaultMaxResponseBytes;
    const effectiveFirstByteMs =
      options.firstByteTimeoutMs !== undefined &&
      Number.isFinite(options.firstByteTimeoutMs) &&
      options.firstByteTimeoutMs > 0
        ? Math.min(options.firstByteTimeoutMs, options.timeoutMs)
        : undefined;
    const effectiveIdleMs =
      options.idleTimeoutMs !== undefined &&
      Number.isFinite(options.idleTimeoutMs) &&
      options.idleTimeoutMs > 0
        ? Math.min(options.idleTimeoutMs, options.timeoutMs)
        : undefined;

    const attemptController = new AbortController();
    let timeoutReason: 'attempt' | 'first_byte' | 'idle' | undefined;
    let activeBody: DestroyableBody | undefined;

    let firstByteTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const triggerTimeout = (reason: 'attempt' | 'first_byte' | 'idle'): void => {
      if (timeoutReason === undefined) {
        timeoutReason = reason;
      }
      destroyBodySafely(activeBody);
      if (!attemptController.signal.aborted) {
        attemptController.abort();
      }
    };

    const clearFirstByteTimer = (): void => {
      if (firstByteTimer !== undefined) {
        clearTimeout(firstByteTimer);
        firstByteTimer = undefined;
      }
    };

    const clearIdleTimer = (): void => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    const resetIdleTimer = (): void => {
      clearIdleTimer();
      if (effectiveIdleMs !== undefined) {
        idleTimer = setTimeout(() => {
          triggerTimeout('idle');
        }, effectiveIdleMs);
        idleTimer.unref?.();
      }
    };

    const attemptTimer = setTimeout(() => {
      triggerTimeout('attempt');
    }, options.timeoutMs);
    attemptTimer.unref?.();

    if (effectiveFirstByteMs !== undefined && effectiveFirstByteMs < options.timeoutMs) {
      firstByteTimer = setTimeout(() => {
        triggerTimeout('first_byte');
      }, effectiveFirstByteMs);
      firstByteTimer.unref?.();
    }

    const onCallerAbort = (): void => {
      destroyBodySafely(activeBody);
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        destroyBodySafely(activeBody);
      } else {
        options.signal.addEventListener('abort', onCallerAbort, { once: true });
      }
    }

    const combinedSignal =
      options.signal !== undefined
        ? AbortSignal.any([options.signal, attemptController.signal])
        : attemptController.signal;

    const headers: Record<string, string> = {
      accept: 'text/event-stream, application/json',
      ...(options.headers ?? {}),
    };

    let serializedBody: string | undefined;
    if (body !== undefined) {
      if (typeof body === 'string') {
        serializedBody = body;
      } else {
        serializedBody = JSON.stringify(body);
        const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
        if (!hasContentType) {
          headers['content-type'] = 'application/json';
        }
      }
    }

    try {
      const response = await request(url, {
        method: 'POST',
        headers,
        ...(serializedBody !== undefined ? { body: serializedBody } : {}),
        signal: combinedSignal,
        ...(this.dispatcher !== undefined ? { dispatcher: this.dispatcher } : {}),
      });

      const dispatchMs = Math.max(0, Date.now() - startedAt);
      const statusCode = response.statusCode;
      const responseHeaders = response.headers as Record<string, string | string[] | undefined>;
      activeBody = response.body;

      if (statusCode < 200 || statusCode >= 300) {
        clearFirstByteTimer();
        clearIdleTimer();
        return await this.throwForHttpError({
          statusCode,
          responseHeaders,
          responseBody: response.body,
          requestHeaders: headers,
          url,
          engine: options.engine,
          provider: options.provider,
          requestId: options.requestId,
        });
      }

      const contentType = (readHeaderValue(responseHeaders, 'content-type') ?? '').toLowerCase();
      let firstByteMs: number | undefined;

      const onDataActivity = (): void => {
        if (firstByteMs === undefined) {
          firstByteMs = Math.max(0, Date.now() - startedAt);
          clearFirstByteTimer();
        }
        resetIdleTimer();
      };

      if (contentType.includes('text/event-stream')) {
        resetIdleTimer();
        const decoder = new TextDecoder('utf-8');
        let lineBuffer = '';
        let currentEvent = 'message';
        let currentDataLines: string[] = [];
        let totalBytes = 0;
        let doneReceived = false;

        const flushFrame = (): void => {
          if (currentDataLines.length === 0) {
            currentEvent = 'message';
            return;
          }
          const payload = currentDataLines.join('\n');
          const eventName = currentEvent || 'message';
          currentEvent = 'message';
          currentDataLines = [];

          if (payload.trim() === '[DONE]') {
            doneReceived = true;
            return;
          }

          options.onSseEvent?.({
            event: eventName,
            data: payload,
            elapsedMs: Math.max(0, Date.now() - startedAt),
          });
        };

        const processLine = (rawLine: string): void => {
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
          if (line.length === 0) {
            flushFrame();
            return;
          }
          if (line.startsWith(':')) {
            // SSE heartbeat/comment line — activity already reset idle timer
            return;
          }
          if (line.startsWith('event:')) {
            currentEvent = line.slice('event:'.length).trim() || 'message';
            return;
          }
          if (line.startsWith('data:')) {
            const rawVal = line.slice('data:'.length);
            currentDataLines.push(rawVal.startsWith(' ') ? rawVal.slice(1) : rawVal);
          }
        };

        for await (const chunk of response.body) {
          const buf = toBufferChunk(chunk);
          onDataActivity();
          totalBytes += buf.byteLength;
          if (totalBytes > maxBytes) {
            destroyBodySafely(response.body);
            throw new GatewayError(
              502,
              'UPSTREAM_BAD_RESPONSE',
              `Upstream SSE stream exceeded ${maxBytes} bytes limit`,
              {
                retryable: false,
                engine: options.engine,
              },
            );
          }

          lineBuffer += decoder.decode(buf, { stream: true });
          let newlineIdx = lineBuffer.indexOf('\n');
          while (newlineIdx !== -1) {
            const line = lineBuffer.slice(0, newlineIdx);
            lineBuffer = lineBuffer.slice(newlineIdx + 1);
            processLine(line);
            if (doneReceived) {
              break;
            }
            newlineIdx = lineBuffer.indexOf('\n');
          }

          if (doneReceived) {
            destroyBodySafely(response.body);
            break;
          }
        }

        const trailing = decoder.decode();
        if (trailing.length > 0) {
          lineBuffer += trailing;
        }
        if (!doneReceived && lineBuffer.length > 0) {
          processLine(lineBuffer);
        }
        if (!doneReceived) {
          flushFrame();
        }

        return {
          mode: 'sse',
          statusCode,
          headers: responseHeaders,
          rawBytes: totalBytes,
          timingsMs: {
            dispatchMs,
            ...(firstByteMs !== undefined ? { firstByteMs } : {}),
            totalMs: Math.max(0, Date.now() - startedAt),
          },
        };
      }

      // JSON response mode (also fallback when relay responds application/json despite stream=true)
      const contentLengthStr = readHeaderValue(responseHeaders, 'content-length');
      if (contentLengthStr !== undefined && /^\d+$/.test(contentLengthStr.trim())) {
        const contentLength = Number(contentLengthStr.trim());
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          destroyBodySafely(response.body);
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

      const rawBuffer = await readBoundedBody(response.body, maxBytes, true, options.engine, () => {
        onDataActivity();
      });
      const rawText = rawBuffer.toString('utf8');

      let parsed: TJson;
      try {
        parsed = JSON.parse(rawText) as TJson;
      } catch (err) {
        throw new GatewayError(502, 'UPSTREAM_BAD_RESPONSE', 'Upstream returned invalid JSON', {
          retryable: true,
          engine: options.engine,
          cause: err,
        });
      }

      return {
        mode: 'json',
        statusCode,
        headers: responseHeaders,
        data: parsed,
        rawBytes: rawBuffer.byteLength,
        timingsMs: {
          dispatchMs,
          ...(firstByteMs !== undefined ? { firstByteMs } : {}),
          totalMs: Math.max(0, Date.now() - startedAt),
        },
      };
    } catch (err) {
      destroyBodySafely(activeBody);

      if (isGatewayError(err)) {
        throw err;
      }

      if (timeoutReason === 'first_byte') {
        throw new GatewayError(
          408,
          'UPSTREAM_TIMEOUT',
          `Upstream stalled before first byte after ${effectiveFirstByteMs}ms`,
          {
            retryable: true,
            engine: options.engine,
            cause: err,
          },
        );
      }

      if (timeoutReason === 'idle') {
        throw new GatewayError(
          408,
          'UPSTREAM_TIMEOUT',
          `Upstream stream idle timeout after ${effectiveIdleMs}ms without heartbeat`,
          {
            retryable: true,
            engine: options.engine,
            cause: err,
          },
        );
      }

      const errCode = extractErrorCode(err);
      const isTimeoutErr =
        timeoutReason === 'attempt' ||
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
    } finally {
      clearTimeout(attemptTimer);
      clearFirstByteTimer();
      clearIdleTimer();
      options.signal?.removeEventListener('abort', onCallerAbort);
    }
  }
}
