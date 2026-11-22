import { readFileSync } from 'node:fs';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KimiAdapter } from '../../src/adapters/domestic/kimi.adapter.js';
import { YuanbaoAdapter } from '../../src/adapters/domestic/yuanbao.adapter.js';
import { loadConfig } from '../../src/config.js';
import {
  collectResponseSchema,
  getAliasesForEngine,
  resolveEngineAlias,
  type SupportedEngine,
} from '../../src/core/contract.js';
import { HttpClient } from '../../src/core/http-client.js';
import { normalizeResponse } from '../../src/core/normalizer.js';
import { EngineRegistry } from '../../src/core/registry.js';
import type { CollectContext } from '../../src/core/types.js';

function loadFixture(name: string): Record<string, unknown> {
  const raw = readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function makeContext(
  engine: SupportedEngine,
  prompt = '2026年中小企业CRM系统推荐哪几款？',
): CollectContext {
  return {
    prompt,
    engine,
    requestId: `req-${engine}-18`,
    locationCode: 2156,
    languageCode: 'zh',
    locale: 'zh-CN',
    region: 'CN',
    signal: new AbortController().signal,
    timeoutMs: 10_000,
  };
}

describe('Issue #18: Tier 1 domestic engines (Yuanbao, Kimi, Qwen/Tongyi alias) & readiness metadata', () => {
  let mockAgent: MockAgent;
  let httpClient: HttpClient;

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    httpClient = new HttpClient({ dispatcher: mockAgent });
  });

  afterEach(async () => {
    mockAgent.assertNoPendingInterceptors();
    await mockAgent.close();
  });

  describe('YuanbaoAdapter (Tencent Hunyuan + WeChat/Sogou search)', () => {
    it('supports YUANBAO_* and HUNYUAN_* env fallbacks and checks isConfigured()', async () => {
      const fromHunyuan = loadConfig({
        GATEWAY_API_KEYS: 'k-1',
        HUNYUAN_API_KEY: 'sk-hunyuan-fallback',
        HUNYUAN_MODEL: 'hunyuan-turbo',
      });
      expect(fromHunyuan.domestic.yuanbao.apiKey).toBe('sk-hunyuan-fallback');
      expect(fromHunyuan.domestic.yuanbao.model).toBe('hunyuan-turbo');

      const unconfigured = new YuanbaoAdapter(
        {
          apiKey: '',
          baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
          model: 'hunyuan-turbos-latest',
          extraBody: {},
        },
        httpClient,
      );
      expect(unconfigured.isConfigured()).toBe(false);
      await expect(unconfigured.collect(makeContext('yuanbao'))).rejects.toMatchObject({
        statusCode: 501,
        code: 'ENGINE_NOT_CONFIGURED',
        retryable: false,
      });
    });

    it('sends Tencent Hunyuan search flags, parses fixture with site_name snippet fallback, splits queries, and excludes reasoning', async () => {
      const fixture = loadFixture('yuanbao');
      let capturedAuth: string | undefined;
      let capturedLang: string | undefined;
      let capturedBody: Record<string, unknown> | undefined;

      mockAgent
        .get('https://api.hunyuan.cloud.tencent.com')
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply((opts) => {
          const headers = opts.headers as Record<string, string>;
          capturedAuth = headers['authorization'] ?? headers['Authorization'];
          capturedLang = headers['accept-language'] ?? headers['Accept-Language'];
          capturedBody = JSON.parse(String(opts.body)) as Record<string, unknown>;
          return {
            statusCode: 200,
            data: fixture,
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        });

      const adapter = new YuanbaoAdapter(
        {
          apiKey: 'sk-yuanbao-test',
          baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
          model: 'hunyuan-turbos-latest',
          extraBody: { search_info: true },
        },
        httpClient,
      );

      const ctx = makeContext('yuanbao');
      const result = await adapter.collect(ctx);

      expect(capturedAuth).toBe('Bearer sk-yuanbao-test');
      expect(capturedLang).toBe('zh-CN');
      expect(capturedBody).toMatchObject({
        model: 'hunyuan-turbos-latest',
        enable_enhancement: true,
        force_search_enhancement: true,
        citation: true,
        search_info: true,
        stream: false,
      });

      expect(result.answerText).toContain('腾讯元宝联网检索显示');
      expect(result.citations).toHaveLength(2);
      expect(result.citations[0]).toEqual({
        url: 'https://mp.weixin.qq.com/s/yuanbao-crm-2026?utm_source=sogou',
        title: '2026中小企业企微CRM选型评测',
        snippet: '重点对比企业微信侧边栏、线索自动分配与年度席位价格。',
        position: 1,
      });
      expect(result.citations[1]).toEqual({
        url: 'https://www.sogou.com/crm/guide-2026',
        title: '中小企业CRM落地避坑指南',
        snippet: '搜狗百科',
        position: 2,
      });
      expect(result.fanOutQueries).toEqual([
        '2026中小企业CRM推荐',
        '企微CRM对比',
        '轻量级SaaS CRM价格',
      ]);
      expect(result.rawMeta).toEqual({
        provider: 'tencent-hunyuan',
        model: 'hunyuan-turbos-latest',
        upstreamRequestId: 'hunyuan-yuanbao-001',
        tokensIn: 84,
        tokensOut: 216,
      });

      const normalized = normalizeResponse({
        result,
        prompt: ctx.prompt,
        meta: {
          engine: 'yuanbao',
          region: 'domestic',
          requestId: ctx.requestId,
          latencyMs: 140,
          attempts: 1,
          cached: false,
        },
      });
      expect(collectResponseSchema.parse(normalized).citations[0]?.url).toBe(
        'https://mp.weixin.qq.com/s/yuanbao-crm-2026',
      );
    });

    it('maps upstream HTTP 401 to 503 UPSTREAM_AUTH_OR_QUOTA', async () => {
      mockAgent
        .get('https://api.hunyuan.cloud.tencent.com')
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply(401, { error: 'invalid key' });

      const adapter = new YuanbaoAdapter(
        {
          apiKey: 'bad-key',
          baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
          model: 'hunyuan-turbos-latest',
          extraBody: {},
        },
        httpClient,
      );

      await expect(adapter.collect(makeContext('yuanbao'))).rejects.toMatchObject({
        statusCode: 503,
        code: 'UPSTREAM_AUTH_OR_QUOTA',
        retryable: false,
      });
    });
  });

  describe('KimiAdapter (Moonshot AI $web_search builtin_function)', () => {
    it('supports KIMI_* and MOONSHOT_* env fallbacks and checks isConfigured()', async () => {
      const fromMoonshot = loadConfig({
        GATEWAY_API_KEYS: 'k-1',
        MOONSHOT_API_KEY: 'sk-moonshot-fallback',
        MOONSHOT_MODEL: 'moonshot-v1-32k',
        KIMI_MAX_SEARCH_ROUNDS: '4',
      });
      expect(fromMoonshot.domestic.kimi.apiKey).toBe('sk-moonshot-fallback');
      expect(fromMoonshot.domestic.kimi.model).toBe('moonshot-v1-32k');
      expect(fromMoonshot.domestic.kimi.maxSearchRounds).toBe(4);

      const unconfigured = new KimiAdapter(
        {
          apiKey: '',
          baseUrl: 'https://api.moonshot.cn/v1',
          model: 'moonshot-v1-auto',
          extraBody: {},
          maxSearchRounds: 3,
        },
        httpClient,
      );
      expect(unconfigured.isConfigured()).toBe(false);
      await expect(unconfigured.collect(makeContext('kimi'))).rejects.toMatchObject({
        statusCode: 501,
        code: 'ENGINE_NOT_CONFIGURED',
        retryable: false,
      });
    });

    it('handles single-turn OpenAI-compatible relay response using kimi.json fixture', async () => {
      const fixture = loadFixture('kimi');
      mockAgent
        .get('https://api.moonshot.cn')
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply(200, fixture, { headers: { 'content-type': 'application/json' } });

      const adapter = new KimiAdapter(
        {
          apiKey: 'sk-kimi-test',
          baseUrl: 'https://api.moonshot.cn/v1',
          model: 'moonshot-v1-auto',
          extraBody: {},
          maxSearchRounds: 3,
        },
        httpClient,
      );

      const ctx = makeContext('kimi');
      const result = await adapter.collect(ctx);
      expect(result.answerText).toContain('CRM');
      expect(result.citations.length).toBeGreaterThanOrEqual(2);
      expect(result.fanOutQueries).toEqual([
        '2026 中小企业 CRM 横评',
        '出海 CRM 推荐',
        'Zoho CRM 2026 价格',
      ]);
      expect(result.rawMeta.provider).toBe('moonshot-kimi');

      const normalized = normalizeResponse({
        result,
        prompt: ctx.prompt,
        meta: {
          engine: 'kimi',
          region: 'domestic',
          requestId: ctx.requestId,
          latencyMs: 110,
          attempts: 1,
          cached: false,
        },
      });
      const parsed = collectResponseSchema.parse(normalized);
      // Verify redirect unwrapping (link.zhihu.com) + tracking param stripping (utm_medium)
      expect(parsed.citations.map((c) => c.url)).toEqual([
        'https://example.com/kimi/crm-benchmark',
        'https://zhuanlan.zhihu.com/p/99887766',
      ]);
    });

    it('executes Moonshot multi-round $web_search tool_calls echo protocol and aggregates tokens, citations, and queries', async () => {
      const capturedBodies: Array<Record<string, unknown>> = [];
      const pool = mockAgent.get('https://api.moonshot.cn');

      // Round 1: finish_reason=tool_calls requesting $web_search echo
      pool
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply((opts) => {
          capturedBodies.push(JSON.parse(String(opts.body)) as Record<string, unknown>);
          return {
            statusCode: 200,
            data: {
              id: 'cmpl-kimi-r1',
              model: 'moonshot-v1-auto',
              choices: [
                {
                  index: 0,
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                      {
                        id: '$web_search:0',
                        type: 'function',
                        index: 0,
                        function: {
                          name: '$web_search',
                          arguments: JSON.stringify({
                            query: '2026 中小企业CRM评测; 轻量化CRM价格',
                            search_result: {
                              total_tokens: 420,
                            },
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 45, completion_tokens: 18 },
            },
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        })
        .times(1);

      // Round 2: final grounded answer after tool echo
      pool
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply((opts) => {
          capturedBodies.push(JSON.parse(String(opts.body)) as Record<string, unknown>);
          return {
            statusCode: 200,
            data: {
              id: 'cmpl-kimi-r2',
              model: 'moonshot-v1-auto',
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: {
                    role: 'assistant',
                    content: 'Kimi 多轮联网检索后推荐纷享销客与销帮帮。',
                    annotations: [
                      {
                        type: 'url_citation',
                        url_citation: {
                          url: 'https://example.cn/kimi-final-ref?utm_source=moonshot',
                          title: 'Kimi 最终引用',
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 310, completion_tokens: 140 },
            },
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        })
        .times(1);

      const adapter = new KimiAdapter(
        {
          apiKey: 'sk-kimi-multi',
          baseUrl: 'https://api.moonshot.cn/v1',
          model: 'moonshot-v1-auto',
          extraBody: {},
          maxSearchRounds: 3,
        },
        httpClient,
      );

      const result = await adapter.collect(makeContext('kimi'));

      expect(capturedBodies).toHaveLength(2);
      // Round 1 sends builtin_function $web_search tool
      expect(capturedBodies[0]?.['tools']).toEqual([
        { type: 'builtin_function', function: { name: '$web_search' } },
      ]);

      // Round 2 echoes assistant tool_calls + role: "tool" message verbatim
      const round2Messages = capturedBodies[1]?.['messages'] as Array<Record<string, unknown>>;
      expect(round2Messages).toHaveLength(3);
      expect(round2Messages[1]?.['role']).toBe('assistant');
      expect(round2Messages[2]).toMatchObject({
        role: 'tool',
        tool_call_id: '$web_search:0',
        name: '$web_search',
      });

      expect(result.answerText).toBe('Kimi 多轮联网检索后推荐纷享销客与销帮帮。');
      expect(result.citations).toEqual([
        {
          url: 'https://example.cn/kimi-final-ref?utm_source=moonshot',
          title: 'Kimi 最终引用',
        },
      ]);
      expect(result.fanOutQueries).toEqual(['2026 中小企业CRM评测', '轻量化CRM价格']);
      expect(result.rawMeta.tokensIn).toBe(355);
      expect(result.rawMeta.tokensOut).toBe(158);
      expect(result.rawMeta['searchRounds']).toBe(1);
      expect(result.rawMeta.upstreamRequestId).toBe('cmpl-kimi-r2');
    });

    it('throws retryable 502 UPSTREAM_BAD_RESPONSE if tool_calls exceed maxSearchRounds without answer', async () => {
      mockAgent
        .get('https://api.moonshot.cn')
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply(
          200,
          {
            id: 'cmpl-kimi-loop',
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
                      function: { name: '$web_search', arguments: '{"query":"loop"}' },
                    },
                  ],
                },
              },
            ],
          },
          { headers: { 'content-type': 'application/json' } },
        )
        .times(2);

      const adapter = new KimiAdapter(
        {
          apiKey: 'sk-kimi-loop',
          baseUrl: 'https://api.moonshot.cn/v1',
          model: 'moonshot-v1-auto',
          extraBody: {},
          maxSearchRounds: 2,
        },
        httpClient,
      );

      await expect(adapter.collect(makeContext('kimi'))).rejects.toMatchObject({
        statusCode: 502,
        code: 'UPSTREAM_BAD_RESPONSE',
        retryable: true,
        engine: 'kimi',
      });
    });
  });

  describe('qwen alias -> tongyi and readiness summaries', () => {
    it('resolves qwen alias, supports QWEN_* config fallbacks, and reports sanitized ready summaries', () => {
      expect(resolveEngineAlias('qwen')).toBe('tongyi');
      expect(resolveEngineAlias('  QWEN ')).toBe('tongyi');
      expect(resolveEngineAlias('tongyi')).toBe('tongyi');
      expect(getAliasesForEngine('tongyi')).toEqual(['qwen']);
      expect(getAliasesForEngine('yuanbao')).toEqual([]);

      const cfg = loadConfig({
        GATEWAY_API_KEYS: 'k-1',
        QWEN_API_KEY: 'sk-qwen-alias',
        QWEN_MODEL: 'qwen-max',
        YUANBAO_API_KEY: 'sk-yb',
        KIMI_API_KEY: 'sk-km',
      });
      expect(cfg.domestic.tongyi.apiKey).toBe('sk-qwen-alias');
      expect(cfg.domestic.tongyi.model).toBe('qwen-max');

      const registry = EngineRegistry.fromConfig(cfg, httpClient);
      expect(registry.resolve('qwen').adapter.engine).toBe('tongyi');
      expect(registry.getConfiguredCount()).toBe(3);
      expect(registry.getTotalSupported()).toBe(12);

      const summaries = registry.getReadyEngineSummaries();
      const byEngine = new Map(summaries.map((s) => [s.engine, s]));
      expect(byEngine.get('tongyi')).toEqual({
        engine: 'tongyi',
        region: 'domestic',
        configured: true,
        status: 'ready',
        aliases: ['qwen'],
      });
      expect(byEngine.get('yuanbao')).toMatchObject({ configured: true, status: 'ready' });
      expect(byEngine.get('kimi')).toMatchObject({ configured: true, status: 'ready' });
      expect(byEngine.get('doubao')).toMatchObject({ configured: false, status: 'unconfigured' });
    });
  });
});
