import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type SonarGateApp } from '../../../src/app.js';
import { loadConfig } from '../../../src/config.js';
import { HttpClient } from '../../../src/core/http-client.js';
import { MAX_RESPONSE_BYTES, normalizeResponse } from '../../../src/core/normalizer.js';
import { verifyBearerToken } from '../../../src/middleware/auth.js';
import { createE2EHarness, DEFAULT_E2E_ENV, type E2EHarness } from '../helpers/e2e-harness.js';
import { remoteScraperResponseSchema } from '../helpers/geomix-schema.js';

interface LocalServerHandle {
  server: Server;
  baseUrl: string;
  close(): Promise<void>;
}

async function startLocalHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<LocalServerHandle> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Failed to bind local test HTTP server to an ephemeral port.');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
  };
}

describe('Tier 5: Adversarial Security, Resilience & Normalization Hardening (E2E)', () => {
  const harnesses: E2EHarness[] = [];
  const apps: SonarGateApp[] = [];
  const servers: LocalServerHandle[] = [];

  afterEach(async () => {
    while (harnesses.length > 0) {
      const h = harnesses.pop();
      if (h !== undefined) {
        await h.close();
      }
    }
    while (apps.length > 0) {
      const app = apps.pop();
      if (app !== undefined) {
        await app.close();
      }
    }
    while (servers.length > 0) {
      const srv = servers.pop();
      if (srv !== undefined) {
        await srv.close();
      }
    }
  });

  it('redacts gateway keys, domestic API keys, and DataForSEO credentials from live Pino JSON log streams across 401/403/500/network-error paths', async () => {
    const gatewayKey = 'tier5-gateway-secret-token-9999';
    const deepseekKey = 'sk-tier5-deepseek-secret-8888';
    const dfsLogin = 'tier5-dfs-secret-login';
    const dfsPassword = 'tier5-dfs-secret-password';
    const dfsBasicAuth = Buffer.from(`${dfsLogin}:${dfsPassword}`, 'utf8').toString('base64');

    const localServer = await startLocalHttpServer((req, res) => {
      if (req.url === '/deepseek/chat/completions') {
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'invalid api key' }));
        return;
      }
      if (req.url === '/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced') {
        res.statusCode = 403;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }
      if (req.url === '/tongyi/chat/completions') {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'internal server error' }));
        return;
      }
      if (req.url === '/zhipu/chat/completions') {
        // Abruptly destroy socket to trigger network error path
        req.socket.destroy();
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    servers.push(localServer);

    const logChunks: string[] = [];
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logChunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        callback();
      },
    });

    const config = loadConfig({
      ...DEFAULT_E2E_ENV,
      LOG_LEVEL: 'info',
      GATEWAY_API_KEYS: gatewayKey,
      MAX_UPSTREAM_RETRIES: '0',
      DEEPSEEK_API_KEY: deepseekKey,
      DEEPSEEK_BASE_URL: `${localServer.baseUrl}/deepseek`,
      TONGYI_API_KEY: 'sk-tier5-tongyi-secret-7777',
      TONGYI_BASE_URL: `${localServer.baseUrl}/tongyi`,
      ZHIPU_API_KEY: 'sk-tier5-zhipu-secret-6666',
      ZHIPU_BASE_URL: `${localServer.baseUrl}/zhipu`,
      DATAFORSEO_LOGIN: dfsLogin,
      DATAFORSEO_PASSWORD: dfsPassword,
      DATAFORSEO_BASE_URL: localServer.baseUrl,
    });

    const app = buildApp({
      config,
      logger: {
        level: 'info',
        stream: logStream,
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
      },
    });
    apps.push(app);

    // 1. Upstream 401 on domestic deepseek -> 503 UPSTREAM_AUTH_OR_QUOTA
    const res401 = await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: {
        authorization: `Bearer ${gatewayKey}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ engine: 'deepseek', prompt: 'log redaction 401' }),
    });
    expect(res401.statusCode).toBe(503);

    // 2. Upstream 403 on overseas chatgpt -> 503 UPSTREAM_AUTH_OR_QUOTA
    const res403 = await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: {
        authorization: `Bearer ${gatewayKey}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ engine: 'chatgpt', prompt: 'log redaction 403' }),
    });
    expect(res403.statusCode).toBe(503);

    // 3. Upstream 500 on tongyi -> 502 UPSTREAM_BAD_RESPONSE
    const res500 = await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: {
        authorization: `Bearer ${gatewayKey}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ engine: 'tongyi', prompt: 'log redaction 500' }),
    });
    expect(res500.statusCode).toBe(502);

    // 4. Upstream network reset on zhipu -> 502 UPSTREAM_BAD_RESPONSE
    const resNet = await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: {
        authorization: `Bearer ${gatewayKey}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ engine: 'zhipu', prompt: 'log redaction net' }),
    });
    expect(resNet.statusCode).toBe(502);

    const allLogs = logChunks.join('');
    expect(allLogs.length).toBeGreaterThan(0);

    // Every emitted log line must be valid JSON and contain zero raw secrets
    const lines = allLogs.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    expect(allLogs).not.toContain(gatewayKey);
    expect(allLogs).not.toContain(deepseekKey);
    expect(allLogs).not.toContain('sk-tier5-tongyi-secret-7777');
    expect(allLogs).not.toContain('sk-tier5-zhipu-secret-6666');
    expect(allLogs).not.toContain(dfsLogin);
    expect(allLogs).not.toContain(dfsPassword);
    expect(allLogs).not.toContain(dfsBasicAuth);
  });

  it('refuses 301/302/307/308 upstream redirects with 502 UPSTREAM_BAD_RESPONSE without hitting redirect target or leaking Authorization', async () => {
    let redirectStatus = 301;
    let redirectTargetHit = false;
    let stolenAuthHeader: string | undefined;

    const localServer = await startLocalHttpServer((req, res) => {
      if (req.url === '/stolen-target') {
        redirectTargetHit = true;
        stolenAuthHeader = req.headers['authorization'];
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ stolen: true }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        res.statusCode = redirectStatus;
        res.setHeader('location', `${localServer.baseUrl}/stolen-target`);
        res.end('redirecting');
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    servers.push(localServer);

    const config = loadConfig({
      ...DEFAULT_E2E_ENV,
      MAX_UPSTREAM_RETRIES: '0',
      DEEPSEEK_API_KEY: 'sk-do-not-leak-on-redirect',
      DEEPSEEK_BASE_URL: `${localServer.baseUrl}/v1`,
    });
    const app = buildApp({ config, logger: false });
    apps.push(app);

    for (const status of [301, 302, 307, 308]) {
      redirectStatus = status;
      const res = await app.inject({
        method: 'POST',
        url: '/v1/collect',
        headers: {
          authorization: `Bearer ${config.auth.gatewayApiKeys[0]}`,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ engine: 'deepseek', prompt: `redirect-${status}` }),
      });

      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({
        error: {
          code: 'UPSTREAM_BAD_RESPONSE',
          retryable: false,
          engine: 'deepseek',
        },
      });
    }

    expect(redirectTargetHit).toBe(false);
    expect(stolenAuthHeader).toBeUndefined();
  });

  it('aborts streaming chunked oversize responses and fails fast on oversized Content-Length headers', async () => {
    let chunksWritten = 0;

    const localServer = await startLocalHttpServer((req, res) => {
      if (req.url === '/chunked-oversize') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        const chunk = Buffer.alloc(1024, 'a');
        let sent = 0;
        const interval = setInterval(() => {
          if (res.destroyed || sent >= 50) {
            clearInterval(interval);
            if (!res.destroyed) {
              res.end();
            }
            return;
          }
          sent += 1;
          chunksWritten += 1;
          res.write(chunk);
        }, 5);
        req.on('close', () => {
          clearInterval(interval);
        });
        return;
      }

      if (req.url === '/content-length-oversize') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.setHeader('content-length', '50000000');
        // Write only a small prefix and keep socket open; client must fail fast from Content-Length
        res.write('{"partial":');
        return;
      }

      res.statusCode = 404;
      res.end();
    });
    servers.push(localServer);

    const client = new HttpClient({ maxResponseBytes: 4096 });

    // 1. Streaming chunked oversize abort
    await expect(
      client.requestJson({
        url: `${localServer.baseUrl}/chunked-oversize`,
        timeoutMs: 5000,
        engine: 'deepseek',
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'UPSTREAM_BAD_RESPONSE',
      retryable: false,
      engine: 'deepseek',
    });
    expect(chunksWritten).toBeLessThan(20);

    // 2. Content-Length fail-fast abort (completes immediately without waiting for timeoutMs)
    const startMs = Date.now();
    await expect(
      client.requestJson({
        url: `${localServer.baseUrl}/content-length-oversize`,
        timeoutMs: 5000,
        engine: 'tongyi',
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'UPSTREAM_BAD_RESPONSE',
      retryable: false,
      engine: 'tongyi',
    });
    expect(Date.now() - startMs).toBeLessThan(1500);
  });

  it('enforces the 1_900_000-byte guard for oversized upstreamRequestId and preserves answerText ahead of oversized non-core rawMeta', async () => {
    const harness = createE2EHarness();
    harnesses.push(harness);

    // 1. End-to-end oversized upstreamRequestId (2 MB) via POST /v1/collect
    harness.upstreams.mockEngineSuccess('deepseek', {
      id: 'x'.repeat(2_000_000),
      model: 'deepseek-chat',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Valid answer despite giant upstream request ID.',
          },
        },
      ],
    });

    const res = await harness.collect({
      engine: 'deepseek',
      prompt: 'oversized upstream id test',
    });
    expect(res.statusCode).toBe(200);
    expect(Buffer.byteLength(res.body, 'utf8')).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);

    const parsed = remoteScraperResponseSchema.parse(res.json());
    expect(parsed.answerText).toBe('Valid answer despite giant upstream request ID.');
    expect((parsed.rawMeta?.['upstreamRequestId'] as string).length).toBeLessThanOrEqual(256);

    // 2. Oversized non-core rawMeta (1.8995 MB) + 10 KB answerText strips non-core rawMeta and preserves full answerText
    const fullAnswer = 'A'.repeat(10_000);
    const normalized = normalizeResponse({
      prompt: 'non-core rawMeta preservation',
      meta: {
        engine: 'deepseek',
        region: 'domestic',
        requestId: 'tier5-byte-guard',
        latencyMs: 50,
        attempts: 1,
        cached: false,
      },
      result: {
        answerText: fullAnswer,
        citations: [],
        fanOutQueries: [],
        rawMeta: {
          provider: 'deepseek',
          hugeDebugBlob: 'd'.repeat(1_899_500),
        },
      },
    });

    expect(Buffer.byteLength(JSON.stringify(normalized), 'utf8')).toBeLessThanOrEqual(
      MAX_RESPONSE_BYTES,
    );
    expect(normalized.rawMeta.truncatedForByteLimit).toBe(true);
    expect('hugeDebugBlob' in normalized.rawMeta).toBe(false);
    expect(normalized.answerText).toBe(fullAnswer);
    expect(remoteScraperResponseSchema.safeParse(normalized).success).toBe(true);
  });

  it('extracts curly-quoted and uppercase HTTPS:// URLs and falls back to text extraction when all adapter citations are invalid', async () => {
    const harness = createE2EHarness();
    harnesses.push(harness);

    harness.upstreams.mockEngineSuccess('deepseek', {
      id: 'chatcmpl-tier5-urls',
      model: 'deepseek-chat',
      choices: [
        {
          message: {
            role: 'assistant',
            content:
              '详见“https://example.com/page”和‘https://example.com/other’以及HTTPS://EXAMPLE.COM/UPPER。',
          },
        },
      ],
      citations: ['javascript:alert(1)', 'data:text/html,evil'],
    });

    const res = await harness.collect({
      engine: 'deepseek',
      prompt: 'curly quotes and uppercase scheme extraction',
    });
    expect(res.statusCode).toBe(200);

    const parsed = remoteScraperResponseSchema.parse(res.json());
    expect(parsed.rawMeta?.['citationsExtractedFromText']).toBe(true);
    expect(parsed.citations.map((c) => c.url)).toEqual([
      'https://example.com/page',
      'https://example.com/other',
      'https://example.com/UPPER',
    ]);
  });

  it('falls back to exponential backoff (not 0ms) when upstream returns Retry-After: -5 or garbage header', async () => {
    for (const badHeader of ['-5', 'invalid 1']) {
      const harness = createE2EHarness({
        RETRY_BASE_DELAY_MS: '150',
        MAX_UPSTREAM_RETRIES: '1',
      });
      harnesses.push(harness);

      harness.upstreams.mockEngineReply(
        'deepseek',
        429,
        { error: 'rate limited' },
        {
          headers: {
            'retry-after': badHeader,
          },
        },
      );
      harness.upstreams.mockEngineSuccess('deepseek', {
        id: 'chatcmpl-tier5-retry-ok',
        model: 'deepseek-chat',
        choices: [{ message: { role: 'assistant', content: 'Recovered after backoff.' } }],
      });

      const startMs = Date.now();
      const res = await harness.collect({
        engine: 'deepseek',
        prompt: `retry-after-backoff-${badHeader}`,
      });
      const elapsedMs = Date.now() - startMs;

      expect(res.statusCode).toBe(200);
      expect(elapsedMs).toBeGreaterThanOrEqual(140);
      const parsed = remoteScraperResponseSchema.parse(res.json());
      expect(parsed.rawMeta?.['attempts']).toBe(2);
    }
  });

  it('handles multi-byte UTF-8 gateway keys safely and rejects CRLF injection in Authorization headers', async () => {
    const utf8Key = '密钥-🚀-sonargate-2026';
    const sameCharLenAscii = 'a'.repeat(utf8Key.length);
    expect(sameCharLenAscii.length).toBe(utf8Key.length);
    expect(Buffer.byteLength(utf8Key, 'utf8')).not.toBe(
      Buffer.byteLength(sameCharLenAscii, 'utf8'),
    );

    const config = loadConfig({
      ...DEFAULT_E2E_ENV,
      GATEWAY_API_KEYS: utf8Key,
    });
    const app = buildApp({ config, logger: false });
    apps.push(app);

    const okRes = await app.inject({
      method: 'GET',
      url: '/v1/engines',
      headers: { authorization: `Bearer ${utf8Key}` },
    });
    expect(okRes.statusCode).toBe(200);

    const wrongAsciiRes = await app.inject({
      method: 'GET',
      url: '/v1/engines',
      headers: { authorization: `Bearer ${sameCharLenAscii}` },
    });
    expect(wrongAsciiRes.statusCode).toBe(401);

    // Direct CRLF injection check on auth verifier
    expect(verifyBearerToken(`Bearer ${utf8Key}\r\nX-Injected: 1`, [utf8Key])).toBe(false);
    expect(verifyBearerToken(`Bearer \r\n${utf8Key}`, [utf8Key])).toBe(false);
  });

  it('rejects non-HTTP(S) schemes (ftp://, file://) in loadConfig()', () => {
    expect(() =>
      loadConfig({
        ...DEFAULT_E2E_ENV,
        DEEPSEEK_BASE_URL: 'ftp://api.deepseek.com',
      }),
    ).toThrow(/http:\/\/ or https:\/\//i);

    expect(() =>
      loadConfig({
        ...DEFAULT_E2E_ENV,
        DATAFORSEO_BASE_URL: 'file:///etc/passwd',
      }),
    ).toThrow(/http:\/\/ or https:\/\//i);
  });
});
