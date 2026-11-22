import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DoubaoAdapter } from '../../src/adapters/domestic/doubao.adapter.js';
import { loadConfig } from '../../src/config.js';
import { GatewayError } from '../../src/core/errors.js';
import { HttpClient } from '../../src/core/http-client.js';
import { EngineRegistry } from '../../src/core/registry.js';
import type { CollectContext, LoggerLike } from '../../src/core/types.js';

interface TestServerHandle {
  url: string;
  close: () => Promise<void>;
}

async function startHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<TestServerHandle> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

function makeLogger(): {
  logger: LoggerLike;
  infoSpy: ReturnType<typeof vi.fn>;
  warnSpy: ReturnType<typeof vi.fn>;
  errorSpy: ReturnType<typeof vi.fn>;
} {
  const infoSpy = vi.fn();
  const warnSpy = vi.fn();
  const errorSpy = vi.fn();
  return {
    logger: {
      debug: vi.fn(),
      info: infoSpy,
      warn: warnSpy,
      error: errorSpy,
    },
    infoSpy,
    warnSpy,
    errorSpy,
  };
}

function makeCtx(overrides: Partial<CollectContext> = {}): CollectContext {
  return {
    prompt: 'SECRET_PROMPT_SHOULD_NOT_BE_LOGGED_CRM_2026',
    engine: 'doubao',
    requestId: 'req-doubao-rel-1',
    locationCode: 2156,
    languageCode: 'zh',
    signal: new AbortController().signal,
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe('Issue #17: Doubao SSE streaming, stage timing observability, stall fast-fail & channel pacing', () => {
  const servers: TestServerHandle[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const s = servers.pop();
      if (s) {
        await s.close();
      }
    }
  });

  it('parses full Doubao Ark SSE lifecycle, records stageTimingsMs, and emits sanitized structured logs without secret/prompt/answer leakage', async () => {
    const secretApiKey = 'sk-doubao-top-secret-key-999999';
    const secretAnswer = 'SECRET_ANSWER_BODY_MUST_NOT_APPEAR_IN_LOGS';
    let capturedBody: Record<string, unknown> | undefined;

    const srv = await startHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          unknown
        >;
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        });

        const sendEvent = (event: string, payload: unknown): void => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
        };

        sendEvent('response.created', {
          type: 'response.created',
          response: { id: 'resp_sse_001', model: 'ep-doubao-sse' },
        });
        sendEvent('response.web_search_call.in_progress', {
          type: 'response.web_search_call.in_progress',
        });

        setTimeout(() => {
          sendEvent('response.output_item.done', {
            type: 'response.output_item.done',
            item: {
              type: 'web_search_call',
              status: 'completed',
              action: { query: '2026 CRM对比; 豆包联网查询；轻量CRM' },
            },
          });
          sendEvent('response.web_search_call.completed', {
            type: 'response.web_search_call.completed',
          });
        }, 35);

        setTimeout(() => {
          sendEvent('response.output_text.delta', {
            type: 'response.output_text.delta',
            delta: `${secretAnswer} 第一段`,
          });
          sendEvent('response.output_text.annotation.added', {
            type: 'response.output_text.annotation.added',
            annotation: {
              type: 'url_citation',
              url: 'https://example.cn/doubao-sse-cite?utm_source=ark',
              title: '豆包 SSE 引用',
              snippet: '联网检索摘要',
            },
          });
        }, 65);

        setTimeout(() => {
          sendEvent('response.completed', {
            type: 'response.completed',
            response: {
              id: 'resp_sse_001',
              model: 'ep-doubao-sse',
              output: [
                {
                  type: 'message',
                  content: [
                    {
                      type: 'output_text',
                      text: `${secretAnswer} 第一段完整回答。`,
                    },
                  ],
                },
              ],
              usage: { input_tokens: 64, output_tokens: 180 },
            },
          });
          res.write('data: [DONE]\n\n');
          res.end();
        }, 95);
      });
    });
    servers.push(srv);

    const { logger, infoSpy } = makeLogger();
    const adapter = new DoubaoAdapter(
      {
        apiKey: secretApiKey,
        baseUrl: `${srv.url}/api/v3`,
        model: 'ep-doubao-sse',
        extraBody: {},
        stream: true,
        firstByteTimeoutMs: 2_000,
        idleTimeoutMs: 2_000,
      },
      new HttpClient({ logger }),
      logger,
    );

    const ctx = makeCtx();
    const result = await adapter.collect(ctx);

    expect(capturedBody?.['stream']).toBe(true);
    expect(result.answerText).toBe(`${secretAnswer} 第一段完整回答。`);
    expect(result.citations).toEqual([
      {
        url: 'https://example.cn/doubao-sse-cite?utm_source=ark',
        title: '豆包 SSE 引用',
        snippet: '联网检索摘要',
      },
    ]);
    expect(result.fanOutQueries).toEqual(['2026 CRM对比', '豆包联网查询', '轻量CRM']);
    expect(result.rawMeta.tokensIn).toBe(64);
    expect(result.rawMeta.tokensOut).toBe(180);
    expect(result.rawMeta.upstreamRequestId).toBe('resp_sse_001');

    const timings = result.rawMeta['stageTimingsMs'] as Record<string, number>;
    expect(timings).toBeDefined();
    expect(timings['dispatchMs']).toBeGreaterThanOrEqual(0);
    expect(timings['webSearchMs']).toBeGreaterThanOrEqual(20);
    expect(timings['ttftMs']).toBeGreaterThanOrEqual(50);
    expect(timings['finishMs']).toBeGreaterThanOrEqual(0);
    expect(timings['totalMs']).toBeGreaterThanOrEqual(timings['ttftMs']!);

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [logObj, logMsg] = infoSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(logMsg).toBe('doubao stage timings');
    expect(logObj['outcome']).toBe('ok');
    expect(logObj['responseMode']).toBe('sse');
    expect(logObj['citationsCount']).toBe(1);
    expect(logObj['fanOutCount']).toBe(3);

    const serializedLog = JSON.stringify(logObj);
    expect(serializedLog).not.toContain(secretApiKey);
    expect(serializedLog).not.toContain(ctx.prompt);
    expect(serializedLog).not.toContain(secretAnswer);
  });

  it('fast-fails early header/first-byte stall at firstByteTimeoutMs with retryable 408 UPSTREAM_TIMEOUT and destroys socket cleanly', async () => {
    let clientClosedUpstream = false;
    const srv = await startHttpServer((req, res) => {
      req.on('close', () => {
        clientClosedUpstream = true;
      });
      res.on('close', () => {
        clientClosedUpstream = true;
      });
      // Intentionally hang without writing headers
    });
    servers.push(srv);

    const { logger, warnSpy } = makeLogger();
    const adapter = new DoubaoAdapter(
      {
        apiKey: 'sk-doubao-stall',
        baseUrl: `${srv.url}/api/v3`,
        model: 'ep-doubao-test',
        extraBody: {},
        stream: true,
        firstByteTimeoutMs: 120,
        idleTimeoutMs: 500,
      },
      new HttpClient({ logger }),
      logger,
    );

    const t0 = Date.now();
    await expect(adapter.collect(makeCtx({ timeoutMs: 3_000 }))).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(GatewayError);
        const gw = err as GatewayError;
        expect(gw.statusCode).toBe(408);
        expect(gw.code).toBe('UPSTREAM_TIMEOUT');
        expect(gw.retryable).toBe(true);
        expect(gw.engine).toBe('doubao');
        return true;
      },
    );
    const elapsed = Date.now() - t0;

    // Must abort well before full 3000ms attempt timeout
    expect(elapsed).toBeLessThan(1_000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [warnObj] = warnSpy.mock.calls[0] as [Record<string, unknown>];
    expect(warnObj['outcome']).toBe('timeout');
    expect(warnObj['failureStage']).toBe('connect_dispatch');

    // Allow event loop tick for TCP FIN propagation
    await new Promise((r) => setTimeout(r, 50));
    expect(clientClosedUpstream).toBe(true);
  });

  it('fast-fails mid-stream idle stall at idleTimeoutMs during web_search and cleans up stream handle', async () => {
    let streamDisconnected = false;
    const srv = await startHttpServer((req, res) => {
      req.on('close', () => {
        streamDisconnected = true;
      });
      res.on('close', () => {
        streamDisconnected = true;
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `event: response.web_search_call.in_progress\ndata: ${JSON.stringify({ type: 'response.web_search_call.in_progress' })}\n\n`,
      );
      // Stall mid-stream without sending heartbeats or completion
    });
    servers.push(srv);

    const { logger, warnSpy } = makeLogger();
    const adapter = new DoubaoAdapter(
      {
        apiKey: 'sk-doubao-idle',
        baseUrl: `${srv.url}/api/v3`,
        model: 'ep-doubao-test',
        extraBody: {},
        stream: true,
        firstByteTimeoutMs: 1_000,
        idleTimeoutMs: 140,
      },
      new HttpClient({ logger }),
      logger,
    );

    const t0 = Date.now();
    await expect(adapter.collect(makeCtx({ timeoutMs: 3_000 }))).rejects.toMatchObject({
      statusCode: 408,
      code: 'UPSTREAM_TIMEOUT',
      retryable: true,
      engine: 'doubao',
    });
    expect(Date.now() - t0).toBeLessThan(1_000);

    const [warnObj] = warnSpy.mock.calls[0] as [Record<string, unknown>];
    expect(warnObj['outcome']).toBe('timeout');
    expect(warnObj['failureStage']).toBe('web_search');

    await new Promise((r) => setTimeout(r, 50));
    expect(streamDisconnected).toBe(true);
  });

  it('keeps idle watchdog alive when SSE heartbeat comments arrive and completes cleanly', async () => {
    const srv = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        if (ticks <= 4) {
          res.write(': heartbeat\n\n');
        } else {
          clearInterval(timer);
          res.write(
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '心跳保活后成功返回' })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 45);
    });
    servers.push(srv);

    const adapter = new DoubaoAdapter(
      {
        apiKey: 'sk-doubao-hb',
        baseUrl: `${srv.url}/api/v3`,
        model: 'ep-doubao-test',
        extraBody: {},
        stream: true,
        firstByteTimeoutMs: 1_000,
        idleTimeoutMs: 140,
      },
      new HttpClient(),
    );

    const result = await adapter.collect(makeCtx({ timeoutMs: 3_000 }));
    expect(result.answerText).toBe('心跳保活后成功返回');
  });

  it('enforces channel pacing (minIntervalMs) and applies adaptive cooldown after HTTP 429', async () => {
    const dispatchTimestamps: number[] = [];
    let reqNum = 0;
    const srv = await startHttpServer((_req, res) => {
      reqNum += 1;
      dispatchTimestamps.push(Date.now());
      if (reqNum === 1) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': '0.15',
        });
        res.end(JSON.stringify({ error: 'rate limited' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `resp_${reqNum}`,
          model: 'ep-doubao-test',
          output_text: `第 ${reqNum} 次响应成功`,
        }),
      );
    });
    servers.push(srv);

    const adapter = new DoubaoAdapter(
      {
        apiKey: 'sk-doubao-pace',
        baseUrl: `${srv.url}/api/v3`,
        model: 'ep-doubao-test',
        extraBody: {},
        stream: true,
        minIntervalMs: 80,
      },
      new HttpClient(),
    );

    await expect(adapter.collect(makeCtx())).rejects.toMatchObject({
      statusCode: 429,
      code: 'RATE_LIMITED',
      retryable: true,
    });

    const second = await adapter.collect(makeCtx());
    expect(second.answerText).toBe('第 2 次响应成功');
    const third = await adapter.collect(makeCtx());
    expect(third.answerText).toBe('第 3 次响应成功');

    // Cooldown after 429 (~150ms) and minIntervalMs pacing (~80ms)
    expect(dispatchTimestamps[1]! - dispatchTimestamps[0]!).toBeGreaterThanOrEqual(110);
    expect(dispatchTimestamps[2]! - dispatchTimestamps[1]!).toBeGreaterThanOrEqual(60);
  });

  it('applies gentle Doubao default config & semaphore concurrency (min(2, domesticConcurrency)) while allowing overrides', () => {
    const defaultCfg = loadConfig({
      GATEWAY_API_KEYS: 'k-test',
      DOUBAO_API_KEY: 'sk-db',
      DOUBAO_MODEL: 'ep-db',
    });
    expect(defaultCfg.domestic.doubao.stream).toBe(true);
    expect(defaultCfg.domestic.doubao.firstByteTimeoutMs).toBe(18_000);
    expect(defaultCfg.domestic.doubao.idleTimeoutMs).toBe(25_000);
    expect(defaultCfg.domestic.doubao.minIntervalMs).toBe(0);
    expect(defaultCfg.domestic.doubao.concurrency).toBeUndefined();

    const defaultRegistry = EngineRegistry.fromConfig(defaultCfg, new HttpClient());
    const defaultByEngine = new Map(defaultRegistry.getStatuses().map((s) => [s.engine, s]));
    expect(defaultByEngine.get('doubao')?.concurrencyLimit).toBe(2);
    expect(defaultByEngine.get('deepseek')?.concurrencyLimit).toBe(5);

    const constrainedCfg = loadConfig({
      GATEWAY_API_KEYS: 'k-test',
      DOMESTIC_CONCURRENCY_PER_ENGINE: '1',
      DOUBAO_API_KEY: 'sk-db',
      DOUBAO_MODEL: 'ep-db',
    });
    const constrainedByEngine = new Map(
      EngineRegistry.fromConfig(constrainedCfg, new HttpClient())
        .getStatuses()
        .map((s) => [s.engine, s]),
    );
    expect(constrainedByEngine.get('doubao')?.concurrencyLimit).toBe(1);

    const overrideCfg = loadConfig({
      GATEWAY_API_KEYS: 'k-test',
      DOUBAO_API_KEY: 'sk-db',
      DOUBAO_MODEL: 'ep-db',
      DOUBAO_CONCURRENCY: '3',
      DOUBAO_STREAM: 'false',
    });
    expect(overrideCfg.domestic.doubao.stream).toBe(false);
    const overrideByEngine = new Map(
      EngineRegistry.fromConfig(overrideCfg, new HttpClient())
        .getStatuses()
        .map((s) => [s.engine, s]),
    );
    expect(overrideByEngine.get('doubao')?.concurrencyLimit).toBe(3);
  });
});
