import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAgent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type SonarGateApp } from '../../src/app.js';
import { getConfigWarnings, loadConfig } from '../../src/config.js';
import { collectResponseSchema, errorEnvelopeSchema } from '../../src/core/contract.js';
import {
  HttpClient,
  collectSecretHeaderValues,
  sanitizeErrorBodySnippet,
} from '../../src/core/http-client.js';
import type { EngineRegistry } from '../../src/core/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_KEY = 'hardening-test-gateway-key-0001';
const BASE_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  GATEWAY_API_KEYS: API_KEY,
} as const;

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(__dirname, '../fixtures', name), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('unhandled errors', () => {
  let app: SonarGateApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('maps non-GatewayError exceptions to 500 INTERNAL_ERROR instead of an upstream error', async () => {
    const brokenRegistry = {
      resolve: () => {
        throw new TypeError('simulated gateway bug');
      },
    } as unknown as EngineRegistry;

    app = buildApp({ config: loadConfig(BASE_ENV), registry: brokenRegistry, logger: false });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: { authorization: `Bearer ${API_KEY}`, 'x-request-id': 'req-internal-1' },
      payload: { engine: 'deepseek', prompt: 'hello' },
    });

    expect(res.statusCode).toBe(500);
    const envelope = errorEnvelopeSchema.parse(res.json());
    expect(envelope.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Internal gateway error',
      retryable: false,
      requestId: 'req-internal-1',
    });
    expect(res.body).not.toContain('simulated gateway bug');
  });
});

describe('budget configuration', () => {
  it('exposes new defaults for retry budget and shutdown grace', () => {
    const cfg = loadConfig(BASE_ENV);
    expect(cfg.budget.retryMinRemainingBudgetMs).toBe(12_000);
    expect(cfg.server.shutdownGraceMs).toBe(5_000);
    expect(getConfigWarnings(cfg)).toEqual([]);
  });

  it('accepts overrides and rejects out-of-range values', () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      RETRY_MIN_REMAINING_BUDGET_MS: '0',
      SHUTDOWN_GRACE_MS: '0',
    });
    expect(cfg.budget.retryMinRemainingBudgetMs).toBe(0);
    expect(cfg.server.shutdownGraceMs).toBe(0);

    expect(() => loadConfig({ ...BASE_ENV, RETRY_MIN_REMAINING_BUDGET_MS: '-1' })).toThrow(
      /RETRY_MIN_REMAINING_BUDGET_MS/,
    );
    expect(() => loadConfig({ ...BASE_ENV, SHUTDOWN_GRACE_MS: '60001' })).toThrow(
      /SHUTDOWN_GRACE_MS/,
    );
  });

  it('warns when per-attempt timeouts exceed the gateway deadline', () => {
    const warnings = getConfigWarnings(
      loadConfig({ ...BASE_ENV, GATEWAY_REQUEST_TIMEOUT_MS: '50000', MAX_UPSTREAM_RETRIES: '0' }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('OVERSEAS_TIMEOUT_MS (85000)');
  });

  it('warns when the retry budget makes MAX_UPSTREAM_RETRIES ineffective', () => {
    const warnings = getConfigWarnings(
      loadConfig({
        ...BASE_ENV,
        GATEWAY_REQUEST_TIMEOUT_MS: '10000',
        DOMESTIC_TIMEOUT_MS: '5000',
        OVERSEAS_TIMEOUT_MS: '5000',
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('MAX_UPSTREAM_RETRIES=2 has no effect');

    const fixed = getConfigWarnings(
      loadConfig({
        ...BASE_ENV,
        GATEWAY_REQUEST_TIMEOUT_MS: '10000',
        DOMESTIC_TIMEOUT_MS: '5000',
        OVERSEAS_TIMEOUT_MS: '5000',
        RETRY_MIN_REMAINING_BUDGET_MS: '2000',
      }),
    );
    expect(fixed).toEqual([]);
  });

  it('CollectService honors RETRY_MIN_REMAINING_BUDGET_MS so short deadlines can still retry', async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    const pool = mockAgent.get('https://api.deepseek.com');
    pool
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(503, { error: 'transient' });
    pool
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, loadFixture('deepseek.json'));

    const config = loadConfig({
      ...BASE_ENV,
      DEEPSEEK_API_KEY: 'sk-deepseek-test',
      GATEWAY_REQUEST_TIMEOUT_MS: '5000',
      DOMESTIC_TIMEOUT_MS: '2000',
      MAX_UPSTREAM_RETRIES: '1',
      RETRY_BASE_DELAY_MS: '50',
      RETRY_MIN_REMAINING_BUDGET_MS: '0',
    });
    const app = buildApp({
      config,
      httpClient: new HttpClient({ dispatcher: mockAgent }),
      logger: false,
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/collect',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { engine: 'deepseek', prompt: 'retry budget prompt' },
      });
      expect(res.statusCode).toBe(200);
      const body = collectResponseSchema.parse(res.json());
      expect(body.rawMeta.attempts).toBe(2);
    } finally {
      await app.close();
      await mockAgent.close();
    }
  });
});

describe('upstream error body logging', () => {
  it('collectSecretHeaderValues extracts credentials with and without scheme prefix', () => {
    const secrets = collectSecretHeaderValues({
      Authorization: 'Bearer sk-live-abcdef123456',
      'x-api-key': 'goog-key-987654',
      'content-type': 'application/json',
    });
    expect(secrets).toEqual(
      expect.arrayContaining([
        'Bearer sk-live-abcdef123456',
        'sk-live-abcdef123456',
        'goog-key-987654',
      ]),
    );
    expect(secrets).not.toContain('application/json');
  });

  it('sanitizeErrorBodySnippet redacts secrets, strips control chars and caps length', () => {
    const body = Buffer.from(
      '{"error":"Incorrect API key provided: my-own-secret-key.\u0000\nSee Bearer abc.def.ghi and sk-proj-ABCDEFGH12345"}',
    );
    const snippet = sanitizeErrorBodySnippet(body, ['my-own-secret-key']);
    expect(snippet).not.toContain('my-own-secret-key');
    expect(snippet).not.toContain('abc.def.ghi');
    expect(snippet).not.toContain('sk-proj-ABCDEFGH12345');
    expect([...snippet].some((ch) => ch.charCodeAt(0) < 0x20)).toBe(false);
    expect(snippet).toContain('Incorrect API key provided');

    const long = sanitizeErrorBodySnippet(Buffer.from('x'.repeat(5000)));
    expect(long.length).toBe(513);
    expect(long.endsWith('…')).toBe(true);
  });

  it('logs non-retryable 4xx at warn and retryable 5xx at debug with a redacted body', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    const pool = mockAgent.get('https://upstream.test');
    pool
      .intercept({ path: '/v1/chat?token=leak', method: 'POST' })
      .reply(400, { error: { message: 'model not found; key sk-upstream-secret-1 rejected' } });
    pool
      .intercept({ path: '/v1/chat?token=leak', method: 'POST' })
      .reply(503, 'service unavailable');

    const client = new HttpClient({ logger, dispatcher: mockAgent });
    const call = () =>
      client.postJson(
        'https://upstream.test/v1/chat?token=leak',
        { a: 1 },
        {
          timeoutMs: 1000,
          headers: { authorization: 'Bearer sk-upstream-secret-1' },
          engine: 'deepseek',
          provider: 'deepseek',
          requestId: 'req-log-1',
        },
      );

    await expect(call()).rejects.toMatchObject({ code: 'UPSTREAM_BAD_RESPONSE', retryable: false });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [warnFields, warnMsg] = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(warnMsg).toBe('Upstream rejected request');
    expect(warnFields).toMatchObject({
      engine: 'deepseek',
      statusCode: 400,
      requestId: 'req-log-1',
      url: 'https://upstream.test/v1/chat',
    });
    expect(String(warnFields['upstreamBody'])).toContain('model not found');
    expect(String(warnFields['upstreamBody'])).not.toContain('sk-upstream-secret-1');

    await expect(call()).rejects.toMatchObject({ code: 'UPSTREAM_BAD_RESPONSE', retryable: true });
    expect(logger.debug).toHaveBeenCalledTimes(1);
    const [debugFields] = logger.debug.mock.calls[0] as [Record<string, unknown>, string];
    expect(debugFields).toMatchObject({ statusCode: 503, upstreamBody: 'service unavailable' });
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await mockAgent.close();
  });
});
