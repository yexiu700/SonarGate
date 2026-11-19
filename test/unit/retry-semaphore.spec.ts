import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { loadConfig } from '../../src/config.js';
import {
  GatewayError,
  invalidRequestError,
  rateLimitedError,
  unauthorizedError,
  upstreamAuthOrQuotaError,
  upstreamBadResponseError,
} from '../../src/core/errors.js';
import { HttpClient, parseRetryAfterMs, sanitizeUrlForLog } from '../../src/core/http-client.js';
import { withRetry } from '../../src/core/retry.js';
import { Semaphore } from '../../src/core/semaphore.js';

describe('retry', () => {
  it('retries on 429 and 502 retryable errors and succeeds on 3rd attempt', async () => {
    const delays: number[] = [];
    let attemptCount = 0;
    const nowMs = 1_000_000;

    const result = await withRetry(
      async (attempt) => {
        attemptCount = attempt;
        if (attempt === 1) {
          throw rateLimitedError('Rate limited', { engine: 'doubao' });
        }
        if (attempt === 2) {
          throw upstreamBadResponseError('Bad gateway', { engine: 'doubao' });
        }
        return 'ok';
      },
      {
        maxRetries: 2,
        baseDelayMs: 1000,
        deadlineMs: nowMs + 60_000,
        now: () => nowMs,
        random: () => 0.5,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(result).toEqual({ value: 'ok', attempts: 3 });
    expect(attemptCount).toBe(3);
    expect(delays).toEqual([1250, 2250]);
  });

  it('does not retry on non-retryable errors (400, 401, 503 UPSTREAM_AUTH_OR_QUOTA)', async () => {
    const errors = [
      invalidRequestError('bad payload'),
      unauthorizedError('bad token'),
      upstreamAuthOrQuotaError('upstream 401'),
    ];

    for (const err of errors) {
      let calls = 0;
      await expect(
        withRetry(
          async () => {
            calls += 1;
            throw err;
          },
          {
            maxRetries: 2,
            baseDelayMs: 100,
            deadlineMs: Date.now() + 60_000,
            sleep: async () => {},
          },
        ),
      ).rejects.toBe(err);
      expect(calls).toBe(1);
    }
  });

  it('honors Retry-After from GatewayError over exponential backoff', async () => {
    const delays: number[] = [];
    const nowMs = 1_000_000;

    const result = await withRetry(
      async (attempt) => {
        if (attempt === 1) {
          throw rateLimitedError('429', { retryAfterMs: 2500 });
        }
        return 'recovered';
      },
      {
        maxRetries: 2,
        baseDelayMs: 1000,
        deadlineMs: nowMs + 60_000,
        now: () => nowMs,
        random: () => 0,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(result).toEqual({ value: 'recovered', attempts: 2 });
    expect(delays).toEqual([2500]);
  });

  it('aborts retry immediately without sleeping when remainingMs - delayMs < 12_000', async () => {
    const sleepSpy = vi.fn(async () => {});
    const nowMs = 1_000_000;
    const err = rateLimitedError('429');

    // Tight deadline: 12_500ms remaining, delayMs = 1000 => 11_500 < 12_000
    await expect(
      withRetry(
        async () => {
          throw err;
        },
        {
          maxRetries: 2,
          baseDelayMs: 1000,
          deadlineMs: nowMs + 12_500,
          now: () => nowMs,
          random: () => 0,
          sleep: sleepSpy,
        },
      ),
    ).rejects.toBe(err);
    expect(sleepSpy).not.toHaveBeenCalled();

    // Large Retry-After pushes remaining budget below 12_000ms
    const errLargeRetryAfter = rateLimitedError('429', { retryAfterMs: 25_000 });
    await expect(
      withRetry(
        async () => {
          throw errLargeRetryAfter;
        },
        {
          maxRetries: 2,
          baseDelayMs: 1000,
          deadlineMs: nowMs + 30_000,
          now: () => nowMs,
          random: () => 0,
          sleep: sleepSpy,
        },
      ),
    ).rejects.toBe(errLargeRetryAfter);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('aborts cleanly on AbortSignal during retry sleep and preserves engine', async () => {
    const controller = new AbortController();
    const promise = withRetry(
      async () => {
        throw upstreamBadResponseError('transient', { engine: 'doubao' });
      },
      {
        maxRetries: 2,
        baseDelayMs: 5_000,
        deadlineMs: Date.now() + 60_000,
        signal: controller.signal,
        engine: 'doubao',
      },
    );

    setTimeout(() => controller.abort(), 20);

    await expect(promise).rejects.toMatchObject({
      statusCode: 408,
      code: 'UPSTREAM_TIMEOUT',
      retryable: false,
      engine: 'doubao',
    });
  });
});

describe('semaphore', () => {
  it('enforces maxConcurrency and strict FIFO ordering for queued tasks', async () => {
    const sem = new Semaphore({ maxConcurrency: 2, waitTimeoutMs: 5_000, name: 'test-sem' });
    let activeNow = 0;
    let maxObservedActive = 0;
    const startOrder: number[] = [];

    const gates = Array.from({ length: 5 }, () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    });

    const tasks = gates.map((gate, idx) =>
      sem.run(async () => {
        const id = idx + 1;
        startOrder.push(id);
        activeNow += 1;
        maxObservedActive = Math.max(maxObservedActive, activeNow);
        await gate.promise;
        activeNow -= 1;
        return id;
      }),
    );

    await Promise.resolve();
    expect(sem.getStats()).toEqual({ maxConcurrency: 2, active: 2, queued: 3 });

    for (const gate of gates) {
      gate.release();
      await new Promise((r) => setTimeout(r, 5));
    }

    const results = await Promise.all(tasks);
    expect(maxObservedActive).toBe(2);
    expect(startOrder).toEqual([1, 2, 3, 4, 5]);
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(sem.getStats()).toEqual({ maxConcurrency: 2, active: 0, queued: 0 });
  });

  it('rejects queued waiters with 429 RATE_LIMITED when waitTimeoutMs is exceeded', async () => {
    const sem = new Semaphore({ maxConcurrency: 1, waitTimeoutMs: 30, name: 'tight-sem' });
    const releaseFirst = await sem.acquire({ engine: 'doubao' });

    await expect(sem.acquire({ engine: 'doubao' })).rejects.toMatchObject({
      statusCode: 429,
      code: 'RATE_LIMITED',
      retryable: true,
      engine: 'doubao',
    });

    expect(sem.getStats()).toEqual({ maxConcurrency: 1, active: 1, queued: 0 });
    releaseFirst();
    expect(sem.getStats()).toEqual({ maxConcurrency: 1, active: 0, queued: 0 });
  });

  it('releases permit on error and makes release() idempotent', async () => {
    const sem = new Semaphore({ maxConcurrency: 1 });

    await expect(
      sem.run(async () => {
        throw new Error('task failed');
      }),
    ).rejects.toThrow('task failed');
    expect(sem.getStats().active).toBe(0);

    const release = await sem.acquire();
    expect(sem.getStats().active).toBe(1);
    release();
    release();
    expect(sem.getStats().active).toBe(0);
  });

  it('rejects queued waiter with 408 UPSTREAM_TIMEOUT on AbortSignal without affecting other waiters', async () => {
    const sem = new Semaphore({ maxConcurrency: 1, waitTimeoutMs: 5_000 });
    const releaseFirst = await sem.acquire();

    const controller = new AbortController();
    const abortedWaiter = sem.acquire({ signal: controller.signal, engine: 'chatgpt' });
    const healthyWaiter = sem.acquire({ engine: 'chatgpt' });

    expect(sem.getStats().queued).toBe(2);
    controller.abort();

    await expect(abortedWaiter).rejects.toMatchObject({
      statusCode: 408,
      code: 'UPSTREAM_TIMEOUT',
      retryable: false,
    });
    expect(sem.getStats().queued).toBe(1);

    releaseFirst();
    const releaseHealthy = await healthyWaiter;
    expect(sem.getStats()).toEqual({ maxConcurrency: 1, active: 1, queued: 0 });
    releaseHealthy();
    expect(sem.getStats()).toEqual({ maxConcurrency: 1, active: 0, queued: 0 });
  });
});

describe('http-client', () => {
  const originalDispatcher = getGlobalDispatcher();

  afterEach(() => {
    setGlobalDispatcher(originalDispatcher);
  });

  it('parseRetryAfterMs parses numeric seconds, HTTP-dates, arrays, and rejects invalid values', () => {
    const now = Date.parse('2026-06-01T00:00:00.000Z');
    expect(parseRetryAfterMs('3', now)).toBe(3000);
    expect(parseRetryAfterMs(['2.5', '10'], now)).toBe(2500);
    expect(parseRetryAfterMs('Mon, 01 Jun 2026 00:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfterMs('Mon, 01 Jun 2025 00:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfterMs('not-a-date', now)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
  });

  it('sanitizeUrlForLog strips query parameters and credentials', () => {
    expect(sanitizeUrlForLog('https://user:secret@api.example.com/v1/chat?api_key=123')).toBe(
      'https://api.example.com/v1/chat',
    );
    expect(sanitizeUrlForLog('invalid')).toBe('[invalid-url]');
  });

  it('maps HTTP statuses via undici MockAgent (200 JSON, 401->503 with redacted error log, 429 with Retry-After, 502, oversized body)', async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);

    const pool = mockAgent.get('https://mock-upstream.test');
    const errorLogs: Array<Record<string, unknown>> = [];
    const client = new HttpClient({
      maxResponseBytes: 1024,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (obj) => {
          errorLogs.push(obj);
        },
      },
    });

    // 200 OK JSON
    pool.intercept({ path: '/ok', method: 'POST' }).reply(200, JSON.stringify({ hello: 'world' }), {
      headers: { 'content-type': 'application/json' },
    });

    const okRes = await client.postJson<{ hello: string }>(
      'https://mock-upstream.test/ok',
      { ping: true },
      { timeoutMs: 2000, engine: 'doubao' },
    );
    expect(okRes.statusCode).toBe(200);
    expect(okRes.data).toEqual({ hello: 'world' });

    // 401 -> 503 UPSTREAM_AUTH_OR_QUOTA (non-retryable) + sanitized error log
    pool
      .intercept({ path: '/auth-fail?secret=dont-log', method: 'POST' })
      .reply(401, JSON.stringify({ error: 'invalid_api_key' }));

    await expect(
      client.postJson(
        'https://mock-upstream.test/auth-fail?secret=dont-log',
        {},
        {
          timeoutMs: 2000,
          headers: { Authorization: 'Bearer super-secret-key' },
          engine: 'deepseek',
          provider: 'deepseek',
          requestId: 'req-401',
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'UPSTREAM_AUTH_OR_QUOTA',
      retryable: false,
      engine: 'deepseek',
    });

    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]?.['url']).toBe('https://mock-upstream.test/auth-fail');
    expect(JSON.stringify(errorLogs[0])).not.toContain('super-secret-key');
    expect(JSON.stringify(errorLogs[0])).not.toContain('dont-log');

    // 429 with Retry-After -> 429 RATE_LIMITED (retryable)
    pool.intercept({ path: '/rate-limit', method: 'GET' }).reply(429, 'slow down', {
      headers: { 'retry-after': '4' },
    });

    await expect(
      client.requestJson({
        url: 'https://mock-upstream.test/rate-limit',
        timeoutMs: 2000,
        engine: 'chatgpt',
      }),
    ).rejects.toMatchObject({
      statusCode: 429,
      code: 'RATE_LIMITED',
      retryable: true,
      retryAfterMs: 4000,
    });

    // Oversized body (> 1024 bytes) -> 502 UPSTREAM_BAD_RESPONSE
    pool
      .intercept({ path: '/huge', method: 'GET' })
      .reply(200, JSON.stringify({ payload: 'x'.repeat(2000) }));

    await expect(
      client.requestJson({
        url: 'https://mock-upstream.test/huge',
        timeoutMs: 2000,
        engine: 'tongyi',
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'UPSTREAM_BAD_RESPONSE',
      retryable: false,
    });

    await mockAgent.close();
  });
});

describe('config (loadConfig)', () => {
  it('loads all documented defaults with minimal GATEWAY_API_KEYS', () => {
    const cfg = loadConfig({ GATEWAY_API_KEYS: 'test-key-1' });
    expect(cfg.server.host).toBe('0.0.0.0');
    expect(cfg.server.port).toBe(8080);
    expect(cfg.server.nodeEnv).toBe('production');
    expect(cfg.auth.gatewayApiKeys).toEqual(['test-key-1']);
    expect(cfg.budget.gatewayRequestTimeoutMs).toBe(105_000);
    expect(cfg.budget.domesticTimeoutMs).toBe(45_000);
    expect(cfg.budget.overseasTimeoutMs).toBe(85_000);
    expect(cfg.budget.maxUpstreamRetries).toBe(2);
    expect(cfg.budget.semaphoreWaitMs).toBe(15_000);
    expect(cfg.budget.domesticConcurrencyPerEngine).toBe(5);
    expect(cfg.budget.dataforseoConcurrency).toBe(10);
    expect(cfg.cache.ttlSeconds).toBe(600);
    expect(cfg.cache.maxEntries).toBe(2000);
    expect(cfg.domestic.doubao.model).toBe('');
    expect(cfg.domestic.doubao.extraBody).toEqual({});
    expect(cfg.domestic.deepseek.searchParams).toEqual({ web_search: true });
    expect(cfg.overseas.dataforseo.geminiMode).toBe('scraper');
    expect(cfg.overseas.dataforseo.geminiModel).toBe('gemini-2.5-flash');
    expect('geminiEndpoint' in cfg.overseas.dataforseo).toBe(false);
  });

  it('supports multi-key rotation, deduplication, and GATEWAY_API_KEY single-key fallback', () => {
    const multi = loadConfig({ GATEWAY_API_KEYS: ' key1 , , key2 , key1 ' });
    expect(multi.auth.gatewayApiKeys).toEqual(['key1', 'key2']);

    const fallback = loadConfig({ GATEWAY_API_KEYS: '', GATEWAY_API_KEY: ' single-key ' });
    expect(fallback.auth.gatewayApiKeys).toEqual(['single-key']);

    expect(() => loadConfig({})).toThrow(/GATEWAY_API_KEYS/);
    expect(() => loadConfig({ GATEWAY_API_KEYS: ' , , ' })).toThrow(/GATEWAY_API_KEYS/);
  });

  it('validates numeric coercion, empty-string defaults, JSON objects, URLs, and Gemini options', () => {
    const custom = loadConfig({
      GATEWAY_API_KEYS: 'k',
      PORT: '',
      CACHE_TTL_SECONDS: '0',
      MAX_UPSTREAM_RETRIES: '0',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1///',
      DOUBAO_EXTRA_BODY_JSON: '{"thinking":{"type":"disabled"}}',
      DEEPSEEK_SEARCH_PARAMS_JSON: '',
      DATAFORSEO_GEMINI_MODE: 'responses',
      DATAFORSEO_GEMINI_ENDPOINT: '/v3/ai_optimization/gemini/llm_responses/live',
    });

    expect(custom.server.port).toBe(8080);
    expect(custom.cache.ttlSeconds).toBe(0);
    expect(custom.budget.maxUpstreamRetries).toBe(0);
    expect(custom.domestic.deepseek.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(custom.domestic.doubao.extraBody).toEqual({ thinking: { type: 'disabled' } });
    expect(custom.domestic.deepseek.searchParams).toEqual({ web_search: true });
    expect(custom.overseas.dataforseo.geminiMode).toBe('responses');
    expect(custom.overseas.dataforseo.geminiEndpoint).toBe(
      '/v3/ai_optimization/gemini/llm_responses/live',
    );

    expect(() => loadConfig({ GATEWAY_API_KEYS: 'k', PORT: '0' })).toThrow();
    expect(() => loadConfig({ GATEWAY_API_KEYS: 'k', PORT: '70000' })).toThrow();
    expect(() => loadConfig({ GATEWAY_API_KEYS: 'k', PORT: '8080.5' })).toThrow();
    expect(() => loadConfig({ GATEWAY_API_KEYS: 'k', PORT: 'abc' })).toThrow();
    expect(() => loadConfig({ GATEWAY_API_KEYS: 'k', CACHE_TTL_SECONDS: '-1' })).toThrow();
    expect(() => loadConfig({ GATEWAY_API_KEYS: 'k', DOUBAO_EXTRA_BODY_JSON: '{bad' })).toThrow();
    expect(() => loadConfig({ GATEWAY_API_KEYS: 'k', DOUBAO_EXTRA_BODY_JSON: '[1,2]' })).toThrow();
    expect(() => loadConfig({ GATEWAY_API_KEYS: 'k', DOUBAO_EXTRA_BODY_JSON: 'null' })).toThrow();
    expect(() => loadConfig({ GATEWAY_API_KEYS: 'k', DEEPSEEK_BASE_URL: 'not-a-url' })).toThrow();
    expect(() =>
      loadConfig({ GATEWAY_API_KEYS: 'k', DATAFORSEO_GEMINI_MODE: 'invalid' }),
    ).toThrow();
  });

  it('GatewayError.toErrorEnvelope formats error envelope cleanly with optional engine', () => {
    const errWithEngine = new GatewayError(400, 'UNSUPPORTED_ENGINE', 'Unsupported', {
      engine: 'yuanbao',
    });
    expect(errWithEngine.toErrorEnvelope('req-1')).toEqual({
      error: {
        code: 'UNSUPPORTED_ENGINE',
        message: 'Unsupported',
        retryable: false,
        engine: 'yuanbao',
        requestId: 'req-1',
      },
    });

    const errNoEngine = unauthorizedError();
    const env = errNoEngine.toErrorEnvelope('req-2');
    expect('engine' in env.error).toBe(false);
    expect(env.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects non-HTTP(S) schemes in urlEnv() (ftp://, file://)', () => {
    expect(() =>
      loadConfig({ GATEWAY_API_KEYS: 'k', DEEPSEEK_BASE_URL: 'ftp://api.deepseek.com' }),
    ).toThrow(/http:\/\/ or https:\/\//i);
    expect(() =>
      loadConfig({ GATEWAY_API_KEYS: 'k', DATAFORSEO_BASE_URL: 'file:///etc/passwd' }),
    ).toThrow(/http:\/\/ or https:\/\//i);
  });
});

describe('http-client hardening regressions', () => {
  it('parseRetryAfterMs rejects negative numbers and non-RFC-9110 garbage strings', () => {
    const now = Date.UTC(2026, 10, 19, 12, 0, 0);
    expect(parseRetryAfterMs('-5', now)).toBeUndefined();
    expect(parseRetryAfterMs('-1', now)).toBeUndefined();
    expect(parseRetryAfterMs('-100', now)).toBeUndefined();
    expect(parseRetryAfterMs('invalid 1', now)).toBeUndefined();
    expect(parseRetryAfterMs('2026-11-19T12:00:05Z', now)).toBeUndefined();

    // Valid RFC 9110 IMF-fixdate and delay-seconds remain supported
    expect(parseRetryAfterMs('5', now)).toBe(5000);
    expect(parseRetryAfterMs('Thu, 19 Nov 2026 12:00:05 GMT', now)).toBe(5000);
  });

  it('withRetry falls back to exponential backoff when Retry-After is negative/garbage', async () => {
    const delays: number[] = [];
    const nowMs = 1_000_000;
    const retryAfterMs = parseRetryAfterMs('-5', nowMs);
    expect(retryAfterMs).toBeUndefined();

    const result = await withRetry(
      async (attempt) => {
        if (attempt === 1) {
          throw rateLimitedError('429', { retryAfterMs });
        }
        return 'ok';
      },
      {
        maxRetries: 2,
        baseDelayMs: 1000,
        deadlineMs: nowMs + 60_000,
        now: () => nowMs,
        random: () => 0.5,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(result).toEqual({ value: 'ok', attempts: 2 });
    expect(delays).toEqual([1250]);
  });

  it('requestJson throws GatewayError(408, UPSTREAM_TIMEOUT) when timeoutMs <= 0 or NaN', async () => {
    const client = new HttpClient();
    for (const badTimeout of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        client.requestJson({
          url: 'https://mock-upstream.test/never-called',
          timeoutMs: badTimeout,
          engine: 'deepseek',
        }),
      ).rejects.toMatchObject({
        statusCode: 408,
        code: 'UPSTREAM_TIMEOUT',
        engine: 'deepseek',
      });
    }
  });

  it('requestJson fails fast on 2xx response with Content-Length exceeding maxResponseBytes', async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    const pool = mockAgent.get('https://mock-cl.test');
    pool
      .intercept({ path: '/oversized-cl', method: 'GET' })
      .reply(200, JSON.stringify({ ok: true }), {
        headers: {
          'content-type': 'application/json',
          'content-length': '50000000',
        },
      });

    const client = new HttpClient({ maxResponseBytes: 1024, dispatcher: mockAgent });
    await expect(
      client.requestJson({
        url: 'https://mock-cl.test/oversized-cl',
        timeoutMs: 2000,
        engine: 'tongyi',
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'UPSTREAM_BAD_RESPONSE',
      retryable: false,
      engine: 'tongyi',
    });

    await mockAgent.close();
  });
});
