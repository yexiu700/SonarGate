import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type SonarGateApp } from '../../../src/app.js';
import { loadConfig } from '../../../src/config.js';
import {
  createE2EHarness,
  DEFAULT_E2E_ENV,
  PRIMARY_API_KEY,
  type E2EHarness,
} from '../helpers/e2e-harness.js';
import { assertValidGeoMixResponse, errorEnvelopeSchema } from '../helpers/geomix-schema.js';
import {
  buildChatGptPayload,
  buildPerplexityPayload,
  buildTongyiPayload,
  buildYuanbaoPayload,
} from '../helpers/mock-upstreams.js';

interface LocalServerHandle {
  baseUrl: string;
  close(): Promise<void>;
}

async function startLocalServer(
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
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

describe('Tier 4: Issues #16, #17, #18 End-to-End Verification', () => {
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

  it('Issue #16: propagates market/locale/region to overseas DataForSEO, isolates cache by locale, unwraps redirects, and splits fanOutQueries', async () => {
    const harness = createE2EHarness();
    harnesses.push(harness);

    harness.upstreams.mockEngineSuccess(
      'chatgpt',
      buildChatGptPayload({
        answerText: 'Deutsche CRM Empfehlungen 2026.',
        citations: [
          {
            url: 'https://www.google.com/url?q=https%3A%2F%2Fde.example.com%2Fcrm%3Futm_source%3Dchatgpt%26id%3D1',
            title: 'CRM Vergleich DE',
          },
        ],
        fanOutQueries: ['beste crm software 2026; hubspot preise de\nsalesforce kmu'],
      }),
      { times: 1 },
    );
    harness.upstreams.mockEngineSuccess(
      'chatgpt',
      buildChatGptPayload({
        answerText: '2026年日本中小企業向けCRM比較。',
        citations: [{ url: 'https://jp.example.com/crm', title: 'CRM比較 JP' }],
        fanOutQueries: ['中小企業 CRM 2026；SaaS 料金比較'],
      }),
      { times: 1 },
    );
    harness.upstreams.mockEngineSuccess('perplexity', buildPerplexityPayload(), { times: 1 });

    // 1. German market request -> derives location_code 2276, language_code 'de', countryCode 'DE'
    const deRes = await harness.collect(
      {
        engine: 'chatgpt',
        prompt: 'Best CRM for SMBs 2026',
        market: 'GLOBAL',
        locale: 'de-DE',
        region: 'DE',
      },
      { requestId: 'req-i16-de' },
    );
    expect(deRes.statusCode).toBe(200);
    const deParsed = assertValidGeoMixResponse(deRes.body, deRes.json());
    expect(deParsed.rawMeta?.['region']).toBe('overseas');
    expect(deParsed.rawMeta?.['market']).toBe('GLOBAL');
    expect(deParsed.rawMeta?.['locale']).toBe('de-DE');
    expect(deParsed.rawMeta?.['countryCode']).toBe('DE');
    expect(deParsed.citations[0]?.url).toBe('https://de.example.com/crm?id=1');
    expect(deParsed.fanOutQueries).toEqual([
      'beste crm software 2026',
      'hubspot preise de',
      'salesforce kmu',
    ]);

    // 2. Same prompt + engine with Japanese locale -> MUST miss DE cache and hit upstream separately
    const jpRes = await harness.collect(
      {
        engine: 'chatgpt',
        prompt: 'Best CRM for SMBs 2026',
        market: 'GLOBAL',
        locale: 'ja-JP',
        region: 'JP',
      },
      { requestId: 'req-i16-jp' },
    );
    expect(jpRes.statusCode).toBe(200);
    const jpParsed = assertValidGeoMixResponse(jpRes.body, jpRes.json());
    expect(jpParsed.rawMeta?.['cached']).toBe(false);
    expect(jpParsed.rawMeta?.['locale']).toBe('ja-JP');
    expect(jpParsed.rawMeta?.['countryCode']).toBe('JP');
    expect(jpParsed.fanOutQueries).toEqual(['中小企業 CRM 2026', 'SaaS 料金比較']);

    const capturedChatGpt = harness.upstreams.getCapturedRequests('chatgpt');
    expect(capturedChatGpt).toHaveLength(2);
    expect((capturedChatGpt[0]?.jsonBody as Array<Record<string, unknown>>)[0]).toMatchObject({
      location_code: 2276,
      language_code: 'de',
    });
    expect((capturedChatGpt[1]?.jsonBody as Array<Record<string, unknown>>)[0]).toMatchObject({
      location_code: 2392,
      language_code: 'ja',
    });

    // 3. Perplexity forwards region -> web_search_country_iso_code: 'DE'
    const pplxRes = await harness.collect(
      {
        engine: 'perplexity',
        prompt: 'Best CRM in Germany',
        locale: 'de-DE',
      },
      { requestId: 'req-i16-pplx' },
    );
    expect(pplxRes.statusCode).toBe(200);
    const capturedPplx = harness.upstreams.getCapturedRequests('perplexity');
    expect((capturedPplx[0]?.jsonBody as Array<Record<string, unknown>>)[0]).toMatchObject({
      web_search_country_iso_code: 'DE',
    });
  });

  it('Issue #17: recovers 100% of a 10-query concurrent Doubao SSE batch under intermittent early stalls with gentle concurrency <= 2', async () => {
    let activeRequests = 0;
    let maxConcurrentObserved = 0;
    const attemptsByPrompt = new Map<string, number>();

    const srv = await startLocalServer((req, res) => {
      if (req.url !== '/api/v3/responses' || req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }

      activeRequests += 1;
      maxConcurrentObserved = Math.max(maxConcurrentObserved, activeRequests);
      let released = false;
      const release = (): void => {
        if (!released) {
          released = true;
          activeRequests -= 1;
        }
      };
      req.on('close', release);
      res.on('close', release);
      res.on('finish', release);

      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          input?: Array<{ content?: string }>;
        };
        const prompt = parsed.input?.[0]?.content ?? 'unknown';
        const attempt = (attemptsByPrompt.get(prompt) ?? 0) + 1;
        attemptsByPrompt.set(prompt, attempt);

        // Simulate 20% early-stage header/first-byte stall on first attempt (queries #2 and #7)
        if ((prompt.endsWith('#2') || prompt.endsWith('#7')) && attempt === 1) {
          // Hang until client firstByteTimeoutMs aborts and closes the socket
          return;
        }

        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write(
          `event: response.web_search_call.in_progress\ndata: ${JSON.stringify({ type: 'response.web_search_call.in_progress' })}\n\n`,
        );

        setTimeout(() => {
          if (res.destroyed || res.writableEnded) {
            return;
          }
          res.write(
            `event: response.output_item.done\ndata: ${JSON.stringify({
              type: 'response.output_item.done',
              item: {
                type: 'web_search_call',
                status: 'completed',
                action: { query: `查询A ${prompt}; 查询B ${prompt}` },
              },
            })}\n\n`,
          );
          res.write(
            `event: response.output_text.delta\ndata: ${JSON.stringify({
              type: 'response.output_text.delta',
              delta: `豆包 SSE 稳定回答：${prompt}`,
            })}\n\n`,
          );
          res.write(
            `event: response.output_text.annotation.added\ndata: ${JSON.stringify({
              type: 'response.output_text.annotation.added',
              annotation: {
                type: 'url_citation',
                url: 'https://example.cn/doubao-batch-cite',
                title: '豆包批量采集来源',
              },
            })}\n\n`,
          );
          res.write(
            `event: response.completed\ndata: ${JSON.stringify({
              type: 'response.completed',
              response: {
                id: `resp_${attempt}`,
                model: 'ep-doubao-sse-e2e',
                output: [
                  {
                    type: 'message',
                    content: [{ type: 'output_text', text: `豆包 SSE 稳定回答：${prompt}` }],
                  },
                ],
                usage: { input_tokens: 40, output_tokens: 90 },
              },
            })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
        }, 30);
      });
    });
    servers.push(srv);

    const config = loadConfig({
      ...DEFAULT_E2E_ENV,
      DOUBAO_BASE_URL: `${srv.baseUrl}/api/v3`,
      DOUBAO_MODEL: 'ep-doubao-sse-e2e',
      DOUBAO_STREAM: 'true',
      DOUBAO_FIRST_BYTE_TIMEOUT_MS: '500',
      DOUBAO_IDLE_TIMEOUT_MS: '800',
      DOUBAO_TIMEOUT_MS: '3000',
      DOMESTIC_CONCURRENCY_PER_ENGINE: '5',
      MAX_UPSTREAM_RETRIES: '2',
      RETRY_BASE_DELAY_MS: '50',
      RETRY_MIN_REMAINING_BUDGET_MS: '100',
    });
    const app = buildApp({ config, logger: false });
    apps.push(app);

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, idx) =>
        app.inject({
          method: 'POST',
          url: '/v1/collect',
          headers: {
            authorization: `Bearer ${PRIMARY_API_KEY}`,
            'content-type': 'application/json',
            'x-request-id': `doubao-batch-${idx + 1}`,
          },
          payload: JSON.stringify({
            engine: 'doubao',
            prompt: `2026 品牌口碑评测查询 #${idx + 1}`,
          }),
        }),
      ),
    );

    // 100% of batch succeeded despite 20% first-attempt stalls
    for (let i = 0; i < responses.length; i += 1) {
      const res = responses[i]!;
      expect(res.statusCode).toBe(200);
      const parsed = assertValidGeoMixResponse(res.body, res.json());
      expect(parsed.answerText).toContain(`#${i + 1}`);
      expect(parsed.citations).toHaveLength(1);
      expect(parsed.fanOutQueries).toHaveLength(2);
      expect(parsed.rawMeta?.['stageTimingsMs']).toBeDefined();

      if (i + 1 === 2 || i + 1 === 7) {
        expect(parsed.rawMeta?.['attempts']).toBe(2);
      } else {
        expect(parsed.rawMeta?.['attempts']).toBe(1);
      }
    }

    // Gentle default Doubao concurrency cap (min(2, DOMESTIC_CONCURRENCY_PER_ENGINE))
    expect(maxConcurrentObserved).toBeLessThanOrEqual(2);
  });

  it('Issue #17: returns clean 408 UPSTREAM_TIMEOUT (retryable: true) when Doubao stalls across all retries', async () => {
    const srv = await startLocalServer((_req, _res) => {
      // Permanently stalled upstream
    });
    servers.push(srv);

    const config = loadConfig({
      ...DEFAULT_E2E_ENV,
      DOUBAO_BASE_URL: `${srv.baseUrl}/api/v3`,
      DOUBAO_MODEL: 'ep-doubao-stall',
      DOUBAO_STREAM: 'true',
      DOUBAO_FIRST_BYTE_TIMEOUT_MS: '500',
      DOUBAO_TIMEOUT_MS: '1000',
      MAX_UPSTREAM_RETRIES: '1',
      RETRY_BASE_DELAY_MS: '50',
      RETRY_MIN_REMAINING_BUDGET_MS: '100',
    });
    const app = buildApp({ config, logger: false });
    apps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: {
        authorization: `Bearer ${PRIMARY_API_KEY}`,
        'content-type': 'application/json',
        'x-request-id': 'req-doubao-perm-timeout',
      },
      payload: JSON.stringify({ engine: 'doubao', prompt: '持续超时测试' }),
    });

    expect(res.statusCode).toBe(408);
    expect(res.headers['x-request-id']).toBe('req-doubao-perm-timeout');
    const err = errorEnvelopeSchema.parse(res.json());
    expect(err.error).toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
      retryable: true,
      engine: 'doubao',
      requestId: 'req-doubao-perm-timeout',
    });
  });

  it('Issue #18: supports yuanbao, multi-round kimi $web_search, qwen -> tongyi alias, and dynamic /ready engine discovery', async () => {
    const harness = createE2EHarness({
      DOUBAO_API_KEY: '',
      DOUBAO_MODEL: '',
      DEEPSEEK_API_KEY: '',
      TONGYI_API_KEY: '',
      QWEN_API_KEY: 'e2e-qwen-alias-key-1234',
      ZHIPU_API_KEY: '',
      WENXIN_API_KEY: '',
      DATAFORSEO_LOGIN: '',
      DATAFORSEO_PASSWORD: '',
      // YUANBAO_API_KEY and KIMI_API_KEY remain set from DEFAULT_E2E_ENV
    });
    harnesses.push(harness);

    // 1. GET /ready exposes accurate configuredCount=3 (tongyi via QWEN_API_KEY, yuanbao, kimi)
    const readyRes = await harness.getReady();
    expect(readyRes.statusCode).toBe(200);
    const readyBody = readyRes.json() as {
      ready: boolean;
      configuredCount: number;
      totalSupported: number;
      engines: Array<{
        engine: string;
        configured: boolean;
        status: string;
        aliases?: string[];
      }>;
      plannedEngines: Array<{ engine: string; status: string }>;
      aliases: Record<string, string>;
    };
    expect(readyBody.ready).toBe(true);
    expect(readyBody.configuredCount).toBe(3);
    expect(readyBody.totalSupported).toBe(12);
    expect(readyBody.aliases).toEqual({ qwen: 'tongyi' });
    expect(readyBody.plannedEngines).toEqual([
      { engine: 'nami', region: 'domestic', configured: false, status: 'planned' },
    ]);

    const readyByEngine = new Map(readyBody.engines.map((e) => [e.engine, e]));
    expect(readyByEngine.get('yuanbao')).toMatchObject({ configured: true, status: 'ready' });
    expect(readyByEngine.get('kimi')).toMatchObject({ configured: true, status: 'ready' });
    expect(readyByEngine.get('tongyi')).toMatchObject({
      configured: true,
      status: 'ready',
      aliases: ['qwen'],
    });
    expect(readyByEngine.get('doubao')).toMatchObject({
      configured: false,
      status: 'unconfigured',
    });

    // 2. Yuanbao collect
    harness.upstreams.mockEngineSuccess(
      'yuanbao',
      buildYuanbaoPayload({ answerText: '腾讯元宝联网分析结果。' }),
      { times: 1 },
    );
    const ybRes = await harness.collect(
      { engine: 'yuanbao', prompt: '腾讯元宝采集测试' },
      { requestId: 'req-i18-yuanbao' },
    );
    expect(ybRes.statusCode).toBe(200);
    const ybParsed = assertValidGeoMixResponse(ybRes.body, ybRes.json());
    expect(ybParsed.answerText).toBe('腾讯元宝联网分析结果。');
    expect(ybParsed.citations.length).toBeGreaterThanOrEqual(1);
    expect(ybParsed.rawMeta?.['engine']).toBe('yuanbao');

    // 3. Kimi multi-round $web_search tool_calls echo collect
    harness.upstreams.mockEngineReply(
      'kimi',
      200,
      {
        id: 'cmpl-kimi-e2e-r1',
        model: 'moonshot-v1-auto',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: '$web_search:0',
                  type: 'function',
                  function: {
                    name: '$web_search',
                    arguments: JSON.stringify({ query: 'Kimi 联网搜索词A; Kimi 联网搜索词B' }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 30, completion_tokens: 15 },
      },
      { times: 1 },
    );
    harness.upstreams.mockEngineReply(
      'kimi',
      200,
      {
        id: 'cmpl-kimi-e2e-r2',
        model: 'moonshot-v1-auto',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Kimi 多轮联网最终回答。',
              annotations: [
                {
                  type: 'url_citation',
                  url_citation: { url: 'https://example.cn/kimi-e2e', title: 'Kimi 来源' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 200, completion_tokens: 90 },
      },
      { times: 1 },
    );
    const kimiRes = await harness.collect(
      { engine: 'kimi', prompt: 'Kimi 多轮采集测试' },
      { requestId: 'req-i18-kimi' },
    );
    expect(kimiRes.statusCode).toBe(200);
    const kimiParsed = assertValidGeoMixResponse(kimiRes.body, kimiRes.json());
    expect(kimiParsed.answerText).toBe('Kimi 多轮联网最终回答。');
    expect(kimiParsed.citations[0]?.url).toBe('https://example.cn/kimi-e2e');
    expect(kimiParsed.fanOutQueries).toEqual(['Kimi 联网搜索词A', 'Kimi 联网搜索词B']);
    expect(kimiParsed.rawMeta?.['tokensIn']).toBe(230);
    expect(kimiParsed.rawMeta?.['tokensOut']).toBe(105);
    expect(harness.upstreams.getHitCount('kimi')).toBe(2);

    // 4. qwen alias routes cleanly to tongyi (configured via QWEN_API_KEY)
    harness.upstreams.mockEngineSuccess(
      'tongyi',
      buildTongyiPayload({ answerText: '通义千问（qwen 别名）回答成功。' }),
      { times: 1 },
    );
    const qwenRes = await harness.collect(
      { engine: 'qwen', prompt: '通义千问别名采集测试' },
      { requestId: 'req-i18-qwen' },
    );
    expect(qwenRes.statusCode).toBe(200);
    const qwenParsed = assertValidGeoMixResponse(qwenRes.body, qwenRes.json());
    expect(qwenParsed.answerText).toBe('通义千问（qwen 别名）回答成功。');
    expect(qwenParsed.rawMeta?.['engine']).toBe('tongyi');
    expect(qwenParsed.rawMeta?.['requestedEngine']).toBe('qwen');
    expect(harness.upstreams.getHitCount('tongyi')).toBe(1);

    // 5. Repeat identical prompt via canonical 'tongyi' hits shared cache (no second upstream call)
    const tongyiCachedRes = await harness.collect(
      { engine: 'tongyi', prompt: '通义千问别名采集测试' },
      { requestId: 'req-i18-tongyi-cached' },
    );
    expect(tongyiCachedRes.statusCode).toBe(200);
    const tongyiCachedParsed = assertValidGeoMixResponse(
      tongyiCachedRes.body,
      tongyiCachedRes.json(),
    );
    expect(tongyiCachedParsed.rawMeta?.['cached']).toBe(true);
    expect(harness.upstreams.getHitCount('tongyi')).toBe(1);
  });
});
