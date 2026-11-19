import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent } from 'undici';
import { DoubaoAdapter } from '../../src/adapters/domestic/doubao.adapter.js';
import { DeepSeekAdapter } from '../../src/adapters/domestic/deepseek.adapter.js';
import {
  deepMergeRecords,
  extractDomesticCitations,
  shallowMergeRecord,
} from '../../src/adapters/domestic/helpers.js';
import { TongyiAdapter } from '../../src/adapters/domestic/tongyi.adapter.js';
import { WenxinAdapter } from '../../src/adapters/domestic/wenxin.adapter.js';
import { ZhipuAdapter } from '../../src/adapters/domestic/zhipu.adapter.js';
import { collectResponseSchema, type SupportedEngine } from '../../src/core/contract.js';
import { GatewayError } from '../../src/core/errors.js';
import { HttpClient } from '../../src/core/http-client.js';
import { normalizeResponse } from '../../src/core/normalizer.js';
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
    requestId: `req-${engine}-001`,
    locationCode: 2840,
    languageCode: 'zh',
    signal: new AbortController().signal,
    timeoutMs: 10_000,
  };
}

describe('domestic helpers', () => {
  it('extractDomesticCitations maps url/title/snippet priorities, bare strings, and deduplicates', () => {
    const citations = extractDomesticCitations([
      'https://example.com/bare',
      {
        url: 'https://example.com/1',
        title: 'Primary Title',
        snippet: 'Primary Snippet',
        position: 2,
      },
      {
        link: 'https://example.com/2',
        name: 'Name Title',
        content: 'Content Snippet',
        index: 3,
      },
      {
        href: 'https://example.com/3',
        site_name: 'Site Name Title',
        summary: 'Summary Snippet',
      },
      {
        source_url: 'https://example.com/4',
        site_name: 'Fallback Site',
        desc: 'Desc Snippet',
      },
      // Duplicate URL should be skipped
      {
        url: 'https://example.com/1',
        title: 'Duplicate Should Be Ignored',
      },
      // Invalid entries should be skipped
      null,
      { title: 'Missing URL' },
      '',
    ]);

    expect(citations).toEqual([
      { url: 'https://example.com/bare' },
      {
        url: 'https://example.com/1',
        title: 'Primary Title',
        snippet: 'Primary Snippet',
        position: 2,
      },
      {
        url: 'https://example.com/2',
        title: 'Name Title',
        snippet: 'Content Snippet',
        position: 3,
      },
      {
        url: 'https://example.com/3',
        title: 'Site Name Title',
        snippet: 'Summary Snippet',
      },
      {
        url: 'https://example.com/4',
        title: 'Fallback Site',
        snippet: 'Desc Snippet',
      },
    ]);
  });

  it('extractDomesticCitations supports fallbackSnippetToSiteName for Tongyi', () => {
    const citations = extractDomesticCitations(
      [
        {
          url: 'https://example.com/tongyi-only-site',
          title: 'Article Title',
          site_name: '知乎专栏',
        },
      ],
      { fallbackSnippetToSiteName: true },
    );

    expect(citations).toEqual([
      {
        url: 'https://example.com/tongyi-only-site',
        title: 'Article Title',
        snippet: '知乎专栏',
      },
    ]);
  });

  it('shallowMergeRecord overrides top-level keys and blocks prototype pollution', () => {
    const base = { model: 'ep-1', temperature: 0.2, nested: { a: 1 } };
    const malicious = JSON.parse(
      '{"temperature": 0.5, "__proto__": {"polluted": true}, "constructor": {"x": 1}, "prototype": {"y": 2}}',
    ) as Record<string, unknown>;

    const merged = shallowMergeRecord(base, malicious);

    expect(merged).toEqual({ model: 'ep-1', temperature: 0.5, nested: { a: 1 } });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(merged, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(merged, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(merged, 'prototype')).toBe(false);
    expect(base.temperature).toBe(0.2);
  });

  it('deepMergeRecords recursively merges plain objects, replaces arrays without mutation, and blocks prototype pollution', () => {
    const base = {
      model: 'deepseek-chat',
      options: { a: 1, nested: { x: true, y: false } },
      tags: ['v1'],
    };
    const override = JSON.parse(
      '{"options": {"b": 2, "nested": {"y": true}}, "tags": ["v2"], "__proto__": {"polluted": true}, "constructor": {"bad": 1}}',
    ) as Record<string, unknown>;

    const merged = deepMergeRecords(base, override);

    expect(merged).toEqual({
      model: 'deepseek-chat',
      options: { a: 1, b: 2, nested: { x: true, y: true } },
      tags: ['v2'],
    });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(base.options.nested.y).toBe(false);
    expect(base.tags).toEqual(['v1']);
  });
});

describe('domestic adapters', () => {
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

  describe('DoubaoAdapter', () => {
    it('requires both apiKey and model for isConfigured()', async () => {
      const missingModel = new DoubaoAdapter(
        {
          apiKey: 'doubao-key',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
          model: '',
          extraBody: {},
        },
        httpClient,
      );
      const missingKey = new DoubaoAdapter(
        {
          apiKey: '',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
          model: 'ep-20260101-doubao-seed',
          extraBody: {},
        },
        httpClient,
      );
      const valid = new DoubaoAdapter(
        {
          apiKey: 'doubao-key',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
          model: 'ep-20260101-doubao-seed',
          extraBody: {},
        },
        httpClient,
      );

      expect(missingModel.isConfigured()).toBe(false);
      expect(missingKey.isConfigured()).toBe(false);
      expect(valid.isConfigured()).toBe(true);

      await expect(missingModel.collect(makeContext('doubao'))).rejects.toMatchObject({
        statusCode: 501,
        code: 'ENGINE_NOT_CONFIGURED',
        retryable: false,
      });
    });

    it('sends POST /api/v3/responses with shallow-merged extraBody and parses fixture', async () => {
      const fixture = loadFixture('doubao');
      let capturedAuth: string | undefined;
      let capturedBody: Record<string, unknown> | undefined;

      mockAgent
        .get('https://ark.cn-beijing.volces.com')
        .intercept({
          path: '/api/v3/responses',
          method: 'POST',
        })
        .reply((opts) => {
          const headers = opts.headers as Record<string, string>;
          capturedAuth = headers['authorization'] ?? headers['Authorization'];
          capturedBody = JSON.parse(String(opts.body)) as Record<string, unknown>;
          return {
            statusCode: 200,
            data: fixture,
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        });

      const adapter = new DoubaoAdapter(
        {
          apiKey: 'test-doubao-secret',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/',
          model: 'ep-20260101-doubao-seed',
          extraBody: { thinking: { type: 'disabled' }, temperature: 0.1 },
        },
        httpClient,
      );

      const ctx = makeContext('doubao');
      const result = await adapter.collect(ctx);

      expect(capturedAuth).toBe('Bearer test-doubao-secret');
      expect(capturedBody).toEqual({
        model: 'ep-20260101-doubao-seed',
        input: [{ role: 'user', content: ctx.prompt }],
        tools: [{ type: 'web_search', max_keyword: 3, limit: 10 }],
        temperature: 0.1,
        thinking: { type: 'disabled' },
      });

      expect(result.answerText).toContain('2026年适合中小企业的CRM系统');
      expect(result.citations).toHaveLength(3);
      expect(result.citations[0]).toEqual({
        url: 'https://example.com/crm/2026-guide?utm_source=ark&id=42',
        title: '2026中小企业CRM选型指南',
        snippet: '从部署成本、微信生态集成与自动化能力对比主流CRM。',
      });
      expect(result.citations[2]?.url).toBe('https://docs.example.net/crm/pricing');
      expect(result.fanOutQueries).toEqual([
        '2026年中小企业CRM系统推荐',
        '2026中小企业CRM对比',
        '轻量级CRM选型指南',
      ]);
      expect(result.rawMeta).toEqual({
        provider: 'volcengine-ark',
        model: 'ep-20260101-doubao-seed',
        upstreamRequestId: 'resp_doubao_001',
        tokensIn: 128,
        tokensOut: 342,
      });

      const normalized = normalizeResponse({
        result,
        prompt: ctx.prompt,
        meta: {
          engine: 'doubao',
          region: 'domestic',
          requestId: ctx.requestId,
          latencyMs: 120,
          attempts: 1,
          cached: false,
        },
      });
      expect(() => collectResponseSchema.parse(normalized)).not.toThrow();
      // Tracking param utm_source stripped, business param id=42 preserved
      expect(normalized.citations[0]?.url).toBe('https://example.com/crm/2026-guide?id=42');
    });

    it('falls back to top-level output_text when output[] has no message text', async () => {
      mockAgent
        .get('https://ark.cn-beijing.volces.com')
        .intercept({ path: '/api/v3/responses', method: 'POST' })
        .reply(
          200,
          {
            id: 'resp_fallback_001',
            model: 'ep-20260101-doubao-seed',
            output: [],
            output_text: '这是顶层 output_text 兜底回答。',
          },
          { headers: { 'content-type': 'application/json' } },
        );

      const adapter = new DoubaoAdapter(
        {
          apiKey: 'test-doubao-secret',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
          model: 'ep-20260101-doubao-seed',
          extraBody: {},
        },
        httpClient,
      );

      const result = await adapter.collect(makeContext('doubao'));
      expect(result.answerText).toBe('这是顶层 output_text 兜底回答。');
    });

    it('maps upstream HTTP 401 to 503 UPSTREAM_AUTH_OR_QUOTA (non-retryable)', async () => {
      mockAgent
        .get('https://ark.cn-beijing.volces.com')
        .intercept({ path: '/api/v3/responses', method: 'POST' })
        .reply(401, { error: { message: 'Invalid API key' } });

      const adapter = new DoubaoAdapter(
        {
          apiKey: 'bad-key',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
          model: 'ep-20260101-doubao-seed',
          extraBody: {},
        },
        httpClient,
      );

      await expect(adapter.collect(makeContext('doubao'))).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(GatewayError);
        const gw = err as GatewayError;
        expect(gw.statusCode).toBe(503);
        expect(gw.code).toBe('UPSTREAM_AUTH_OR_QUOTA');
        expect(gw.retryable).toBe(false);
        return true;
      });
    });
  });

  describe('DeepSeekAdapter', () => {
    it('sends POST /v1/chat/completions with deep-merged searchParams, excludes reasoning_content, and merges 5 citation paths', async () => {
      const fixture = loadFixture('deepseek');
      let capturedAuth: string | undefined;
      let capturedBody: Record<string, unknown> | undefined;

      mockAgent
        .get('https://api.deepseek.com')
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply((opts) => {
          const headers = opts.headers as Record<string, string>;
          capturedAuth = headers['authorization'] ?? headers['Authorization'];
          capturedBody = JSON.parse(String(opts.body)) as Record<string, unknown>;
          return {
            statusCode: 200,
            data: fixture,
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        });

      const searchParams = JSON.parse(
        '{"web_search": true, "search_options": {"max_results": 8}, "__proto__": {"polluted": true}}',
      ) as Record<string, unknown>;

      const adapter = new DeepSeekAdapter(
        {
          apiKey: 'test-deepseek-secret',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          searchParams,
        },
        httpClient,
      );

      expect(adapter.isConfigured()).toBe(true);
      const ctx = makeContext('deepseek');
      const result = await adapter.collect(ctx);

      expect(capturedAuth).toBe('Bearer test-deepseek-secret');
      expect(capturedBody).toEqual({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: ctx.prompt }],
        temperature: 0.2,
        stream: false,
        web_search: true,
        search_options: { max_results: 8 },
      });
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

      // reasoning_content must NEVER be appended to answerText
      expect(result.answerText).toContain('针对中小企业CRM选型');
      expect(result.answerText).not.toContain('内部思考链');
      expect(result.rawMeta.hasReasoning).toBe(true);

      // 5 paths merged and deduplicated (ann-1 appears in both top-level citations and message.annotations)
      expect(result.citations.map((c) => c.url)).toEqual([
        'https://example.com/ds/cite-1',
        'https://example.com/ds/ann-1',
        'https://example.com/ds/top-sr-1',
        'https://example.com/ds/ws-1',
        'https://example.com/ds/msg-sr-1',
      ]);
      expect(result.citations[1]?.title).toBe('CRM功能矩阵（顶层优先）');

      // 3 fanOutQueries paths merged & deduped
      expect(result.fanOutQueries).toEqual([
        '中小企业CRM推荐 2026',
        'SaaS CRM 性价比对比',
        '企微CRM集成方案',
      ]);

      expect(result.rawMeta).toEqual({
        provider: 'deepseek',
        model: 'deepseek-chat',
        upstreamRequestId: 'chatcmpl-deepseek-001',
        tokensIn: 96,
        tokensOut: 280,
        hasReasoning: true,
      });

      const normalized = normalizeResponse({
        result,
        prompt: ctx.prompt,
        meta: {
          engine: 'deepseek',
          region: 'domestic',
          requestId: ctx.requestId,
          latencyMs: 150,
          attempts: 1,
          cached: false,
        },
      });
      expect(() => collectResponseSchema.parse(normalized)).not.toThrow();
    });

    it('sets hasReasoning to false when reasoning_content is absent', async () => {
      mockAgent
        .get('https://api.deepseek.com')
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply(
          200,
          {
            id: 'chatcmpl-ds-no-reason',
            model: 'deepseek-chat',
            choices: [{ message: { role: 'assistant', content: '常规回答文本。' } }],
          },
          { headers: { 'content-type': 'application/json' } },
        );

      const adapter = new DeepSeekAdapter(
        {
          apiKey: 'test-deepseek-secret',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          searchParams: { web_search: true },
        },
        httpClient,
      );

      const result = await adapter.collect(makeContext('deepseek'));
      expect(result.rawMeta.hasReasoning).toBe(false);
    });

    it('maps upstream HTTP 401 to 503 UPSTREAM_AUTH_OR_QUOTA', async () => {
      mockAgent
        .get('https://api.deepseek.com')
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply(401, { error: 'unauthorized' });

      const adapter = new DeepSeekAdapter(
        {
          apiKey: 'bad-key',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          searchParams: { web_search: true },
        },
        httpClient,
      );

      await expect(adapter.collect(makeContext('deepseek'))).rejects.toMatchObject({
        statusCode: 503,
        code: 'UPSTREAM_AUTH_OR_QUOTA',
        retryable: false,
      });
    });
  });

  describe('TongyiAdapter', () => {
    it('sends POST /compatible-mode/v1/chat/completions with enable_search/search_options and parses fixture with site_name fallback', async () => {
      const fixture = loadFixture('tongyi');
      let capturedAuth: string | undefined;
      let capturedBody: Record<string, unknown> | undefined;

      mockAgent
        .get('https://dashscope.aliyuncs.com')
        .intercept({ path: '/compatible-mode/v1/chat/completions', method: 'POST' })
        .reply((opts) => {
          const headers = opts.headers as Record<string, string>;
          capturedAuth = headers['authorization'] ?? headers['Authorization'];
          capturedBody = JSON.parse(String(opts.body)) as Record<string, unknown>;
          return {
            statusCode: 200,
            data: fixture,
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        });

      const adapter = new TongyiAdapter(
        {
          apiKey: 'test-tongyi-secret',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-plus',
          searchStrategy: 'pro',
        },
        httpClient,
      );

      expect(adapter.isConfigured()).toBe(true);
      const ctx = makeContext('tongyi');
      const result = await adapter.collect(ctx);

      expect(capturedAuth).toBe('Bearer test-tongyi-secret');
      expect(capturedBody).toEqual({
        model: 'qwen-plus',
        messages: [{ role: 'user', content: ctx.prompt }],
        temperature: 0.2,
        stream: false,
        enable_search: true,
        search_options: {
          enable_source: true,
          enable_citation: true,
          forced_search: true,
          search_strategy: 'pro',
        },
      });

      expect(result.answerText).toContain('钉钉宜搭CRM');
      expect(result.citations).toEqual([
        {
          url: 'https://example.com/tongyi/crm-1?spm=dashscope',
          title: '中小企业CRM排行榜',
          snippet: '综合易用性、钉钉协同与移动端支持评选。',
          position: 1,
        },
        {
          url: 'https://example.com/tongyi/crm-2',
          title: 'CRM实施避坑指南',
          snippet: '知乎专栏',
          position: 2,
        },
      ]);
      expect(result.fanOutQueries).toEqual(['2026 CRM系统排名', '国产CRM优缺点']);
      expect(result.rawMeta).toEqual({
        provider: 'aliyun-dashscope',
        model: 'qwen-plus',
        upstreamRequestId: 'chatcmpl-tongyi-001',
        tokensIn: 112,
        tokensOut: 310,
      });

      const normalized = normalizeResponse({
        result,
        prompt: ctx.prompt,
        meta: {
          engine: 'tongyi',
          region: 'domestic',
          requestId: ctx.requestId,
          latencyMs: 130,
          attempts: 1,
          cached: false,
        },
      });
      expect(() => collectResponseSchema.parse(normalized)).not.toThrow();
    });

    it('falls back to message-level search_info when top-level search_info is absent', async () => {
      mockAgent
        .get('https://dashscope.aliyuncs.com')
        .intercept({ path: '/compatible-mode/v1/chat/completions', method: 'POST' })
        .reply(
          200,
          {
            id: 'chatcmpl-tongyi-msg-level',
            model: 'qwen-plus',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '消息级 search_info 回答。',
                  search_info: {
                    search_results: [
                      {
                        url: 'https://example.com/msg-level',
                        title: '消息级来源',
                        site_name: '阿里云社区',
                      },
                    ],
                    search_queries: ['消息级查询词'],
                  },
                },
              },
            ],
          },
          { headers: { 'content-type': 'application/json' } },
        );

      const adapter = new TongyiAdapter(
        {
          apiKey: 'test-tongyi-secret',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-plus',
          searchStrategy: 'standard',
        },
        httpClient,
      );

      const result = await adapter.collect(makeContext('tongyi'));
      expect(result.citations).toEqual([
        {
          url: 'https://example.com/msg-level',
          title: '消息级来源',
          snippet: '阿里云社区',
        },
      ]);
      expect(result.fanOutQueries).toEqual(['消息级查询词']);
    });

    it('extracts citations and queries from message.search_info when top-level search_info has empty arrays', async () => {
      mockAgent
        .get('https://dashscope.aliyuncs.com')
        .intercept({ path: '/compatible-mode/v1/chat/completions', method: 'POST' })
        .reply(
          200,
          {
            id: 'chatcmpl-tongyi-empty-top',
            model: 'qwen-plus',
            search_info: {
              search_results: [],
              search_queries: [],
            },
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '顶层数组为空但消息级有引用。',
                  search_info: {
                    search_results: [
                      {
                        url: 'https://example.com/msg-fallback',
                        title: '消息级回退来源',
                        site_name: '通义文档',
                      },
                    ],
                    search_queries: ['消息级回退查询'],
                  },
                },
              },
            ],
          },
          { headers: { 'content-type': 'application/json' } },
        );

      const adapter = new TongyiAdapter(
        {
          apiKey: 'test-tongyi-secret',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-plus',
          searchStrategy: 'standard',
        },
        httpClient,
      );

      const result = await adapter.collect(makeContext('tongyi'));
      expect(result.citations).toEqual([
        {
          url: 'https://example.com/msg-fallback',
          title: '消息级回退来源',
          snippet: '通义文档',
        },
      ]);
      expect(result.fanOutQueries).toEqual(['消息级回退查询']);
    });

    it('maps upstream HTTP 401 to 503 UPSTREAM_AUTH_OR_QUOTA', async () => {
      mockAgent
        .get('https://dashscope.aliyuncs.com')
        .intercept({ path: '/compatible-mode/v1/chat/completions', method: 'POST' })
        .reply(401, { message: 'InvalidApiKey' });

      const adapter = new TongyiAdapter(
        {
          apiKey: 'bad-key',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-plus',
          searchStrategy: 'standard',
        },
        httpClient,
      );

      await expect(adapter.collect(makeContext('tongyi'))).rejects.toMatchObject({
        statusCode: 503,
        code: 'UPSTREAM_AUTH_OR_QUOTA',
        retryable: false,
      });
    });
  });

  describe('ZhipuAdapter', () => {
    it('sends POST /api/paas/v4/chat/completions with tools[web_search] (string count "10") and parses fixture', async () => {
      const fixture = loadFixture('zhipu');
      let capturedAuth: string | undefined;
      let capturedBody: Record<string, unknown> | undefined;

      mockAgent
        .get('https://open.bigmodel.cn')
        .intercept({ path: '/api/paas/v4/chat/completions', method: 'POST' })
        .reply((opts) => {
          const headers = opts.headers as Record<string, string>;
          capturedAuth = headers['authorization'] ?? headers['Authorization'];
          capturedBody = JSON.parse(String(opts.body)) as Record<string, unknown>;
          return {
            statusCode: 200,
            data: fixture,
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        });

      const adapter = new ZhipuAdapter(
        {
          apiKey: 'test-zhipu-secret',
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          model: 'glm-4-plus',
          searchEngine: 'search_pro',
        },
        httpClient,
      );

      expect(adapter.isConfigured()).toBe(true);
      const ctx = makeContext('zhipu');
      const result = await adapter.collect(ctx);

      expect(capturedAuth).toBe('Bearer test-zhipu-secret');
      expect(capturedBody).toEqual({
        model: 'glm-4-plus',
        messages: [{ role: 'user', content: ctx.prompt }],
        temperature: 0.2,
        stream: false,
        tools: [
          {
            type: 'web_search',
            web_search: {
              enable: true,
              search_engine: 'search_pro',
              search_result: true,
              count: '10',
              search_intent: false,
            },
          },
        ],
      });

      const tools = capturedBody?.['tools'] as Array<{ web_search: { count: unknown } }>;
      expect(typeof tools[0]?.web_search.count).toBe('string');

      expect(result.answerText).toContain('中小企业CRM推荐如下');
      expect(result.citations).toEqual([
        {
          url: 'https://example.com/zhipu/report-1',
          title: '2026 CRM厂商评测报告',
          snippet: '对比了客户跟进、商机预测与BI仪表盘等核心能力。',
        },
        {
          url: 'https://example.com/zhipu/lowcode-crm',
          title: '低代码CRM选型实践',
          snippet: '支持自定义字段、审批流与外部Webhook集成。',
        },
      ]);
      expect(result.fanOutQueries).toEqual([
        '中小企业 CRM 推荐 2026',
        '2026中小企业CRM选型',
        '低代码 CRM 对比',
        '低代码CRM对比',
      ]);
      expect(result.rawMeta).toEqual({
        provider: 'zhipu-bigmodel',
        model: 'glm-4-plus',
        upstreamRequestId: 'chatcmpl-zhipu-001',
        tokensIn: 105,
        tokensOut: 295,
      });

      const normalized = normalizeResponse({
        result,
        prompt: ctx.prompt,
        meta: {
          engine: 'zhipu',
          region: 'domestic',
          requestId: ctx.requestId,
          latencyMs: 140,
          attempts: 1,
          cached: false,
        },
      });
      expect(() => collectResponseSchema.parse(normalized)).not.toThrow();
    });

    it('maps upstream HTTP 401 to 503 UPSTREAM_AUTH_OR_QUOTA', async () => {
      mockAgent
        .get('https://open.bigmodel.cn')
        .intercept({ path: '/api/paas/v4/chat/completions', method: 'POST' })
        .reply(401, { error: { code: '1001', message: 'Invalid token' } });

      const adapter = new ZhipuAdapter(
        {
          apiKey: 'bad-key',
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          model: 'glm-4-plus',
          searchEngine: 'search_pro',
        },
        httpClient,
      );

      await expect(adapter.collect(makeContext('zhipu'))).rejects.toMatchObject({
        statusCode: 503,
        code: 'UPSTREAM_AUTH_OR_QUOTA',
        retryable: false,
      });
    });
  });

  describe('WenxinAdapter', () => {
    it('sends POST /v2/chat/completions with Qianfan V2 Bearer auth & web_search and parses fixture', async () => {
      const fixture = loadFixture('wenxin');
      let capturedAuth: string | undefined;
      let capturedBody: Record<string, unknown> | undefined;

      mockAgent
        .get('https://qianfan.baidubce.com')
        .intercept({ path: '/v2/chat/completions', method: 'POST' })
        .reply((opts) => {
          const headers = opts.headers as Record<string, string>;
          capturedAuth = headers['authorization'] ?? headers['Authorization'];
          capturedBody = JSON.parse(String(opts.body)) as Record<string, unknown>;
          return {
            statusCode: 200,
            data: fixture,
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        });

      const adapter = new WenxinAdapter(
        {
          apiKey: 'bce-v3/test-wenxin-secret',
          baseUrl: 'https://qianfan.baidubce.com/v2',
          model: 'ernie-4.5-turbo-128k',
        },
        httpClient,
      );

      expect(adapter.isConfigured()).toBe(true);
      const ctx = makeContext('wenxin');
      const result = await adapter.collect(ctx);

      expect(capturedAuth).toBe('Bearer bce-v3/test-wenxin-secret');
      expect(capturedBody).toEqual({
        model: 'ernie-4.5-turbo-128k',
        messages: [{ role: 'user', content: ctx.prompt }],
        temperature: 0.2,
        stream: false,
        web_search: {
          enable: true,
          enable_citation: true,
          enable_trace: true,
        },
      });

      expect(result.answerText).toContain('为中小企业挑选CRM系统时');
      expect(result.citations).toEqual([
        {
          url: 'https://example.com/wenxin/crm-overview',
          title: '2026国内CRM市场全景',
          snippet: '覆盖制造、零售与B2B企业服务行业。',
          position: 1,
        },
        {
          url: 'https://example.com/wenxin/crm-cost',
          title: 'CRM年度费用对比',
          snippet: '按坐席订阅与私有化部署成本分析。',
          position: 2,
        },
      ]);
      expect(result.fanOutQueries).toEqual([
        '国内CRM市场全景 2026',
        '中小企业CRM年度费用',
        'B2B CRM 选型',
      ]);
      expect(result.rawMeta).toEqual({
        provider: 'baidu-qianfan',
        model: 'ernie-4.5-turbo-128k',
        upstreamRequestId: 'as-wenxin-001',
        tokensIn: 118,
        tokensOut: 264,
      });

      const normalized = normalizeResponse({
        result,
        prompt: ctx.prompt,
        meta: {
          engine: 'wenxin',
          region: 'domestic',
          requestId: ctx.requestId,
          latencyMs: 115,
          attempts: 1,
          cached: false,
        },
      });
      expect(() => collectResponseSchema.parse(normalized)).not.toThrow();
    });

    it('maps upstream HTTP 401 to 503 UPSTREAM_AUTH_OR_QUOTA', async () => {
      mockAgent
        .get('https://qianfan.baidubce.com')
        .intercept({ path: '/v2/chat/completions', method: 'POST' })
        .reply(401, { error: { code: 'invalid_api_key', message: 'Unauthorized' } });

      const adapter = new WenxinAdapter(
        {
          apiKey: 'bad-key',
          baseUrl: 'https://qianfan.baidubce.com/v2',
          model: 'ernie-4.5-turbo-128k',
        },
        httpClient,
      );

      await expect(adapter.collect(makeContext('wenxin'))).rejects.toMatchObject({
        statusCode: 503,
        code: 'UPSTREAM_AUTH_OR_QUOTA',
        retryable: false,
      });
    });
  });

  describe('non-object JSON payload handling', () => {
    it('throws 502 UPSTREAM_BAD_RESPONSE (retryable) when upstream returns JSON null', async () => {
      mockAgent
        .get('https://api.deepseek.com')
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply(200, 'null', { headers: { 'content-type': 'application/json' } });

      const adapter = new DeepSeekAdapter(
        {
          apiKey: 'test-deepseek-secret',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          searchParams: { web_search: true },
        },
        httpClient,
      );

      await expect(adapter.collect(makeContext('deepseek'))).rejects.toMatchObject({
        statusCode: 502,
        code: 'UPSTREAM_BAD_RESPONSE',
        retryable: true,
      });
    });
  });
});
