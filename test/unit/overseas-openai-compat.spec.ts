import { describe, expect, it, vi } from 'vitest';
import { OpenAiCompatOverseasAdapter } from '../../src/adapters/overseas/openai-compat.adapter.js';
import { loadConfig } from '../../src/config.js';
import type { HttpClient, HttpJsonResponse } from '../../src/core/http-client.js';
import { EngineRegistry } from '../../src/core/registry.js';
import type { CollectContext } from '../../src/core/types.js';

function createMockHttpClient(payload: unknown): {
  httpClient: HttpClient;
  postJson: ReturnType<typeof vi.fn>;
} {
  const postJson = vi.fn(async (): Promise<HttpJsonResponse<unknown>> => ({
    statusCode: 200,
    headers: {},
    data: payload,
    rawBytes: 256,
  }));
  return {
    httpClient: { postJson } as unknown as HttpClient,
    postJson,
  };
}

function makeCtx(engine: CollectContext['engine']): CollectContext {
  return {
    prompt: 'Best CRM tools in 2026',
    engine,
    requestId: 'req-relay-unit-1',
    locationCode: 2840,
    languageCode: 'en',
    signal: new AbortController().signal,
    timeoutMs: 30_000,
  };
}

describe('Overseas OpenAI-compatible relay adapter & config resolution', () => {
  it('auto-selects openai_compat for all 5 overseas engines when only OVERSEAS_RELAY_* is configured', () => {
    const config = loadConfig({
      GATEWAY_API_KEYS: 'test-key-1',
      OVERSEAS_RELAY_BASE_URL: 'https://newapi.example.com/v1/',
      OVERSEAS_RELAY_API_KEY: 'sk-newapi-123',
    });

    expect(config.overseas.relay.baseUrl).toBe('https://newapi.example.com/v1');
    expect(config.overseas.engines.chatgpt.model).toBe('gpt-4o-search-preview');
    expect(config.overseas.engines.google_aio.model).toBe(config.overseas.engines.gemini.model);

    const { httpClient } = createMockHttpClient({});
    const registry = EngineRegistry.fromConfig(config, httpClient);
    const overseasStatuses = registry.getStatuses().filter((s) => s.region === 'overseas');

    expect(overseasStatuses).toHaveLength(5);
    for (const status of overseasStatuses) {
      expect(status.provider).toBe('openai_compat');
      expect(status.configured).toBe(true);
    }
  });

  it('keeps DataForSEO in auto mode when both DataForSEO and relay are configured, while honoring per-engine overrides', () => {
    const config = loadConfig({
      GATEWAY_API_KEYS: 'test-key-1',
      DATAFORSEO_LOGIN: 'user@example.com',
      DATAFORSEO_PASSWORD: 'dfs-password',
      OVERSEAS_RELAY_BASE_URL: 'https://subapi.example.com/v1',
      OVERSEAS_RELAY_API_KEY: 'sk-subapi-123',
      CHATGPT_PROVIDER: 'openai_compat',
      CHATGPT_MODEL: 'gpt-4o-online',
      GEMINI_PROVIDER: 'openai_compat',
    });

    const { httpClient } = createMockHttpClient({});
    const registry = EngineRegistry.fromConfig(config, httpClient);
    const byEngine = new Map(registry.getStatuses().map((s) => [s.engine, s]));

    expect(byEngine.get('chatgpt')?.provider).toBe('openai_compat');
    expect(byEngine.get('chatgpt')?.model).toBe('gpt-4o-online');
    expect(byEngine.get('gemini')?.provider).toBe('openai_compat');
    expect(byEngine.get('perplexity')?.provider).toBe('dataforseo');
    expect(byEngine.get('claude')?.provider).toBe('dataforseo');
    expect(byEngine.get('google_aio')?.provider).toBe('dataforseo');
  });

  it('extracts OpenAI nested url_citation annotations and merges extraBody', async () => {
    const { httpClient, postJson } = createMockHttpClient({
      id: 'chatcmpl-123',
      model: 'gpt-4o-search-preview',
      choices: [
        {
          message: {
            content: 'Top CRM options include HubSpot and Salesforce.',
            annotations: [
              {
                type: 'url_citation',
                url_citation: {
                  url: 'https://www.hubspot.com/products/crm',
                  title: 'HubSpot CRM',
                },
              },
              {
                type: 'url_citation',
                url_citation: {
                  url: 'https://www.salesforce.com/crm/',
                  title: 'Salesforce CRM',
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 18, completion_tokens: 42 },
    });

    const adapter = new OpenAiCompatOverseasAdapter(
      'chatgpt',
      {
        provider: 'openai_compat',
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'sk-test-relay',
        model: 'gpt-4o-search-preview',
        extraBody: { web_search_options: { search_context_size: 'medium' } },
      },
      httpClient,
    );

    const result = await adapter.collect(makeCtx('chatgpt'));

    expect(postJson).toHaveBeenCalledTimes(1);
    const [url, body, opts] = postJson.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { headers: Record<string, string> },
    ];
    expect(url).toBe('https://newapi.example.com/v1/chat/completions');
    expect(opts.headers['Authorization']).toBe('Bearer sk-test-relay');
    expect(body['web_search_options']).toEqual({ search_context_size: 'medium' });

    expect(result.answerText).toContain('HubSpot');
    expect(result.citations).toEqual([
      { url: 'https://www.hubspot.com/products/crm', title: 'HubSpot CRM' },
      { url: 'https://www.salesforce.com/crm/', title: 'Salesforce CRM' },
    ]);
    expect(result.rawMeta.provider).toBe('openai_compat');
    expect(result.rawMeta.tokensIn).toBe(18);
    expect(result.rawMeta.tokensOut).toBe(42);
  });

  it('extracts Perplexity/NewAPI top-level citations and Gemini grounding_metadata with google_aio placeholder marker', async () => {
    const { httpClient } = createMockHttpClient({
      id: 'chatcmpl-gem-1',
      model: 'gemini-2.5-flash',
      choices: [
        {
          message: {
            content: [{ type: 'text', text: 'AI Overview summary from Gemini relay.' }],
          },
          grounding_metadata: {
            web_search_queries: ['best crm 2026', 'sme crm comparison'],
            grounding_chunks: [
              { web: { uri: 'https://example.com/crm-2026', title: 'CRM 2026 Guide' } },
            ],
          },
        },
      ],
      citations: ['https://example.com/crm-2026', 'https://example.com/top-crm'],
      usage: { prompt_tokens: 10, completion_tokens: 25 },
    });

    const adapter = new OpenAiCompatOverseasAdapter(
      'google_aio',
      {
        provider: 'openai_compat',
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'sk-test-relay',
        model: 'gemini-2.5-flash',
        extraBody: {},
      },
      httpClient,
    );

    const result = await adapter.collect(makeCtx('google_aio'));

    expect(result.answerText).toBe('AI Overview summary from Gemini relay.');
    expect(result.citations).toEqual([
      { url: 'https://example.com/crm-2026' },
      { url: 'https://example.com/top-crm' },
    ]);
    expect(result.fanOutQueries).toEqual(['best crm 2026', 'sme crm comparison']);
    expect(result.rawMeta.provider).toBe('openai_compat');
    expect(result.rawMeta['placeholder']).toBe('gemini_openai_compat');
  });
});
