import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent } from 'undici';
import { DeepSeekAdapter } from '../../src/adapters/domestic/deepseek.adapter.js';
import { extractServerToolCallSearchInfo } from '../../src/adapters/shared/parsing.js';
import { collectResponseSchema } from '../../src/core/contract.js';
import { HttpClient } from '../../src/core/http-client.js';
import { normalizeResponse } from '../../src/core/normalizer.js';
import type { CollectContext } from '../../src/core/types.js';

function loadFixture(name: string): Record<string, unknown> {
  const raw = readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

const PROMPT = '2026 年扫地机器人推荐哪几款？';

function makeContext(): CollectContext {
  return {
    prompt: PROMPT,
    engine: 'deepseek',
    requestId: 'req-deepseek-srvtool-001',
    locationCode: 2156,
    languageCode: 'zh',
    signal: new AbortController().signal,
    timeoutMs: 10_000,
  };
}

const EXPECTED_FAN_OUT = [
  '2026 扫地机器人 推荐',
  '2026 扫地机器人 评测 排行',
  '品牌A 扫地机器人 2026 新款',
  '扫地机器人 避障 对比',
  '品牌B 扫地机器人 2026 评测',
  '品牌C 扫地机器人 2026 评测',
];

describe('extractServerToolCallSearchInfo (issue #24)', () => {
  it('returns empty info for missing / empty / malformed server_tool_calls', () => {
    for (const value of [undefined, null, [], {}, 'x', [null, 1, 'a', { calls: 'nope' }]]) {
      expect(extractServerToolCallSearchInfo(value)).toEqual({
        queries: [],
        retrievedSources: [],
        openedPages: [],
        searchCallCount: 0,
        openPageCallCount: 0,
      });
    }
  });

  it('extracts search queries in round order (sorted by index), deduped, excluding open_page', () => {
    const fixture = loadFixture('deepseek_server_tool_calls');
    const choices = fixture['choices'] as Record<string, Record<string, unknown>>[];
    const info = extractServerToolCallSearchInfo(choices[0]?.['message']?.['server_tool_calls']);

    expect(info.queries).toEqual(EXPECTED_FAN_OUT);
    expect(info.searchCallCount).toBe(3);
    expect(info.openPageCallCount).toBe(1);
    expect(info.queries).not.toContain('https://example.com/c');
  });

  it('accepts action.queries as string or array and action.query string', () => {
    const info = extractServerToolCallSearchInfo([
      { calls: [{ action: { type: 'search', queries: 'q1；q2' } }] },
      { calls: [{ action: { type: 'search', query: 'q3' } }] },
      { calls: [{ action: { type: 'search', queries: ['q1', 'Q4'] } }] },
      // Flat shape (call directly in the round list) is tolerated too.
      { action: { queries: ['q5'] } },
    ]);
    expect(info.queries).toEqual(['q1', 'q2', 'q3', 'Q4', 'q5']);
    expect(info.searchCallCount).toBe(4);
  });

  it('collects recalled sources and opened pages separately, marking recalled pages that were opened', () => {
    const info = extractServerToolCallSearchInfo([
      {
        index: 0,
        calls: [
          {
            action: { type: 'search', queries: ['a'] },
            sources: [
              {
                url: 'https://example.com/1',
                title: 'One',
                snippet: 's1',
                site_name: 'Site1',
                published_at: '2026-01-01T00:00:00+00:00',
              },
              { url: 'https://example.com/2', title: 'Two' },
              { url: 'not-a-url' },
              '...',
            ],
          },
        ],
      },
      {
        index: 1,
        calls: [
          {
            action: { type: 'open_page', url: 'https://example.com/2' },
            page: { url: 'https://example.com/2', title: 'Two (page)' },
          },
          { action: { type: 'open_page', url: 'https://example.com/9' } },
        ],
      },
    ]);

    expect(info.retrievedSources).toEqual([
      {
        url: 'https://example.com/1',
        title: 'One',
        snippet: 's1',
        siteName: 'Site1',
        publishedAt: '2026-01-01T00:00:00+00:00',
      },
      { url: 'https://example.com/2', title: 'Two', opened: true },
    ]);
    expect(info.openedPages).toEqual([
      { url: 'https://example.com/2', title: 'Two (page)', opened: true },
      { url: 'https://example.com/9', opened: true },
    ]);
    expect(info.queries).toEqual(['a']);
  });
});

describe('DeepSeekAdapter server_tool_calls (issue #24)', () => {
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

  function makeAdapter(): DeepSeekAdapter {
    return new DeepSeekAdapter(
      {
        apiKey: 'test-deepseek-secret',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        searchParams: { tools: [{ type: 'deepseek_web_search' }] },
      },
      httpClient,
    );
  }

  function mockReply(data: Record<string, unknown>): void {
    mockAgent
      .get('https://api.deepseek.com')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, data, { headers: { 'content-type': 'application/json' } });
  }

  it('surfaces fan-out queries, recalled sources and opened pages without touching citations', async () => {
    mockReply(loadFixture('deepseek_server_tool_calls'));
    const ctx = makeContext();
    const result = await makeAdapter().collect(ctx);

    // annotations → citations unchanged (2 url_citation entries only)
    expect(result.citations.map((c) => c.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
    expect(result.fanOutQueries).toEqual(EXPECTED_FAN_OUT);
    expect(result.retrievedSources?.map((s) => s.url)).toEqual([
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/d',
      'https://example.com/e?utm_source=ds',
    ]);
    expect(result.openedPages).toEqual([
      {
        url: 'https://example.com/c',
        title: '扫地机器人选购指南',
        publishedAt: '2026-03-01T08:00:00+00:00',
        opened: true,
      },
    ]);
    expect(result.rawMeta).toMatchObject({
      provider: 'deepseek',
      hasReasoning: true,
      serverToolSearchCalls: 3,
      serverToolOpenPageCalls: 1,
      serverToolSearchCount: 4,
      serverToolFetchCount: 1,
    });
    expect(result.answerText).not.toContain('内部思考链');

    const normalized = normalizeResponse({
      result,
      prompt: ctx.prompt,
      meta: {
        engine: 'deepseek',
        region: 'domestic',
        requestId: ctx.requestId,
        latencyMs: 200,
        attempts: 1,
        cached: false,
      },
    });
    expect(() => collectResponseSchema.parse(normalized)).not.toThrow();
    expect(normalized.citations).toHaveLength(2);
    expect(normalized.fanOutQueries).toEqual(EXPECTED_FAN_OUT);

    const retrieved = normalized.rawMeta.retrievedSources ?? [];
    expect(retrieved.map((s) => s.url)).toEqual([
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/d',
      'https://example.com/e',
    ]);
    expect(retrieved[0]).toMatchObject({
      title: '2026 扫地机器人评测排行',
      siteName: '评测站B',
      publishedAt: '2026-04-27T16:00:00+00:00',
      position: 1,
    });
    expect(retrieved.filter((s) => s.opened === true).map((s) => s.url)).toEqual([
      'https://example.com/c',
    ]);
    expect(normalized.rawMeta.openedPages).toEqual([
      {
        url: 'https://example.com/c',
        title: '扫地机器人选购指南',
        publishedAt: '2026-03-01T08:00:00+00:00',
        opened: true,
        position: 1,
      },
    ]);
  });

  it('keeps existing behaviour when server_tool_calls is absent or empty', async () => {
    const base = {
      id: 'chatcmpl-deepseek-plain',
      model: 'deepseek-chat',
      choices: [
        {
          message: {
            content: '普通回答',
            annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.com/x' } }],
            server_tool_calls: [],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    };
    mockReply(base);
    const result = await makeAdapter().collect(makeContext());

    expect(result.citations.map((c) => c.url)).toEqual(['https://example.com/x']);
    expect(result.fanOutQueries).toEqual([]);
    expect(result.retrievedSources).toBeUndefined();
    expect(result.openedPages).toBeUndefined();
    expect(result.rawMeta).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      upstreamRequestId: 'chatcmpl-deepseek-plain',
      tokensIn: 1,
      tokensOut: 2,
      hasReasoning: false,
    });

    const normalized = normalizeResponse({
      result,
      prompt: PROMPT,
      meta: {
        engine: 'deepseek',
        region: 'domestic',
        requestId: 'r',
        latencyMs: 1,
        attempts: 1,
        cached: false,
      },
    });
    expect(normalized.rawMeta.retrievedSources).toBeUndefined();
    expect(normalized.rawMeta.openedPages).toBeUndefined();
  });
});
