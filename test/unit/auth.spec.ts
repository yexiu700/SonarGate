import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type SonarGateApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { verifyBearerToken } from '../../src/middleware/auth.js';

const KEY_PRIMARY = 'primary-gateway-secret-key-0001';
const KEY_SECONDARY = 'secondary-gateway-secret-key-0002';

function makeEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    GATEWAY_API_KEYS: `${KEY_PRIMARY},${KEY_SECONDARY}`,
    DEEPSEEK_API_KEY: 'sk-deepseek-super-secret-value',
    DATAFORSEO_LOGIN: 'dfs-secret-login',
    DATAFORSEO_PASSWORD: 'dfs-secret-password',
    ...overrides,
  };
}

describe('verifyBearerToken (unit)', () => {
  it('accepts valid keys in multi-key rotation list', () => {
    expect(verifyBearerToken(`Bearer ${KEY_PRIMARY}`, [KEY_PRIMARY, KEY_SECONDARY])).toBe(true);
    expect(verifyBearerToken(`Bearer ${KEY_SECONDARY}`, [KEY_PRIMARY, KEY_SECONDARY])).toBe(true);
  });

  it('rejects missing, non-string, malformed scheme, and empty tokens', () => {
    expect(verifyBearerToken(undefined, [KEY_PRIMARY])).toBe(false);
    expect(verifyBearerToken(['Bearer ' + KEY_PRIMARY], [KEY_PRIMARY])).toBe(false);
    expect(verifyBearerToken('', [KEY_PRIMARY])).toBe(false);
    expect(verifyBearerToken('Bearer', [KEY_PRIMARY])).toBe(false);
    expect(verifyBearerToken('Bearer   ', [KEY_PRIMARY])).toBe(false);
    expect(verifyBearerToken(`Basic ${KEY_PRIMARY}`, [KEY_PRIMARY])).toBe(false);
    expect(verifyBearerToken(`Token ${KEY_PRIMARY}`, [KEY_PRIMARY])).toBe(false);
    expect(verifyBearerToken(KEY_PRIMARY, [KEY_PRIMARY])).toBe(false);
    expect(verifyBearerToken(`Bearer ${KEY_PRIMARY} extra`, [KEY_PRIMARY])).toBe(false);
  });

  it('rejects wrong tokens of both same length and different length without throwing RangeError', () => {
    const sameLengthWrong = 'primary-gateway-secret-key-9999';
    expect(sameLengthWrong.length).toBe(KEY_PRIMARY.length);
    expect(verifyBearerToken(`Bearer ${sameLengthWrong}`, [KEY_PRIMARY])).toBe(false);
    expect(verifyBearerToken('Bearer short', [KEY_PRIMARY])).toBe(false);
    expect(verifyBearerToken(`Bearer ${'x'.repeat(256)}`, [KEY_PRIMARY])).toBe(false);
  });

  it('rejects when validKeys list is empty', () => {
    expect(verifyBearerToken(`Bearer ${KEY_PRIMARY}`, [])).toBe(false);
  });

  it('handles multi-byte UTF-8 keys/tokens of identical char length safely and rejects CRLF injection', () => {
    const utf8Key = '密钥-🚀-alpha-1234';
    const sameCharLenAscii = 'a'.repeat(utf8Key.length);
    expect(sameCharLenAscii.length).toBe(utf8Key.length);
    expect(Buffer.byteLength(utf8Key, 'utf8')).not.toBe(
      Buffer.byteLength(sameCharLenAscii, 'utf8'),
    );

    expect(verifyBearerToken(`Bearer ${utf8Key}`, [utf8Key])).toBe(true);
    expect(verifyBearerToken(`Bearer ${sameCharLenAscii}`, [utf8Key])).toBe(false);
    expect(verifyBearerToken(`Bearer ${utf8Key}`, [sameCharLenAscii])).toBe(false);

    // Reject CRLF injection attempts
    expect(verifyBearerToken(`Bearer ${KEY_PRIMARY}\r\nX-Injected: true`, [KEY_PRIMARY])).toBe(
      false,
    );
    expect(verifyBearerToken(`Bearer ${KEY_PRIMARY}\r\n${KEY_PRIMARY}`, [KEY_PRIMARY])).toBe(false);
    expect(verifyBearerToken(`Bearer \r\n${KEY_PRIMARY}`, [KEY_PRIMARY])).toBe(false);
  });
});

describe('Auth middleware HTTP enforcement', () => {
  const apps: SonarGateApp[] = [];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app !== undefined) {
        await app.close();
      }
    }
  });

  it('allows unauthenticated access to /health and /ready', async () => {
    const config = loadConfig(makeEnv());
    const app = buildApp({ config, logger: false });
    apps.push(app);

    const healthRes = await app.inject({ method: 'GET', url: '/health' });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json()).toMatchObject({
      status: 'ok',
      service: 'sonargate',
      version: '1.0.0',
    });

    const readyRes = await app.inject({ method: 'GET', url: '/ready' });
    expect(readyRes.statusCode).toBe(200);
    expect(readyRes.json()).toMatchObject({
      ready: true,
      configuredCount: 6,
      totalSupported: 12,
      aliases: { qwen: 'tongyi' },
    });
    expect((readyRes.json() as { engines: unknown[] }).engines).toHaveLength(12);
  });

  it('returns 401 UNAUTHORIZED on /v1/collect and /v1/engines when token is missing or invalid', async () => {
    const config = loadConfig(makeEnv());
    const app = buildApp({ config, logger: false });
    apps.push(app);

    for (const headers of [
      {},
      { authorization: 'Basic dXNlcjpwYXNz' },
      { authorization: 'Bearer ' },
      { authorization: 'Bearer wrong-token' },
      { authorization: 'Bearer primary-gateway-secret-key-9999' },
    ]) {
      const enginesRes = await app.inject({
        method: 'GET',
        url: '/v1/engines',
        headers,
      });
      expect(enginesRes.statusCode).toBe(401);
      expect(enginesRes.json()).toMatchObject({
        error: {
          code: 'UNAUTHORIZED',
          retryable: false,
        },
      });
      expect(enginesRes.headers['x-request-id']).toBeTruthy();

      const collectRes = await app.inject({
        method: 'POST',
        url: '/v1/collect',
        headers: {
          'content-type': 'application/json',
          ...headers,
        },
        payload: { engine: 'deepseek', prompt: 'test' },
      });
      expect(collectRes.statusCode).toBe(401);
      expect(collectRes.json()).toMatchObject({
        error: {
          code: 'UNAUTHORIZED',
          retryable: false,
        },
      });
    }
  });

  it('allows both keys during multi-key rotation and leaks zero secrets in /v1/engines', async () => {
    const config = loadConfig(makeEnv());
    const app = buildApp({ config, logger: false });
    apps.push(app);

    for (const key of [KEY_PRIMARY, KEY_SECONDARY]) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/engines',
        headers: {
          authorization: `Bearer ${key}`,
        },
      });
      expect(res.statusCode).toBe(200);
      const rawBody = res.body;
      expect(rawBody).not.toContain(KEY_PRIMARY);
      expect(rawBody).not.toContain(KEY_SECONDARY);
      expect(rawBody).not.toContain('sk-deepseek-super-secret-value');
      expect(rawBody).not.toContain('dfs-secret-login');
      expect(rawBody).not.toContain('dfs-secret-password');

      const parsed = res.json() as {
        engines: Array<{ engine: string; configured: boolean }>;
        configuredCount: number;
        totalSupported: number;
      };
      expect(parsed.totalSupported).toBe(12);
      expect(parsed.configuredCount).toBe(6);
      expect(parsed.engines).toHaveLength(12);
    }
  });

  it('supports single-key GATEWAY_API_KEY fallback when GATEWAY_API_KEYS is unset', async () => {
    const singleKey = 'single-fallback-gateway-key-0001';
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      GATEWAY_API_KEY: singleKey,
      DEEPSEEK_API_KEY: 'sk-ds-test',
    });
    const app = buildApp({ config, logger: false });
    apps.push(app);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/engines',
      headers: {
        authorization: `Bearer ${singleKey}`,
      },
    });
    expect(res.statusCode).toBe(200);
  });
});
