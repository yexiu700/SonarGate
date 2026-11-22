import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekAdapter } from '../../src/adapters/domestic/deepseek.adapter.js';
import { DoubaoAdapter } from '../../src/adapters/domestic/doubao.adapter.js';
import {
  DATAFORSEO_ENDPOINTS,
  createDataForSeoAdapters,
} from '../../src/adapters/overseas/dataforseo.adapter.js';
import { parseGoogleAioResult } from '../../src/adapters/overseas/dataforseo.parsers.js';
import { OpenAiCompatOverseasAdapter } from '../../src/adapters/overseas/openai-compat.adapter.js';
import { buildCacheKey } from '../../src/core/cache.js';
import { collectRequestSchema, collectResponseSchema } from '../../src/core/contract.js';
import { HttpClient, type HttpJsonResponse } from '../../src/core/http-client.js';
import {
  canonicalizeLocale,
  locationCodeToRegion,
  normalizeRegionCode,
  parseLocaleParts,
  regionToLocationCode,
  resolveGeoContext,
} from '../../src/core/locale.js';
import {
  normalizeCitations,
  normalizeFanOutQueries,
  normalizeResponse,
  normalizeUrl,
  splitFanOutQueryString,
} from '../../src/core/normalizer.js';
import type { CollectContext } from '../../src/core/types.js';

function createMockHttpClient(payload: unknown): {
  httpClient: HttpClient;
  postJson: ReturnType<typeof vi.fn>;
} {
  const postJson = vi.fn(async (): Promise<HttpJsonResponse<unknown>> => ({
    statusCode: 200,
    headers: {},
    data: payload,
    rawBytes: 512,
  }));
  return {
    httpClient: { postJson } as unknown as HttpClient,
    postJson,
  };
}

function makeCtx(
  engine: CollectContext['engine'],
  overrides: Partial<CollectContext> = {},
): CollectContext {
  return {
    prompt: 'Best enterprise CRM platforms 2026',
    engine,
    requestId: `req-${engine}-16`,
    locationCode: 2840,
    languageCode: 'en',
    signal: new AbortController().signal,
    timeoutMs: 15_000,
    ...overrides,
  };
}

describe('Issue #16: Redirect URL unwrapping, citation enrichment, and fanOutQueries splitting', () => {
  it('unwraps common search & social redirect URLs deterministically and strips tracking params', () => {
    const bingTarget = Buffer.from(
      'https://docs.example.com/crm/pricing?plan=pro&utm_medium=bing&srsltid=abc123',
      'utf8',
    ).toString('base64url');

    expect(
      normalizeUrl(
        'https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fcrm%3Fid%3D7%26utm_source%3Dgoogle%26gclid%3Dxyz&sa=U',
      ),
    ).toBe('https://example.com/crm?id=7');

    expect(
      normalizeUrl(
        'https://www.google.co.jp/url?url=https%3A%2F%2Fjp.example.com%2Fguide%3Fmc_cid%3D99%26lang%3Dja',
      ),
    ).toBe('https://jp.example.com/guide?lang=ja');

    expect(
      normalizeUrl('https://www.google.com/amp/s/blog.example.com/crm-2026?utm_campaign=amp'),
    ).toBe('https://blog.example.com/crm-2026');

    expect(normalizeUrl(`https://www.bing.com/ck/a?!&&p=123&u=a1${bingTarget}&ntb=1`)).toBe(
      'https://docs.example.com/crm/pricing?plan=pro',
    );

    expect(
      normalizeUrl(
        'https://link.zhihu.com/?target=https%3A%2F%2Fzhuanlan.example.cn%2Farticle%3Fspm%3Da1%26page%3D2',
      ),
    ).toBe('https://zhuanlan.example.cn/article?page=2');

    expect(
      normalizeUrl(
        'https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.org%2Freport%3Ffbclid%3D123%26_hsenc%3D456%26ref_src%3Dtw',
      ),
    ).toBe('https://example.org/report');

    expect(
      normalizeUrl(
        'https://www.youtube.com/redirect?q=https%3A%2F%2Fvendor.example.com%2Fdemo%3Figshid%3Dabc',
      ),
    ).toBe('https://vendor.example.com/demo');

    expect(
      normalizeUrl(
        'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.net%2Fdocs%3Fyclid%3D77%26v%3D2',
      ),
    ).toBe('https://example.net/docs?v=2');

    expect(
      normalizeUrl(
        'https://weibo.cn/sinaurl?u=https%3A%2F%2Fexample.cn%2Fnews%3Ffrom_source%3Dwb%26id%3D9',
      ),
    ).toBe('https://example.cn/news?id=9');
  });

  it('unwraps multi-hop redirect chains, preserves opaque token redirects, and refuses unsafe redirect targets', () => {
    const inner = encodeURIComponent(
      'https://l.facebook.com/l.php?u=' +
        encodeURIComponent('https://target.example.com/final?utm_source=fb&k=1'),
    );
    expect(normalizeUrl(`https://www.google.com/url?q=${inner}`)).toBe(
      'https://target.example.com/final?k=1',
    );

    // Opaque Grounding API redirects have no target query param and must be preserved intact
    const opaqueVertex =
      'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE1234567890abcdef';
    expect(normalizeUrl(opaqueVertex)).toBe(opaqueVertex);

    // Unsafe javascript: redirect target must never be unwrapped to a javascript: URL
    const unsafeWrapped = normalizeUrl('https://www.google.com/url?q=javascript%3Aalert(1)');
    expect(unsafeWrapped === null || !unsafeWrapped.startsWith('javascript:')).toBe(true);
  });

  it('enriches duplicate normalized citation URLs with missing title/snippet without overwriting existing metadata', () => {
    const normalized = normalizeCitations([
      {
        url: 'https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fcrm%3Futm_source%3Dtest',
      },
      {
        url: 'https://example.com/crm?fbclid=dup',
        title: 'Enterprise CRM Guide',
        snippet: 'Detailed pricing and feature breakdown.',
      },
      {
        url: 'https://example.com/crm',
        title: 'Should Not Overwrite Title',
        snippet: 'Should Not Overwrite Snippet',
      },
    ]);

    expect(normalized).toEqual([
      {
        url: 'https://example.com/crm',
        title: 'Enterprise CRM Guide',
        snippet: 'Detailed pricing and feature breakdown.',
        position: 1,
      },
    ]);
  });

  it('splits semicolon, full-width semicolon, and newline-concatenated fanOutQueries cleanly', () => {
    expect(
      splitFanOutQueryString('  2026 CRM对比;  轻量级CRM推荐；\n企业微信集成\r\n  SaaS   定价  '),
    ).toEqual(['2026 CRM对比', '轻量级CRM推荐', '企业微信集成', 'SaaS 定价']);

    const cleaned = normalizeFanOutQueries(
      [
        'best enterprise crm platforms 2026; HubSpot vs Salesforce；Zoho CRM pricing\nPipedrive review',
        'hubspot vs salesforce',
      ],
      'Best enterprise CRM platforms 2026',
    );
    expect(cleaned).toEqual(['HubSpot vs Salesforce', 'Zoho CRM pricing', 'Pipedrive review']);
  });
});

describe('Issue #16: Locale / Region / Market validation, resolution, and cache key isolation', () => {
  it('canonicalizes locales, normalizes region aliases, and resolves GeoContext accurately', () => {
    expect(canonicalizeLocale('zh_cn')).toBe('zh-CN');
    expect(canonicalizeLocale('zh-hans-cn')).toBe('zh-Hans-CN');
    expect(canonicalizeLocale('en-uk')).toBe('en-GB');
    expect(normalizeRegionCode('uk')).toBe('GB');
    expect(parseLocaleParts('de_de')).toEqual({ locale: 'de-DE', language: 'de', region: 'DE' });
    expect(regionToLocationCode('JP')).toBe(2392);
    expect(locationCodeToRegion(2276)).toBe('DE');

    const defaults = { locationCode: 2840, languageCode: 'en', countryIso: 'US' };

    // Default call with no market/locale/region preserves backward compatibility
    expect(resolveGeoContext({}, defaults)).toEqual({
      locationCode: 2840,
      languageCode: 'en',
      countryIso: 'US',
    });

    // Global locale de-DE derives locationCode 2276, language 'de', region 'DE'
    expect(resolveGeoContext({ market: 'GLOBAL', locale: 'de-DE' }, defaults)).toEqual({
      locationCode: 2276,
      languageCode: 'de',
      countryIso: 'DE',
      market: 'GLOBAL',
      locale: 'de-DE',
      region: 'DE',
    });

    // Explicit region overrides locale region
    expect(resolveGeoContext({ locale: 'en-US', region: 'JP' }, defaults)).toEqual({
      locationCode: 2392,
      languageCode: 'en',
      countryIso: 'JP',
      locale: 'en-US',
      region: 'JP',
    });

    // Market CN without explicit locale/region derives CN/zh/2156
    expect(resolveGeoContext({ market: 'CN' }, defaults)).toEqual({
      locationCode: 2156,
      languageCode: 'zh',
      countryIso: 'CN',
      market: 'CN',
      region: 'CN',
    });
  });

  it('validates optional market, locale, and region fields in collectRequestSchema', () => {
    const valid = collectRequestSchema.parse({
      engine: 'perplexity',
      prompt: 'best crm tools',
      market: 'global',
      locale: 'ja_jp',
      region: 'jp',
    });
    expect(valid.market).toBe('GLOBAL');
    expect(valid.locale).toBe('ja-JP');
    expect(valid.region).toBe('JP');

    expect(
      collectRequestSchema.safeParse({ engine: 'chatgpt', prompt: 'hi', market: 'EU' }).success,
    ).toBe(false);
    expect(
      collectRequestSchema.safeParse({ engine: 'chatgpt', prompt: 'hi', region: 'USA' }).success,
    ).toBe(false);
    expect(
      collectRequestSchema.safeParse({ engine: 'chatgpt', prompt: 'hi', locale: 'not valid!' })
        .success,
    ).toBe(false);
  });

  it('isolates cache keys across market/locale/region while preserving legacy hash when omitted', () => {
    const legacyKey = buildCacheKey('chatgpt', 'best crm', 2840, 'en');
    const omittedGeoKey = buildCacheKey('chatgpt', 'best crm', 2840, 'en', {});
    expect(omittedGeoKey).toBe(legacyKey);

    const usKey = buildCacheKey('chatgpt', 'best crm', 2840, 'en', {
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
    });
    const deKey = buildCacheKey('chatgpt', 'best crm', 2276, 'de', {
      market: 'GLOBAL',
      locale: 'de-DE',
      region: 'DE',
    });
    const jpKey = buildCacheKey('chatgpt', 'best crm', 2392, 'ja', {
      market: 'GLOBAL',
      locale: 'ja-JP',
      region: 'JP',
    });

    expect(new Set([legacyKey, usKey, deKey, jpKey]).size).toBe(4);
  });
});

describe('Issue #16: Overseas 5 engines + DeepSeek + Doubao structured citations & fanOutQueries', () => {
  it('perplexity openai_compat injects search defaults, forwards locale/region, and extracts search_results + related_questions', async () => {
    const { httpClient, postJson } = createMockHttpClient({
      id: 'pplx-001',
      model: 'sonar-pro',
      choices: [{ message: { content: 'Perplexity grounded CRM answer.' } }],
      citations: [
        'https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fcrm-1%3Futm_source%3Dpplx',
        'https://example.com/crm-2',
      ],
      search_results: [
        {
          url: 'https://example.com/crm-1',
          title: 'CRM Benchmark 2026',
          snippet: 'Independent comparison of SMB CRM suites.',
        },
      ],
      related_questions: ['HubSpot pricing 2026; Salesforce starter tier', 'Best CRM for startups'],
      usage: { prompt_tokens: 20, completion_tokens: 80 },
    });

    const adapter = new OpenAiCompatOverseasAdapter(
      'perplexity',
      {
        provider: 'openai_compat',
        baseUrl: 'https://relay.example.com/v1',
        apiKey: 'sk-relay',
        model: 'sonar-pro',
        extraBody: {},
      },
      httpClient,
    );

    const result = await adapter.collect(
      makeCtx('perplexity', {
        market: 'GLOBAL',
        locale: 'de-DE',
        region: 'DE',
        locationCode: 2276,
        languageCode: 'de',
      }),
    );

    const [, body, opts] = postJson.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { headers: Record<string, string> },
    ];
    expect(body['return_related_questions']).toBe(true);
    expect(body['web_search_options']).toEqual({ user_location: { country: 'DE' } });
    expect(opts.headers['Accept-Language']).toBe('de-DE');

    const normalized = normalizeResponse({
      result,
      prompt: 'Best enterprise CRM platforms 2026',
      meta: {
        engine: 'perplexity',
        region: 'overseas',
        requestId: 'req-pplx',
        latencyMs: 100,
        attempts: 1,
        cached: false,
      },
    });

    expect(normalized.citations).toEqual([
      {
        url: 'https://example.com/crm-1',
        title: 'CRM Benchmark 2026',
        snippet: 'Independent comparison of SMB CRM suites.',
        position: 1,
      },
      {
        url: 'https://example.com/crm-2',
        position: 2,
      },
    ]);
    expect(normalized.fanOutQueries).toEqual([
      'HubSpot pricing 2026',
      'Salesforce starter tier',
      'Best CRM for startups',
    ]);
  });

  it('chatgpt openai_compat parses Responses API output[] (web_search_call + annotations) and forwards user_location', async () => {
    const { httpClient, postJson } = createMockHttpClient({
      id: 'resp-chatgpt-1',
      model: 'gpt-4o-search-preview',
      output: [
        {
          type: 'web_search_call',
          action: {
            query: 'best crm uk 2026; hubspot uk pricing',
            sources: [{ url: 'https://hubspot.com/uk/crm', title: 'HubSpot UK' }],
          },
        },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'ChatGPT UK grounded CRM summary.',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://pipedrive.com/uk',
                  title: 'Pipedrive UK',
                },
              ],
            },
          ],
        },
      ],
      usage: { input_tokens: 30, output_tokens: 90 },
    });

    const adapter = new OpenAiCompatOverseasAdapter(
      'chatgpt',
      {
        provider: 'openai_compat',
        baseUrl: 'https://relay.example.com/v1',
        apiKey: 'sk-relay',
        model: 'gpt-4o-search-preview',
        extraBody: {},
      },
      httpClient,
    );

    const result = await adapter.collect(
      makeCtx('chatgpt', { locale: 'en-GB', region: 'GB', locationCode: 2826, languageCode: 'en' }),
    );

    const [, body] = postJson.mock.calls[0] as [string, Record<string, unknown>];
    expect(body['web_search_options']).toEqual({
      user_location: { type: 'approximate', approximate: { country: 'GB' } },
    });
    expect(result.answerText).toBe('ChatGPT UK grounded CRM summary.');
    expect(result.citations.map((c) => c.url)).toEqual([
      'https://hubspot.com/uk/crm',
      'https://pipedrive.com/uk',
    ]);
    expect(result.fanOutQueries).toEqual(['best crm uk 2026', 'hubspot uk pricing']);
    expect(result.rawMeta.tokensIn).toBe(30);
    expect(result.rawMeta.tokensOut).toBe(90);
  });

  it('gemini openai_compat extracts camelCase groundingMetadata + groundingSupports snippets', async () => {
    const { httpClient } = createMockHttpClient({
      id: 'gem-camel-1',
      model: 'gemini-2.5-flash',
      candidates: [
        {
          content: { parts: [{ text: 'Gemini grounded answer with vector search details.' }] },
          groundingMetadata: {
            webSearchQueries: ['vector database benchmark 2026', 'qdrant vs milvus'],
            groundingChunks: [
              { web: { uri: 'https://qdrant.tech/benchmarks', title: 'Qdrant Benchmarks' } },
            ],
            groundingSupports: [
              {
                segment: { text: 'Qdrant achieves sub-10ms P95 latency on 10M vectors.' },
                groundingChunkIndices: [0],
              },
            ],
          },
        },
      ],
    });

    const adapter = new OpenAiCompatOverseasAdapter(
      'gemini',
      {
        provider: 'openai_compat',
        baseUrl: 'https://relay.example.com/v1',
        apiKey: 'sk-relay',
        model: 'gemini-2.5-flash',
        extraBody: {},
      },
      httpClient,
    );

    const result = await adapter.collect(makeCtx('gemini'));
    expect(result.answerText).toBe('Gemini grounded answer with vector search details.');
    expect(result.citations).toEqual([
      {
        url: 'https://qdrant.tech/benchmarks',
        title: 'Qdrant Benchmarks',
        snippet: 'Qdrant achieves sub-10ms P95 latency on 10M vectors.',
      },
    ]);
    expect(result.fanOutQueries).toEqual(['vector database benchmark 2026', 'qdrant vs milvus']);
  });

  it('claude openai_compat extracts server_tool_use queries, web_search_tool_result & text citations while excluding thinking blocks', async () => {
    const { httpClient } = createMockHttpClient({
      id: 'msg-claude-1',
      model: 'claude-sonnet-4-5',
      content: [
        { type: 'thinking', text: 'HIDDEN_CLAUDE_THINKING' },
        {
          type: 'server_tool_use',
          name: 'web_search',
          input: { query: 'best typescript framework 2026; fastify benchmarks' },
        },
        {
          type: 'web_search_tool_result',
          content: [
            {
              url: 'https://fastify.dev/benchmarks',
              title: 'Fastify Benchmarks',
              snippet: 'High-throughput Node.js web framework.',
            },
          ],
        },
        {
          type: 'text',
          text: 'Fastify and Hono lead TypeScript HTTP benchmarks in 2026.',
          citations: [
            {
              url: 'https://hono.dev/',
              title: 'Hono Web Framework',
              cited_text: 'Ultrafast web framework for the Edges.',
            },
          ],
        },
      ],
      usage: { input_tokens: 40, output_tokens: 65 },
    });

    const adapter = new OpenAiCompatOverseasAdapter(
      'claude',
      {
        provider: 'openai_compat',
        baseUrl: 'https://relay.example.com/v1',
        apiKey: 'sk-relay',
        model: 'claude-sonnet-4-5',
        extraBody: {},
      },
      httpClient,
    );

    const result = await adapter.collect(makeCtx('claude'));
    expect(result.answerText).toBe('Fastify and Hono lead TypeScript HTTP benchmarks in 2026.');
    expect(result.answerText).not.toContain('HIDDEN_CLAUDE_THINKING');
    expect(result.citations).toEqual([
      {
        url: 'https://fastify.dev/benchmarks',
        title: 'Fastify Benchmarks',
        snippet: 'High-throughput Node.js web framework.',
      },
      {
        url: 'https://hono.dev/',
        title: 'Hono Web Framework',
        snippet: 'Ultrafast web framework for the Edges.',
      },
    ]);
    expect(result.fanOutQueries).toEqual(['best typescript framework 2026', 'fastify benchmarks']);
  });

  it('google_aio DataForSEO parser extracts related_searches and people_also_ask as fanOutQueries', () => {
    const parsed = parseGoogleAioResult({
      items: [
        {
          type: 'ai_overview',
          markdown: 'AI Overview explanation of GEO.',
          references: [
            {
              url: 'https://www.google.com/url?q=https%3A%2F%2Farxiv.org%2Fabs%2F2311.09735',
              title: 'GEO Paper',
              text: 'Academic study on generative engine optimization.',
            },
          ],
        },
        {
          type: 'related_searches',
          items: ['generative engine optimization tools; ai search visibility'],
        },
        {
          type: 'people_also_ask',
          items: [{ title: 'How does GEO differ from SEO?' }],
        },
      ],
    });

    expect(parsed.rawMeta.aiOverviewTriggered).toBe(true);
    expect(parsed.citations).toHaveLength(1);
    expect(parsed.fanOutQueries).toEqual([
      'generative engine optimization tools',
      'ai search visibility',
      'How does GEO differ from SEO?',
    ]);
  });

  it('DeepSeekAdapter extracts nested url_citation, search_info, search_trace, and tool_calls while splitting semicolon queries', async () => {
    const { httpClient } = createMockHttpClient({
      id: 'chatcmpl-ds-rich',
      model: 'deepseek-r1',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'DeepSeek 综合分析结果。',
            reasoning_content: 'INTERNAL_REASONING_HIDDEN',
            annotations: [
              {
                type: 'url_citation',
                url_citation: {
                  url: 'https://link.zhihu.com/?target=https%3A%2F%2Fexample.cn%2Fds-1%3Futm_source%3Dds',
                  title: 'DeepSeek 引用 1',
                  snippet: '核心摘要',
                },
              },
            ],
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'web_search',
                  arguments: JSON.stringify({ query: '国产CRM对比; 企微CRM方案' }),
                },
              },
            ],
          },
        },
      ],
      search_info: {
        search_results: [
          { url: 'https://example.cn/ds-2', title: 'DeepSeek 搜索结果 2', summary: '结果摘要' },
        ],
        search_queries: ['中小企业CRM价格'],
      },
      search_trace: [{ keyword: 'CRM部署成本' }],
      usage: { prompt_tokens: 50, completion_tokens: 120 },
    });

    const adapter = new DeepSeekAdapter(
      {
        apiKey: 'sk-ds',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-r1',
        searchParams: { web_search: true },
      },
      httpClient,
    );

    const result = await adapter.collect(makeCtx('deepseek', { prompt: 'CRM推荐' }));
    expect(result.answerText).toBe('DeepSeek 综合分析结果。');
    expect(result.answerText).not.toContain('INTERNAL_REASONING_HIDDEN');
    expect(result.rawMeta.hasReasoning).toBe(true);
    expect(result.fanOutQueries).toEqual([
      '中小企业CRM价格',
      'CRM部署成本',
      '国产CRM对比',
      '企微CRM方案',
    ]);

    const normalized = normalizeResponse({
      result,
      prompt: 'CRM推荐',
      meta: {
        engine: 'deepseek',
        region: 'domestic',
        requestId: 'req-ds-16',
        latencyMs: 90,
        attempts: 1,
        cached: false,
      },
    });
    expect(collectResponseSchema.parse(normalized).citations).toEqual([
      {
        url: 'https://example.cn/ds-2',
        title: 'DeepSeek 搜索结果 2',
        snippet: '结果摘要',
        position: 1,
      },
      {
        url: 'https://example.cn/ds-1',
        title: 'DeepSeek 引用 1',
        snippet: '核心摘要',
        position: 2,
      },
    ]);
  });

  describe('DataForSEO region override & Doubao semicolon query splitting', () => {
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

    it('forwards ctx.region to DataForSEO web_search_country_iso_code on perplexity and claude', async () => {
      let capturedPerplexityBody = '';
      mockAgent
        .get('https://api.dataforseo.com')
        .intercept({ path: DATAFORSEO_ENDPOINTS.perplexity, method: 'POST' })
        .reply((opts) => {
          capturedPerplexityBody = String(opts.body ?? '');
          return {
            statusCode: 200,
            data: JSON.stringify({
              status_code: 20000,
              status_message: 'Ok.',
              cost: 0.005,
              tasks: [
                {
                  id: 't-de-1',
                  status_code: 20000,
                  status_message: 'Ok.',
                  cost: 0.005,
                  result: [
                    {
                      model_name: 'sonar',
                      items: [
                        {
                          type: 'message',
                          sections: [{ type: 'text', text: 'Deutsch CRM Ergebnis.' }],
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        });

      const adapters = createDataForSeoAdapters({
        config: {
          login: 'u@example.com',
          password: 'pw',
          baseUrl: 'https://api.dataforseo.com',
          locationCode: 2840,
          languageCode: 'en',
          countryIso: 'US',
          perplexityModel: 'sonar',
          claudeModel: 'claude-sonnet-4-5',
          geminiMode: 'responses',
          geminiModel: 'gemini-2.5-flash',
        },
        httpClient,
      });

      const perplexity = adapters.find((a) => a.engine === 'perplexity')!;
      await perplexity.collect(
        makeCtx('perplexity', {
          locale: 'de-DE',
          region: 'DE',
          locationCode: 2276,
          languageCode: 'de',
        }),
      );

      expect(JSON.parse(capturedPerplexityBody)).toEqual([
        {
          user_prompt: 'Best enterprise CRM platforms 2026',
          model_name: 'sonar',
          web_search: true,
          web_search_country_iso_code: 'DE',
        },
      ]);
    });

    it('DoubaoAdapter splits semicolon-concatenated web_search_call queries into standalone fanOutQueries', async () => {
      mockAgent
        .get('https://ark.cn-beijing.volces.com')
        .intercept({ path: '/api/v3/responses', method: 'POST' })
        .reply(
          200,
          {
            id: 'resp_split_001',
            model: 'ep-doubao-test',
            output: [
              {
                type: 'web_search_call',
                action: {
                  query: '2026 CRM排行; 轻量CRM推荐；企业微信CRM\nSaaS定价',
                },
              },
              {
                type: 'message',
                content: [{ type: 'output_text', text: '豆包拆分查询词测试回答。' }],
              },
            ],
          },
          { headers: { 'content-type': 'application/json' } },
        );

      const adapter = new DoubaoAdapter(
        {
          apiKey: 'sk-doubao',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
          model: 'ep-doubao-test',
          extraBody: {},
        },
        httpClient,
      );

      const result = await adapter.collect(makeCtx('doubao', { prompt: 'CRM推荐' }));
      expect(result.fanOutQueries).toEqual([
        '2026 CRM排行',
        '轻量CRM推荐',
        '企业微信CRM',
        'SaaS定价',
      ]);
    });
  });
});
