import { readFileSync } from 'node:fs';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DATAFORSEO_ENDPOINTS,
  createDataForSeoAdapters,
} from '../../src/adapters/overseas/dataforseo.adapter.js';
import type { DataForSeoConfig } from '../../src/adapters/overseas/dataforseo.client.js';
import {
  NO_AI_OVERVIEW_TEXT,
  parseChatGptResult,
  parseGoogleAioResult,
  parseLlmResponsesResult,
} from '../../src/adapters/overseas/dataforseo.parsers.js';
import { collectResponseSchema, type SupportedEngine } from '../../src/core/contract.js';
import { GatewayError } from '../../src/core/errors.js';
import { HttpClient } from '../../src/core/http-client.js';
import { normalizeResponse } from '../../src/core/normalizer.js';
import type { CollectContext, EngineAdapter, LoggerLike } from '../../src/core/types.js';

const TEST_BASE_URL = 'https://api.dataforseo.com';
const TEST_LOGIN = 'user@example.com';
const TEST_PASSWORD = 'super-secret-password';
const EXPECTED_BASIC_AUTH = `Basic ${Buffer.from(`${TEST_LOGIN}:${TEST_PASSWORD}`, 'utf8').toString('base64')}`;

function loadFixture(filename: string): Record<string, unknown> {
  const raw = readFileSync(new URL(`../fixtures/${filename}`, import.meta.url), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function makeConfig(overrides: Partial<DataForSeoConfig> = {}): DataForSeoConfig {
  return {
    login: TEST_LOGIN,
    password: TEST_PASSWORD,
    baseUrl: TEST_BASE_URL,
    locationCode: 2840,
    languageCode: 'en',
    countryIso: 'US',
    perplexityModel: 'sonar',
    claudeModel: 'claude-sonnet-4-5',
    geminiMode: 'scraper',
    geminiModel: 'gemini-2.5-flash',
    ...overrides,
  };
}

function makeContext(engine: SupportedEngine, prompt = 'best crm software 2026'): CollectContext {
  return {
    prompt,
    engine,
    requestId: `req-${engine}-001`,
    locationCode: 2840,
    languageCode: 'en',
    signal: new AbortController().signal,
    timeoutMs: 10_000,
  };
}

function makeLogger(): {
  logger: LoggerLike;
  infoSpy: ReturnType<typeof vi.fn>;
  errorSpy: ReturnType<typeof vi.fn>;
} {
  const infoSpy = vi.fn();
  const errorSpy = vi.fn();
  const logger: LoggerLike = {
    debug: vi.fn(),
    info: infoSpy,
    warn: vi.fn(),
    error: errorSpy,
  };
  return { logger, infoSpy, errorSpy };
}

function findAdapter(adapters: EngineAdapter[], engine: SupportedEngine): EngineAdapter {
  const found = adapters.find((a) => a.engine === engine);
  if (!found) {
    throw new Error(`Adapter not found: ${engine}`);
  }
  return found;
}

describe('DataForSEO overseas adapters', () => {
  const originalDispatcher = getGlobalDispatcher();
  let mockAgent: MockAgent;

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
  });

  describe('configuration and metadata', () => {
    it('creates all 5 overseas adapters with correct metadata when configured', () => {
      const adapters = createDataForSeoAdapters({
        config: makeConfig(),
        httpClient: new HttpClient(),
      });

      expect(adapters.map((a) => a.engine)).toEqual([
        'chatgpt',
        'perplexity',
        'gemini',
        'claude',
        'google_aio',
      ]);

      for (const adapter of adapters) {
        expect(adapter.region).toBe('overseas');
        expect(adapter.provider).toBe('dataforseo');
        expect(adapter.isConfigured()).toBe(true);
      }

      expect(findAdapter(adapters, 'perplexity').model).toBe('sonar');
      expect(findAdapter(adapters, 'claude').model).toBe('claude-sonnet-4-5');
    });

    it('reports isConfigured() = false when login or password is missing', () => {
      const missingLogin = createDataForSeoAdapters({
        config: makeConfig({ login: '' }),
        httpClient: new HttpClient(),
      });
      for (const adapter of missingLogin) {
        expect(adapter.isConfigured()).toBe(false);
      }

      const missingPassword = createDataForSeoAdapters({
        config: makeConfig({ password: '   ' }),
        httpClient: new HttpClient(),
      });
      for (const adapter of missingPassword) {
        expect(adapter.isConfigured()).toBe(false);
      }
    });
  });

  describe('endpoint, Basic Auth, payload & fixture parsing for all 5 engines', () => {
    it('chatgpt: calls llm_scraper endpoint with Basic Auth and parses fixture cleanly', async () => {
      const fixture = loadFixture('chatgpt.json');
      let capturedBody = '';
      const pool = mockAgent.get(TEST_BASE_URL);
      pool
        .intercept({
          path: DATAFORSEO_ENDPOINTS.chatgpt,
          method: 'POST',
          headers: { authorization: EXPECTED_BASIC_AUTH },
        })
        .reply((opts) => {
          capturedBody = String(opts.body ?? '');
          return {
            statusCode: 200,
            data: JSON.stringify(fixture),
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        });

      const adapters = createDataForSeoAdapters({
        config: makeConfig(),
        httpClient: new HttpClient(),
      });
      const ctx = makeContext('chatgpt', 'best crm software for small business 2026');
      const result = await findAdapter(adapters, 'chatgpt').collect(ctx);

      expect(JSON.parse(capturedBody)).toEqual([
        {
          keyword: 'best crm software for small business 2026',
          location_code: 2840,
          language_code: 'en',
          force_web_search: true,
        },
      ]);

      expect(result.answerText).toContain('HubSpot CRM');
      expect(result.citations).toHaveLength(3);
      expect(result.citations.map((c) => c.url)).toEqual([
        'https://www.hubspot.com/products/crm?utm_source=chatgpt',
        'https://www.pipedrive.com/en/features',
        'https://www.zoho.com/crm/pricing.html',
      ]);
      expect(result.fanOutQueries).toEqual([
        'best crm software small business 2026',
        'hubspot vs pipedrive pricing',
      ]);
      expect(result.rawMeta.provider).toBe('dataforseo');
      expect(result.rawMeta.model).toBe('gpt-4o');
      expect(result.rawMeta.costUsd).toBe(0.0045);
      expect(result.rawMeta.upstreamRequestId).toBe('03191420-0001-0512-0000-chatgpt10001');

      const normalized = normalizeResponse({
        result,
        prompt: ctx.prompt,
        meta: {
          engine: 'chatgpt',
          region: 'overseas',
          requestId: ctx.requestId,
          latencyMs: 120,
          attempts: 1,
          cached: false,
        },
      });
      expect(collectResponseSchema.parse(normalized).citations[0]?.url).toBe(
        'https://www.hubspot.com/products/crm',
      );
    });

    it('perplexity: calls llm_responses endpoint with Basic Auth and parses sections/annotations/tokens', async () => {
      const fixture = loadFixture('perplexity.json');
      let capturedBody = '';
      const pool = mockAgent.get(TEST_BASE_URL);
      pool
        .intercept({
          path: DATAFORSEO_ENDPOINTS.perplexity,
          method: 'POST',
          headers: { authorization: EXPECTED_BASIC_AUTH },
        })
        .reply((opts) => {
          capturedBody = String(opts.body ?? '');
          return {
            statusCode: 200,
            data: JSON.stringify(fixture),
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        });

      const adapters = createDataForSeoAdapters({
        config: makeConfig(),
        httpClient: new HttpClient(),
      });
      const ctx = makeContext('perplexity', 'modern observability stack 2026');
      const result = await findAdapter(adapters, 'perplexity').collect(ctx);

      expect(JSON.parse(capturedBody)).toEqual([
        {
          user_prompt: 'modern observability stack 2026',
          model_name: 'sonar',
          web_search: true,
          web_search_country_iso_code: 'US',
        },
      ]);

      expect(result.answerText).toContain('OpenTelemetry');
      expect(result.answerText).toContain('Grafana Tempo');
      expect(result.citations).toHaveLength(3);
      expect(result.rawMeta.model).toBe('sonar');
      expect(result.rawMeta.tokensIn).toBe(120);
      expect(result.rawMeta.tokensOut).toBe(340);
      expect(result.rawMeta.costUsd).toBe(0.0062);

      const normalized = normalizeResponse({
        result,
        prompt: ctx.prompt,
        meta: {
          engine: 'perplexity',
          region: 'overseas',
          requestId: ctx.requestId,
          latencyMs: 200,
          attempts: 1,
          cached: false,
        },
      });
      expect(() => collectResponseSchema.parse(normalized)).not.toThrow();
    });

    it('gemini (default scraper mode): calls llm_scraper endpoint with Basic Auth', async () => {
      const fixture = loadFixture('gemini.json');
      let capturedBody = '';
      const pool = mockAgent.get(TEST_BASE_URL);
      pool
        .intercept({
          path: DATAFORSEO_ENDPOINTS.geminiScraper,
          method: 'POST',
          headers: { authorization: EXPECTED_BASIC_AUTH },
        })
        .reply((opts) => {
          capturedBody = String(opts.body ?? '');
          return {
            statusCode: 200,
            data: JSON.stringify(fixture),
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        });

      const adapters = createDataForSeoAdapters({
        config: makeConfig({ geminiMode: 'scraper' }),
        httpClient: new HttpClient(),
      });
      const ctx = makeContext('gemini', 'open source vector databases 2026');
      const result = await findAdapter(adapters, 'gemini').collect(ctx);

      expect(JSON.parse(capturedBody)).toEqual([
        {
          keyword: 'open source vector databases 2026',
          location_code: 2840,
          language_code: 'en',
        },
      ]);
      expect(result.answerText).toContain('Qdrant');
      expect(result.citations).toHaveLength(2);
      expect(result.fanOutQueries).toEqual([
        'open source vector databases 2026',
        'milvus vs qdrant benchmark',
      ]);
      expect(result.rawMeta.costUsd).toBe(0.0038);

      const normalized = normalizeResponse({
        result,
        prompt: ctx.prompt,
        meta: {
          engine: 'gemini',
          region: 'overseas',
          requestId: ctx.requestId,
          latencyMs: 150,
          attempts: 1,
          cached: false,
        },
      });
      expect(() => collectResponseSchema.parse(normalized)).not.toThrow();
    });

    it('gemini (responses mode & custom geminiEndpoint override): sends llm_responses payload', async () => {
      const responsesFixture = {
        version: '0.1.20260301',
        status_code: 20000,
        status_message: 'Ok.',
        cost: 0.0051,
        tasks: [
          {
            id: 'gemini-resp-001',
            status_code: 20000,
            status_message: 'Ok.',
            cost: 0.0051,
            result_count: 1,
            result: [
              {
                model_name: 'gemini-2.5-flash',
                input_tokens: 95,
                output_tokens: 210,
                items: [
                  {
                    type: 'message',
                    sections: [
                      {
                        type: 'text',
                        text: 'Gemini responses mode answer with grounding citations.',
                        annotations: [
                          {
                            url: 'https://ai.google.dev/gemini-api/docs',
                            title: 'Gemini API Docs',
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const pool = mockAgent.get(TEST_BASE_URL);
      let capturedResponsesBody = '';
      pool
        .intercept({
          path: DATAFORSEO_ENDPOINTS.geminiResponses,
          method: 'POST',
          headers: { authorization: EXPECTED_BASIC_AUTH },
        })
        .reply((opts) => {
          capturedResponsesBody = String(opts.body ?? '');
          return {
            statusCode: 200,
            data: JSON.stringify(responsesFixture),
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        });

      const responsesAdapters = createDataForSeoAdapters({
        config: makeConfig({ geminiMode: 'responses', geminiModel: 'gemini-2.5-flash' }),
        httpClient: new HttpClient(),
      });
      const geminiRespAdapter = findAdapter(responsesAdapters, 'gemini');
      expect(geminiRespAdapter.model).toBe('gemini-2.5-flash');

      const respResult = await geminiRespAdapter.collect(
        makeContext('gemini', 'compare vector databases'),
      );
      expect(JSON.parse(capturedResponsesBody)).toEqual([
        {
          user_prompt: 'compare vector databases',
          model_name: 'gemini-2.5-flash',
          web_search: true,
          web_search_country_iso_code: 'US',
        },
      ]);
      expect(respResult.rawMeta.tokensIn).toBe(95);
      expect(respResult.rawMeta.tokensOut).toBe(210);
      expect(respResult.rawMeta.model).toBe('gemini-2.5-flash');
      expect(respResult.rawMeta.costUsd).toBe(0.0051);

      // Now test custom DATAFORSEO_GEMINI_ENDPOINT override
      const customPath = '/v3/ai_optimization/gemini/llm_responses/live?custom=1';
      let capturedOverrideBody = '';
      pool
        .intercept({
          path: customPath,
          method: 'POST',
          headers: { authorization: EXPECTED_BASIC_AUTH },
        })
        .reply((opts) => {
          capturedOverrideBody = String(opts.body ?? '');
          return {
            statusCode: 200,
            data: JSON.stringify(responsesFixture),
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        });

      const { logger, infoSpy } = makeLogger();
      const overrideAdapters = createDataForSeoAdapters({
        config: makeConfig({
          geminiMode: 'scraper',
          geminiEndpoint: customPath,
          geminiModel: 'gemini-2.5-pro',
        }),
        httpClient: new HttpClient({ logger }),
        logger,
      });
      await findAdapter(overrideAdapters, 'gemini').collect(
        makeContext('gemini', 'override endpoint prompt'),
      );
      expect(JSON.parse(capturedOverrideBody)).toEqual([
        {
          user_prompt: 'override endpoint prompt',
          model_name: 'gemini-2.5-pro',
          web_search: true,
          web_search_country_iso_code: 'US',
        },
      ]);
      expect(infoSpy).toHaveBeenCalledTimes(1);
      const infoLogPayload = JSON.stringify(infoSpy.mock.calls[0]);
      expect(infoLogPayload).not.toContain('custom=1');
      expect(infoLogPayload).toContain('/v3/ai_optimization/gemini/llm_responses/live');
    });

    it('gemini: symmetrically infers scraper mode when geminiMode=responses but geminiEndpoint targets llm_scraper (including whitespace)', async () => {
      const fixture = loadFixture('gemini.json');
      const pool = mockAgent.get(TEST_BASE_URL);
      let capturedBody = '';
      pool
        .intercept({
          path: DATAFORSEO_ENDPOINTS.geminiScraper,
          method: 'POST',
          headers: { authorization: EXPECTED_BASIC_AUTH },
        })
        .reply((opts) => {
          capturedBody = String(opts.body ?? '');
          return {
            statusCode: 200,
            data: JSON.stringify(fixture),
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        });

      const adapters = createDataForSeoAdapters({
        config: makeConfig({
          geminiMode: 'responses',
          geminiEndpoint: `  ${DATAFORSEO_ENDPOINTS.geminiScraper}  `,
          geminiModel: 'gemini-2.5-pro',
        }),
        httpClient: new HttpClient(),
      });
      const geminiAdapter = findAdapter(adapters, 'gemini');
      expect(geminiAdapter.model).toBeUndefined();

      const ctx = makeContext('gemini', 'override scraper test');
      const result = await geminiAdapter.collect(ctx);

      expect(JSON.parse(capturedBody)).toEqual([
        {
          keyword: 'override scraper test',
          location_code: 2840,
          language_code: 'en',
        },
      ]);
      expect(result.answerText).toContain('Qdrant');
      expect(result.citations).toHaveLength(2);
      expect(result.rawMeta.costUsd).toBe(0.0038);
      expect(result.rawMeta.model).toBeUndefined();

      // Whitespace-only geminiEndpoint falls back to geminiMode default endpoint
      const whitespaceAdapters = createDataForSeoAdapters({
        config: makeConfig({
          geminiMode: 'responses',
          geminiEndpoint: '   \t\n  ',
          geminiModel: 'gemini-2.5-flash',
        }),
        httpClient: new HttpClient(),
      });
      expect(findAdapter(whitespaceAdapters, 'gemini').model).toBe('gemini-2.5-flash');
    });

    it('claude: calls llm_responses endpoint with Basic Auth and parses fixture cleanly', async () => {
      const fixture = loadFixture('claude.json');
      let capturedBody = '';
      const pool = mockAgent.get(TEST_BASE_URL);
      pool
        .intercept({
          path: DATAFORSEO_ENDPOINTS.claude,
          method: 'POST',
          headers: { authorization: EXPECTED_BASIC_AUTH },
        })
        .reply((opts) => {
          capturedBody = String(opts.body ?? '');
          return {
            statusCode: 200,
            data: JSON.stringify(fixture),
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        });

      const adapters = createDataForSeoAdapters({
        config: makeConfig(),
        httpClient: new HttpClient(),
      });
      const ctx = makeContext('claude', 'best typescript http framework');
      const result = await findAdapter(adapters, 'claude').collect(ctx);

      expect(JSON.parse(capturedBody)).toEqual([
        {
          user_prompt: 'best typescript http framework',
          model_name: 'claude-sonnet-4-5',
          web_search: true,
          web_search_country_iso_code: 'US',
        },
      ]);
      expect(result.answerText).toContain('Fastify');
      expect(result.citations).toHaveLength(2);
      expect(result.rawMeta.model).toBe('claude-sonnet-4-5');
      expect(result.rawMeta.tokensIn).toBe(145);
      expect(result.rawMeta.tokensOut).toBe(410);
      expect(result.rawMeta.costUsd).toBe(0.0115);

      const normalized = normalizeResponse({
        result,
        prompt: ctx.prompt,
        meta: {
          engine: 'claude',
          region: 'overseas',
          requestId: ctx.requestId,
          latencyMs: 300,
          attempts: 1,
          cached: false,
        },
      });
      expect(() => collectResponseSchema.parse(normalized)).not.toThrow();
    });

    it('google_aio (AIO present): calls SERP endpoint, merges aio & nested references, sets aiOverviewTriggered = true', async () => {
      const fixture = loadFixture('google_aio.json');
      let capturedBody = '';
      const pool = mockAgent.get(TEST_BASE_URL);
      pool
        .intercept({
          path: DATAFORSEO_ENDPOINTS.googleAio,
          method: 'POST',
          headers: { authorization: EXPECTED_BASIC_AUTH },
        })
        .reply((opts) => {
          capturedBody = String(opts.body ?? '');
          return {
            statusCode: 200,
            data: JSON.stringify(fixture),
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        });

      const adapters = createDataForSeoAdapters({
        config: makeConfig(),
        httpClient: new HttpClient(),
      });
      const ctx = makeContext('google_aio', 'what is generative engine optimization');
      const result = await findAdapter(adapters, 'google_aio').collect(ctx);

      expect(JSON.parse(capturedBody)).toEqual([
        {
          keyword: 'what is generative engine optimization',
          location_code: 2840,
          language_code: 'en',
          device: 'desktop',
          os: 'windows',
          load_async_ai_overview: true,
          expand_ai_overview: true,
        },
      ]);
      expect(result.answerText).toContain('Generative Engine Optimization');
      expect(result.citations).toHaveLength(2);
      expect(result.citations[0]).toEqual({
        url: 'https://arxiv.org/abs/2311.09735',
        title: 'GEO: Generative Engine Optimization',
        snippet: 'Academic study evaluating citation visibility methods in generative engines.',
      });
      expect(result.citations[1]).toEqual({
        url: 'https://developers.google.com/search/docs/appearance/ai-features',
        title: 'Google Search AI Features Documentation',
        snippet: 'Guidance on appearing in AI Overviews and AI-powered Search experiences.',
      });
      expect(result.fanOutQueries).toEqual([]);
      expect(result.rawMeta.aiOverviewTriggered).toBe(true);
      expect(result.rawMeta.costUsd).toBe(0.002);

      const normalized = normalizeResponse({
        result,
        prompt: ctx.prompt,
        meta: {
          engine: 'google_aio',
          region: 'overseas',
          requestId: ctx.requestId,
          latencyMs: 180,
          attempts: 1,
          cached: false,
        },
      });
      expect(() => collectResponseSchema.parse(normalized)).not.toThrow();
    });

    it('google_aio (AIO absent): returns compliant <60-char non-FAKE fallback with aiOverviewTriggered = false', async () => {
      const fixture = loadFixture('google_aio_no_aio.json');
      const pool = mockAgent.get(TEST_BASE_URL);
      pool
        .intercept({
          path: DATAFORSEO_ENDPOINTS.googleAio,
          method: 'POST',
          headers: { authorization: EXPECTED_BASIC_AUTH },
        })
        .reply(200, JSON.stringify(fixture), {
          headers: { 'content-type': 'application/json' },
        });

      const adapters = createDataForSeoAdapters({
        config: makeConfig(),
        httpClient: new HttpClient(),
      });
      const ctx = makeContext('google_aio', 'sonargate internal login page');
      const result = await findAdapter(adapters, 'google_aio').collect(ctx);

      expect(result.answerText).toBe(NO_AI_OVERVIEW_TEXT);
      expect(result.answerText).toBe('[NO_AI_OVERVIEW] 该查询未触发 Google AI Overview。');
      expect(result.answerText.replace(/\s+/g, '').length).toBeLessThan(60);
      expect(result.answerText.startsWith('【FAKE】')).toBe(false);
      expect(result.citations).toEqual([]);
      expect(result.fanOutQueries).toEqual([]);
      expect(result.rawMeta.aiOverviewTriggered).toBe(false);
      expect(result.rawMeta.costUsd).toBe(0.002);

      const normalized = normalizeResponse({
        result,
        prompt: ctx.prompt,
        meta: {
          engine: 'google_aio',
          region: 'overseas',
          requestId: ctx.requestId,
          latencyMs: 150,
          attempts: 1,
          cached: false,
        },
      });
      expect(collectResponseSchema.parse(normalized).rawMeta.aiOverviewTriggered).toBe(false);
    });
  });

  describe('DataForSEO logical status codes, HTTP error mapping & costUsd = 0', () => {
    it('maps top-level logical status_code=40200 to 503 UPSTREAM_AUTH_OR_QUOTA and logs redacted ERROR', async () => {
      const { logger, errorSpy } = makeLogger();
      const pool = mockAgent.get(TEST_BASE_URL);
      pool.intercept({ path: DATAFORSEO_ENDPOINTS.chatgpt, method: 'POST' }).reply(
        200,
        JSON.stringify({
          status_code: 40200,
          status_message: 'Payment Required.',
          tasks: [],
        }),
        { headers: { 'content-type': 'application/json' } },
      );

      const adapters = createDataForSeoAdapters({
        config: makeConfig(),
        httpClient: new HttpClient({ logger }),
        logger,
      });

      await expect(
        findAdapter(adapters, 'chatgpt').collect(makeContext('chatgpt')),
      ).rejects.toMatchObject({
        statusCode: 503,
        code: 'UPSTREAM_AUTH_OR_QUOTA',
        retryable: false,
        engine: 'chatgpt',
      });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const loggedPayload = JSON.stringify(errorSpy.mock.calls[0]);
      expect(loggedPayload).not.toContain(TEST_PASSWORD);
      expect(loggedPayload).not.toContain(EXPECTED_BASIC_AUTH);
    });

    it.each([40100, 40101])(
      'maps task-level logical status_code=%i to 503 UPSTREAM_AUTH_OR_QUOTA with ERROR log',
      async (taskCode) => {
        const { logger, errorSpy } = makeLogger();
        const pool = mockAgent.get(TEST_BASE_URL);
        pool.intercept({ path: DATAFORSEO_ENDPOINTS.perplexity, method: 'POST' }).reply(
          200,
          JSON.stringify({
            status_code: 20000,
            status_message: 'Ok.',
            tasks: [
              {
                id: 'task-auth-fail',
                status_code: taskCode,
                status_message: 'Authorization failed.',
                result: [],
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );

        const adapters = createDataForSeoAdapters({
          config: makeConfig(),
          httpClient: new HttpClient({ logger }),
          logger,
        });

        await expect(
          findAdapter(adapters, 'perplexity').collect(makeContext('perplexity')),
        ).rejects.toMatchObject({
          statusCode: 503,
          code: 'UPSTREAM_AUTH_OR_QUOTA',
          retryable: false,
          engine: 'perplexity',
        });
        expect(errorSpy).toHaveBeenCalledTimes(1);
      },
    );

    it.each([401, 403])(
      'maps HTTP %i from DataForSEO to 503 UPSTREAM_AUTH_OR_QUOTA (never 401)',
      async (httpStatus) => {
        const { logger, errorSpy } = makeLogger();
        const pool = mockAgent.get(TEST_BASE_URL);
        pool
          .intercept({ path: DATAFORSEO_ENDPOINTS.claude, method: 'POST' })
          .reply(httpStatus, JSON.stringify({ message: 'Forbidden' }), {
            headers: { 'content-type': 'application/json' },
          });

        const adapters = createDataForSeoAdapters({
          config: makeConfig(),
          httpClient: new HttpClient({ logger }),
          logger,
        });

        await expect(
          findAdapter(adapters, 'claude').collect(makeContext('claude')),
        ).rejects.toMatchObject({
          statusCode: 503,
          code: 'UPSTREAM_AUTH_OR_QUOTA',
          retryable: false,
          engine: 'claude',
        });
        expect(errorSpy).toHaveBeenCalledTimes(1);
      },
    );

    it('maps logical status_code=42900 (top-level & task-level) to 429 RATE_LIMITED (retryable: true)', async () => {
      const pool = mockAgent.get(TEST_BASE_URL);
      pool.intercept({ path: DATAFORSEO_ENDPOINTS.chatgpt, method: 'POST' }).reply(
        200,
        JSON.stringify({
          status_code: 42900,
          status_message: 'Too Many Requests.',
          tasks: [],
        }),
        { headers: { 'content-type': 'application/json' } },
      );

      const adapters = createDataForSeoAdapters({
        config: makeConfig(),
        httpClient: new HttpClient(),
      });

      await expect(
        findAdapter(adapters, 'chatgpt').collect(makeContext('chatgpt')),
      ).rejects.toMatchObject({
        statusCode: 429,
        code: 'RATE_LIMITED',
        retryable: true,
      });

      pool.intercept({ path: DATAFORSEO_ENDPOINTS.chatgpt, method: 'POST' }).reply(
        200,
        JSON.stringify({
          status_code: 20000,
          status_message: 'Ok.',
          tasks: [{ id: 't-429', status_code: 42900, status_message: 'Rate limit exceeded' }],
        }),
        { headers: { 'content-type': 'application/json' } },
      );

      await expect(
        findAdapter(adapters, 'chatgpt').collect(makeContext('chatgpt')),
      ).rejects.toMatchObject({
        statusCode: 429,
        code: 'RATE_LIMITED',
        retryable: true,
      });
    });

    it('maps other 40000-40999 codes (e.g. 40000, 40501) to 400 INVALID_REQUEST (retryable: false)', async () => {
      const pool = mockAgent.get(TEST_BASE_URL);
      pool.intercept({ path: DATAFORSEO_ENDPOINTS.geminiScraper, method: 'POST' }).reply(
        200,
        JSON.stringify({
          status_code: 20000,
          status_message: 'Ok.',
          tasks: [{ id: 't-400', status_code: 40501, status_message: 'Invalid Field: keyword' }],
        }),
        { headers: { 'content-type': 'application/json' } },
      );

      const adapters = createDataForSeoAdapters({
        config: makeConfig(),
        httpClient: new HttpClient(),
      });

      await expect(
        findAdapter(adapters, 'gemini').collect(makeContext('gemini')),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_REQUEST',
        retryable: false,
      });

      pool.intercept({ path: DATAFORSEO_ENDPOINTS.geminiScraper, method: 'POST' }).reply(
        200,
        JSON.stringify({
          status_code: 40000,
          status_message: 'You can set only one task at a time.',
          tasks: [],
        }),
        { headers: { 'content-type': 'application/json' } },
      );

      await expect(
        findAdapter(adapters, 'gemini').collect(makeContext('gemini')),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_REQUEST',
        retryable: false,
      });
    });

    it('maps 50000+ logical errors and missing tasks[0]/result[0] to 502 UPSTREAM_BAD_RESPONSE (retryable: true)', async () => {
      const pool = mockAgent.get(TEST_BASE_URL);
      const adapters = createDataForSeoAdapters({
        config: makeConfig(),
        httpClient: new HttpClient(),
      });

      // 50000
      pool.intercept({ path: DATAFORSEO_ENDPOINTS.googleAio, method: 'POST' }).reply(
        200,
        JSON.stringify({
          status_code: 50000,
          status_message: 'Internal Error.',
          tasks: [],
        }),
        { headers: { 'content-type': 'application/json' } },
      );

      await expect(
        findAdapter(adapters, 'google_aio').collect(makeContext('google_aio')),
      ).rejects.toMatchObject({
        statusCode: 502,
        code: 'UPSTREAM_BAD_RESPONSE',
        retryable: true,
      });

      // Missing tasks[0]
      pool.intercept({ path: DATAFORSEO_ENDPOINTS.googleAio, method: 'POST' }).reply(
        200,
        JSON.stringify({
          status_code: 20000,
          status_message: 'Ok.',
          tasks: [],
        }),
        { headers: { 'content-type': 'application/json' } },
      );

      await expect(
        findAdapter(adapters, 'google_aio').collect(makeContext('google_aio')),
      ).rejects.toBeInstanceOf(GatewayError);

      // Missing result[0]
      pool.intercept({ path: DATAFORSEO_ENDPOINTS.googleAio, method: 'POST' }).reply(
        200,
        JSON.stringify({
          status_code: 20000,
          status_message: 'Ok.',
          tasks: [{ id: 't-empty', status_code: 20000, status_message: 'Ok.', result: [] }],
        }),
        { headers: { 'content-type': 'application/json' } },
      );

      await expect(
        findAdapter(adapters, 'google_aio').collect(makeContext('google_aio')),
      ).rejects.toMatchObject({
        statusCode: 502,
        code: 'UPSTREAM_BAD_RESPONSE',
        retryable: true,
      });
    });

    it('preserves body.cost === 0 in rawMeta.costUsd', async () => {
      const fixture = loadFixture('chatgpt.json');
      fixture['cost'] = 0;

      const pool = mockAgent.get(TEST_BASE_URL);
      pool
        .intercept({ path: DATAFORSEO_ENDPOINTS.chatgpt, method: 'POST' })
        .reply(200, JSON.stringify(fixture), {
          headers: { 'content-type': 'application/json' },
        });

      const adapters = createDataForSeoAdapters({
        config: makeConfig(),
        httpClient: new HttpClient(),
      });
      const result = await findAdapter(adapters, 'chatgpt').collect(makeContext('chatgpt'));
      expect(result.rawMeta.costUsd).toBe(0);
    });
  });

  describe('pure parser edge cases', () => {
    it('parseChatGptResult falls back to items[].sections[].text when markdown is absent', () => {
      const parsed = parseChatGptResult(
        {
          items: [
            {
              sections: [{ text: 'First section answer.' }, { markdown: 'Second section answer.' }],
            },
          ],
          search_queries: ['fallback search query'],
        },
        { costUsd: 0 },
      );

      expect(parsed.answerText).toBe('First section answer.\n\nSecond section answer.');
      expect(parsed.fanOutQueries).toEqual(['fallback search query']);
      expect(parsed.rawMeta.costUsd).toBe(0);
    });

    it('extractTextFromItems falls back to item.markdown/item.text when sections is empty or contains only non-text entries', () => {
      const chatGptParsed = parseChatGptResult({
        items: [
          {
            type: 'chat_gpt_text',
            sections: [],
            text: 'Fallback text when sections is empty.',
          },
          {
            type: 'chat_gpt_text',
            sections: [
              { type: 'image', text: null },
              { type: 'table', text: '   ' },
            ],
            markdown: 'Fallback markdown when sections yield no text.',
          },
        ],
      });
      expect(chatGptParsed.answerText).toBe(
        'Fallback text when sections is empty.\n\nFallback markdown when sections yield no text.',
      );

      const responsesParsed = parseLlmResponsesResult({
        items: [
          {
            type: 'message',
            sections: [{ type: 'citation_only', text: '' }],
            text: 'Responses fallback item text.',
          },
        ],
      });
      expect(responsesParsed.answerText).toBe('Responses fallback item text.');
    });

    it('parseGoogleAioResult recursively collects nested items title/text and nested references when markdown is absent', () => {
      const parsed = parseGoogleAioResult(
        {
          items: [
            {
              type: 'ai_overview',
              items: [
                {
                  title: 'Overview Heading',
                  text: 'Top-level summary paragraph.',
                  items: [
                    {
                      title: 'Nested Detail',
                      text: 'Deeper explanation inside nested items.',
                      references: [
                        {
                          url: 'https://example.org/deep-ref',
                          title: 'Deep Ref',
                          text: 'Deep reference snippet.',
                        },
                      ],
                    },
                  ],
                },
              ],
              references: [
                {
                  url: 'https://example.org/top-ref',
                  title: 'Top Ref',
                  text: 'Top reference snippet.',
                },
              ],
            },
          ],
        },
        { costUsd: 0.002, upstreamRequestId: 'aio-recursive-1' },
      );

      expect(parsed.answerText).toBe(
        'Overview Heading\n\nTop-level summary paragraph.\n\nNested Detail\n\nDeeper explanation inside nested items.',
      );
      expect(parsed.citations).toEqual([
        {
          url: 'https://example.org/top-ref',
          title: 'Top Ref',
          snippet: 'Top reference snippet.',
        },
        {
          url: 'https://example.org/deep-ref',
          title: 'Deep Ref',
          snippet: 'Deep reference snippet.',
        },
      ]);
      expect(parsed.rawMeta.aiOverviewTriggered).toBe(true);
      expect(parsed.rawMeta.costUsd).toBe(0.002);
    });

    it('parseGoogleAioResult falls back to top-level aioItem.text when markdown and items are absent', () => {
      const parsed = parseGoogleAioResult({
        items: [
          {
            type: 'ai_overview',
            text: 'Direct top-level AIO summary text.',
            references: [
              {
                url: 'https://example.org/direct-ref',
                title: 'Direct Ref',
                text: 'Direct snippet.',
              },
            ],
          },
        ],
      });

      expect(parsed.answerText).toBe('Direct top-level AIO summary text.');
      expect(parsed.citations).toEqual([
        {
          url: 'https://example.org/direct-ref',
          title: 'Direct Ref',
          snippet: 'Direct snippet.',
        },
      ]);
      expect(parsed.rawMeta.aiOverviewTriggered).toBe(true);
    });

    it('direct collect() on unconfigured overseas adapters throws 501 ENGINE_NOT_CONFIGURED without HTTP call', async () => {
      const adapters = createDataForSeoAdapters({
        config: makeConfig({ login: '   ', password: '' }),
        httpClient: new HttpClient(),
      });

      for (const adapter of adapters) {
        expect(adapter.isConfigured()).toBe(false);
        await expect(adapter.collect(makeContext(adapter.engine))).rejects.toMatchObject({
          statusCode: 501,
          code: 'ENGINE_NOT_CONFIGURED',
          retryable: false,
          engine: adapter.engine,
        });
      }
    });
  });
});
