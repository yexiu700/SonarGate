import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp, type SonarGateApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { collectResponseSchema, type SupportedEngine } from '../../src/core/contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, '../fixtures');

// Exact GeoMix remoteScraperResponseSchema
const remoteScraperResponseSchema = z.object({
  answerText: z.string().min(1).max(200_000),
  citations: z
    .array(
      z.object({
        url: z.string().min(1).max(2048),
        title: z.string().max(300).optional(),
        snippet: z.string().max(1000).optional(),
        position: z.number().int().positive().optional(),
      }),
    )
    .max(100)
    .default([]),
  fanOutQueries: z.array(z.string().max(300)).max(50).default([]),
  rawMeta: z.record(z.unknown()).optional(),
});

const API_KEY = 'integration-test-gateway-key-0001';

const ALL_CONFIGURED_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  GATEWAY_API_KEYS: API_KEY,
  MAX_UPSTREAM_RETRIES: '0',
  CACHE_TTL_SECONDS: '600',
  DOUBAO_API_KEY: 'sk-doubao-test',
  DOUBAO_MODEL: 'ep-doubao-test',
  DEEPSEEK_API_KEY: 'sk-deepseek-test',
  TONGYI_API_KEY: 'sk-tongyi-test',
  ZHIPU_API_KEY: 'sk-zhipu-test',
  WENXIN_API_KEY: 'sk-wenxin-test',
  DATAFORSEO_LOGIN: 'dfs-login-test',
  DATAFORSEO_PASSWORD: 'dfs-password-test',
};

function loadFixture(name: string): Record<string, unknown> {
  const raw = readFileSync(resolve(FIXTURES_DIR, name), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

const ENGINE_MOCK_ROUTES: Record<
  SupportedEngine,
  { origin: string; path: string; fixture: string; expectedRegion: 'domestic' | 'overseas' }
> = {
  doubao: {
    origin: 'https://ark.cn-beijing.volces.com',
    path: '/api/v3/responses',
    fixture: 'doubao.json',
    expectedRegion: 'domestic',
  },
  deepseek: {
    origin: 'https://api.deepseek.com',
    path: '/v1/chat/completions',
    fixture: 'deepseek.json',
    expectedRegion: 'domestic',
  },
  tongyi: {
    origin: 'https://dashscope.aliyuncs.com',
    path: '/compatible-mode/v1/chat/completions',
    fixture: 'tongyi.json',
    expectedRegion: 'domestic',
  },
  zhipu: {
    origin: 'https://open.bigmodel.cn',
    path: '/api/paas/v4/chat/completions',
    fixture: 'zhipu.json',
    expectedRegion: 'domestic',
  },
  wenxin: {
    origin: 'https://qianfan.baidubce.com',
    path: '/v2/chat/completions',
    fixture: 'wenxin.json',
    expectedRegion: 'domestic',
  },
  chatgpt: {
    origin: 'https://api.dataforseo.com',
    path: '/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced',
    fixture: 'chatgpt.json',
    expectedRegion: 'overseas',
  },
  perplexity: {
    origin: 'https://api.dataforseo.com',
    path: '/v3/ai_optimization/perplexity/llm_responses/live',
    fixture: 'perplexity.json',
    expectedRegion: 'overseas',
  },
  gemini: {
    origin: 'https://api.dataforseo.com',
    path: '/v3/ai_optimization/gemini/llm_scraper/live/advanced',
    fixture: 'gemini.json',
    expectedRegion: 'overseas',
  },
  claude: {
    origin: 'https://api.dataforseo.com',
    path: '/v3/ai_optimization/claude/llm_responses/live',
    fixture: 'claude.json',
    expectedRegion: 'overseas',
  },
  google_aio: {
    origin: 'https://api.dataforseo.com',
    path: '/v3/serp/google/organic/live/advanced',
    fixture: 'google_aio.json',
    expectedRegion: 'overseas',
  },
};

describe('POST /v1/collect integration contract', () => {
  let previousDispatcher: Dispatcher;
  let mockAgent: MockAgent;
  let app: SonarGateApp;

  beforeEach(() => {
    previousDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);

    const config = loadConfig(ALL_CONFIGURED_ENV);
    app = buildApp({ config, logger: false });
  });

  afterEach(async () => {
    await app.close();
    await mockAgent.close();
    setGlobalDispatcher(previousDispatcher);
  });

  const allEngines = Object.keys(ENGINE_MOCK_ROUTES) as SupportedEngine[];

  it.each(allEngines)(
    'engine "%s" satisfies both GeoMix remoteScraperResponseSchema and collectResponseSchema',
    async (engine) => {
      const route = ENGINE_MOCK_ROUTES[engine];
      const fixture = loadFixture(route.fixture);

      mockAgent
        .get(route.origin)
        .intercept({ method: 'POST', path: route.path })
        .reply(200, fixture, {
          headers: { 'content-type': 'application/json' },
        });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/collect',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'application/json',
          'x-request-id': `req-${engine}-001`,
        },
        payload: {
          engine,
          prompt: `contract test prompt for ${engine}`,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-request-id']).toBe(`req-${engine}-001`);

      const body = res.json();
      const geomixParsed = remoteScraperResponseSchema.parse(body);
      const gatewayParsed = collectResponseSchema.parse(body);

      expect(geomixParsed.answerText.length).toBeGreaterThan(0);
      expect(gatewayParsed.rawMeta.engine).toBe(engine);
      expect(gatewayParsed.rawMeta.region).toBe(route.expectedRegion);
      expect(gatewayParsed.rawMeta.requestId).toBe(`req-${engine}-001`);
      expect(gatewayParsed.rawMeta.cached).toBe(false);
    },
  );

  it('google_aio returns valid <60-char non-FAKE fallback when no AI Overview is triggered', async () => {
    const fixture = loadFixture('google_aio_no_aio.json');
    mockAgent
      .get('https://api.dataforseo.com')
      .intercept({ method: 'POST', path: '/v3/serp/google/organic/live/advanced' })
      .reply(200, fixture, {
        headers: { 'content-type': 'application/json' },
      });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
      },
      payload: {
        engine: 'google_aio',
        prompt: 'query without ai overview',
      },
    });

    expect(res.statusCode).toBe(200);
    const parsed = collectResponseSchema.parse(res.json());
    remoteScraperResponseSchema.parse(parsed);

    expect(parsed.rawMeta.aiOverviewTriggered).toBe(false);
    expect(parsed.citations).toEqual([]);
    expect(parsed.answerText.startsWith('【FAKE】')).toBe(false);
    expect(parsed.answerText.replace(/\s+/g, '').length).toBeLessThan(60);
  });

  it.each(['yuanbao', 'nami', 'kimi'])(
    'returns 501 ENGINE_NOT_IMPLEMENTED for planned engine "%s" with zero fallback',
    async (planned) => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/collect',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'application/json',
        },
        payload: {
          engine: planned,
          prompt: 'hello',
        },
      });

      expect(res.statusCode).toBe(501);
      expect(res.json()).toMatchObject({
        error: {
          code: 'ENGINE_NOT_IMPLEMENTED',
          retryable: false,
          engine: planned,
        },
      });
    },
  );

  it.each(['unknown_foo', 'nonexistent_engine'])(
    'returns 400 UNSUPPORTED_ENGINE for unknown engine "%s" with zero fallback',
    async (unknown) => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/collect',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'application/json',
        },
        payload: {
          engine: unknown,
          prompt: 'hello',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: {
          code: 'UNSUPPORTED_ENGINE',
          retryable: false,
          engine: unknown,
        },
      });
    },
  );

  it('returns 501 ENGINE_NOT_CONFIGURED for supported engine without credentials', async () => {
    const partialApp = buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        GATEWAY_API_KEYS: API_KEY,
        DEEPSEEK_API_KEY: 'sk-deepseek-only',
      }),
      logger: false,
    });

    try {
      const res = await partialApp.inject({
        method: 'POST',
        url: '/v1/collect',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'application/json',
        },
        payload: {
          engine: 'doubao',
          prompt: 'test unconfigured engine',
        },
      });

      expect(res.statusCode).toBe(501);
      expect(res.json()).toMatchObject({
        error: {
          code: 'ENGINE_NOT_CONFIGURED',
          retryable: false,
          engine: 'doubao',
        },
      });
    } finally {
      await partialApp.close();
    }
  });

  it('propagates valid X-Request-Id and replaces invalid X-Request-Id with a UUID', async () => {
    const resInvalid = await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
        'x-request-id': 'bad id with spaces / <script>',
      },
      payload: {
        engine: 'yuanbao',
        prompt: 'hello',
      },
    });

    expect(resInvalid.statusCode).toBe(501);
    const echoed = resInvalid.headers['x-request-id'];
    expect(typeof echoed).toBe('string');
    expect(echoed).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(resInvalid.json().error.requestId).toBe(echoed);
  });

  it('GET /v1/engines exposes lifecycle status (ready/unconfigured/planned) for all engines', async () => {
    const partialApp = buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        GATEWAY_API_KEYS: API_KEY,
        DEEPSEEK_API_KEY: 'sk-deepseek-only',
      }),
      logger: false,
    });

    try {
      const res = await partialApp.inject({
        method: 'GET',
        url: '/v1/engines',
        headers: {
          authorization: `Bearer ${API_KEY}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        engines: Array<{ engine: string; configured: boolean; status: string }>;
        plannedEngines: Array<{
          engine: string;
          region: string;
          configured: boolean;
          status: string;
        }>;
      };

      const byEngine = new Map(body.engines.map((entry) => [entry.engine, entry]));
      expect(byEngine.get('deepseek')).toMatchObject({ configured: true, status: 'ready' });
      expect(byEngine.get('doubao')).toMatchObject({ configured: false, status: 'unconfigured' });
      expect(body.plannedEngines).toEqual([
        { engine: 'yuanbao', region: 'domestic', configured: false, status: 'planned' },
        { engine: 'nami', region: 'domestic', configured: false, status: 'planned' },
        { engine: 'kimi', region: 'domestic', configured: false, status: 'planned' },
      ]);
    } finally {
      await partialApp.close();
    }
  });

  it('serves cached responses without mutating cached requestId, and honors X-Bypass-Cache and noCache', async () => {
    const fixture = loadFixture('deepseek.json');
    let upstreamCalls = 0;

    mockAgent
      .get('https://api.deepseek.com')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(() => {
        upstreamCalls += 1;
        return {
          statusCode: 200,
          data: fixture,
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      })
      .times(3);

    // 1st call: cache miss
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
        'x-request-id': 'cache-req-1',
      },
      payload: { engine: 'deepseek', prompt: 'cacheable prompt' },
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.json().rawMeta.cached).toBe(false);
    expect(res1.json().rawMeta.requestId).toBe('cache-req-1');
    expect(upstreamCalls).toBe(1);

    // 2nd call: cache hit with different requestId
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
        'x-request-id': 'cache-req-2',
      },
      payload: { engine: 'deepseek', prompt: 'cacheable prompt' },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().rawMeta.cached).toBe(true);
    expect(res2.json().rawMeta.requestId).toBe('cache-req-2');
    expect(upstreamCalls).toBe(1);

    // 3rd call: bypass via X-Bypass-Cache header
    const res3 = await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
        'x-bypass-cache': 'true',
      },
      payload: { engine: 'deepseek', prompt: 'cacheable prompt' },
    });
    expect(res3.statusCode).toBe(200);
    expect(res3.json().rawMeta.cached).toBe(false);
    expect(upstreamCalls).toBe(2);

    // 4th call: bypass via body.noCache
    const res4 = await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
      },
      payload: { engine: 'deepseek', prompt: 'cacheable prompt', noCache: true },
    });
    expect(res4.statusCode).toBe(200);
    expect(res4.json().rawMeta.cached).toBe(false);
    expect(upstreamCalls).toBe(3);
  });

  it('transitions GET /ready from 200 to 503 after markShuttingDown()', async () => {
    const before = await app.inject({ method: 'GET', url: '/ready' });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({
      ready: true,
      configuredCount: 10,
      totalSupported: 10,
    });

    app.markShuttingDown();

    const after = await app.inject({ method: 'GET', url: '/ready' });
    expect(after.statusCode).toBe(503);
    expect(after.json()).toEqual({
      ready: false,
      configuredCount: 10,
      totalSupported: 10,
    });
  });

  it('rejects malformed JSON with 400 INVALID_REQUEST and >64KB payload with 413 INVALID_REQUEST', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
      },
      payload: '{"engine":"deepseek", invalid',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      error: {
        code: 'INVALID_REQUEST',
        retryable: false,
      },
    });

    const oversized = await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        engine: 'deepseek',
        prompt: 'a'.repeat(70 * 1024),
      }),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({
      error: {
        code: 'INVALID_REQUEST',
        retryable: false,
      },
    });
  });

  it('maps upstream 401 to 503 UPSTREAM_AUTH_OR_QUOTA (never leaking 401 to GeoMix)', async () => {
    mockAgent
      .get('https://api.deepseek.com')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        401,
        { error: { message: 'Invalid API key' } },
        {
          headers: { 'content-type': 'application/json' },
        },
      );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
      },
      payload: {
        engine: 'deepseek',
        prompt: 'trigger upstream 401',
      },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      error: {
        code: 'UPSTREAM_AUTH_OR_QUOTA',
        retryable: false,
        engine: 'deepseek',
      },
    });
  });
});
