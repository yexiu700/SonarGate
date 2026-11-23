import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type SonarGateApp } from '../../src/app.js';
import { getConfigWarnings, loadConfig } from '../../src/config.js';
import { errorEnvelopeSchema } from '../../src/core/contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, '../fixtures');
const API_KEY = 'disabled-engines-test-key-0001';

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, name), 'utf8')) as Record<string, unknown>;
}

const BASE_OVERSEAS_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  GATEWAY_API_KEYS: API_KEY,
  MAX_UPSTREAM_RETRIES: '0',
  DATAFORSEO_LOGIN: 'dfs-login-test',
  DATAFORSEO_PASSWORD: 'dfs-password-test',
};

describe('DISABLED_ENGINES configuration & enforcement', () => {
  let previousDispatcher: Dispatcher;
  let mockAgent: MockAgent;
  let app: SonarGateApp | undefined;

  beforeEach(() => {
    previousDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
    setGlobalDispatcher(previousDispatcher);
    await mockAgent.close();
  });

  describe('config parsing and warnings', () => {
    it('defaults to empty disabled list when DISABLED_ENGINES is unset or blank', () => {
      const unsetCfg = loadConfig(BASE_OVERSEAS_ENV);
      expect(unsetCfg.engines.disabled).toEqual([]);
      expect(unsetCfg.engines.unknownDisabled).toEqual([]);
      expect(getConfigWarnings(unsetCfg)).toEqual([]);

      const blankCfg = loadConfig({ ...BASE_OVERSEAS_ENV, DISABLED_ENGINES: '  ,  ' });
      expect(blankCfg.engines.disabled).toEqual([]);
      expect(blankCfg.engines.unknownDisabled).toEqual([]);
    });

    it('trims, lowercases, deduplicates, and resolves aliases', () => {
      const cfg = loadConfig({
        ...BASE_OVERSEAS_ENV,
        DISABLED_ENGINES: ' Claude , google_aio , Qwen , tongyi , CLAUDE ',
      });
      expect(cfg.engines.disabled).toEqual(['claude', 'google_aio', 'tongyi']);
      expect(cfg.engines.unknownDisabled).toEqual([]);
      expect(getConfigWarnings(cfg)).toEqual([]);
    });

    it('records unknown engine names and emits a config warning', () => {
      const cfg = loadConfig({
        ...BASE_OVERSEAS_ENV,
        DISABLED_ENGINES: 'claude,unknown_ai,nami',
      });
      expect(cfg.engines.disabled).toEqual(['claude']);
      expect(cfg.engines.unknownDisabled).toEqual(['unknown_ai', 'nami']);

      const warnings = getConfigWarnings(cfg);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('unknown_ai');
      expect(warnings[0]).toContain('nami');
    });
  });

  describe('/v1/engines, /ready, and /v1/collect behavior', () => {
    it('marks disabled engines as status=disabled, configured=false, and deducts configuredCount', async () => {
      const config = loadConfig({
        ...BASE_OVERSEAS_ENV,
        DISABLED_ENGINES: 'claude,google_aio',
      });
      app = buildApp({ config });

      const enginesRes = await app.inject({
        method: 'GET',
        url: '/v1/engines',
        headers: { authorization: `Bearer ${API_KEY}` },
      });
      expect(enginesRes.statusCode).toBe(200);
      const enginesBody = enginesRes.json() as {
        configuredCount: number;
        totalSupported: number;
        engines: Array<{ engine: string; configured: boolean; status: string }>;
      };

      expect(enginesBody.configuredCount).toBe(3);
      expect(enginesBody.totalSupported).toBe(12);

      const byEngine = new Map(enginesBody.engines.map((e) => [e.engine, e]));
      expect(byEngine.get('claude')).toMatchObject({ configured: false, status: 'disabled' });
      expect(byEngine.get('google_aio')).toMatchObject({ configured: false, status: 'disabled' });
      expect(byEngine.get('chatgpt')).toMatchObject({ configured: true, status: 'ready' });
      expect(byEngine.get('perplexity')).toMatchObject({ configured: true, status: 'ready' });
      expect(byEngine.get('gemini')).toMatchObject({ configured: true, status: 'ready' });

      const readyRes = await app.inject({
        method: 'GET',
        url: '/ready',
      });
      expect(readyRes.statusCode).toBe(200);
      const readyBody = readyRes.json() as {
        ready: boolean;
        configuredCount: number;
        engines: Array<{ engine: string; configured: boolean; status: string }>;
      };
      expect(readyBody.ready).toBe(true);
      expect(readyBody.configuredCount).toBe(3);
      const readyByEngine = new Map(readyBody.engines.map((e) => [e.engine, e]));
      expect(readyByEngine.get('claude')).toMatchObject({ configured: false, status: 'disabled' });
      expect(readyByEngine.get('google_aio')).toMatchObject({
        configured: false,
        status: 'disabled',
      });
    });

    it('blocks POST /v1/collect for disabled engines with 400 ENGINE_DISABLED and makes zero upstream calls', async () => {
      let upstreamCalls = 0;
      const pool = mockAgent.get('https://api.dataforseo.com');
      pool
        .intercept({ path: /.*/, method: 'POST' })
        .reply(() => {
          upstreamCalls += 1;
          return { statusCode: 200, data: {} };
        })
        .persist();

      const config = loadConfig({
        ...BASE_OVERSEAS_ENV,
        DISABLED_ENGINES: 'claude,google_aio,qwen',
      });
      app = buildApp({ config });

      for (const [requestedEngine, expectedCanonical] of [
        ['claude', 'claude'],
        ['google_aio', 'google_aio'],
        ['qwen', 'tongyi'],
        ['tongyi', 'tongyi'],
      ] as const) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/collect',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            engine: requestedEngine,
            prompt: 'best cloud observability tools',
          },
        });

        expect(res.statusCode).toBe(400);
        const envelope = errorEnvelopeSchema.parse(res.json());
        expect(envelope.error.code).toBe('ENGINE_DISABLED');
        expect(envelope.error.retryable).toBe(false);
        expect(envelope.error.engine).toBe(expectedCanonical);
      }

      expect(upstreamCalls).toBe(0);
    });

    it('restores engine availability when DISABLED_ENGINES is not configured', async () => {
      const pool = mockAgent.get('https://api.dataforseo.com');
      pool
        .intercept({ path: '/v3/ai_optimization/claude/llm_responses/live', method: 'POST' })
        .reply(200, loadFixture('claude.json'), {
          headers: { 'content-type': 'application/json' },
        });

      const config = loadConfig(BASE_OVERSEAS_ENV);
      app = buildApp({ config });

      const enginesRes = await app.inject({
        method: 'GET',
        url: '/v1/engines',
        headers: { authorization: `Bearer ${API_KEY}` },
      });
      const enginesBody = enginesRes.json() as {
        configuredCount: number;
        engines: Array<{ engine: string; configured: boolean; status: string }>;
      };
      expect(enginesBody.configuredCount).toBe(5);
      const byEngine = new Map(enginesBody.engines.map((e) => [e.engine, e]));
      expect(byEngine.get('claude')).toMatchObject({ configured: true, status: 'ready' });
      expect(byEngine.get('google_aio')).toMatchObject({ configured: true, status: 'ready' });

      const collectRes = await app.inject({
        method: 'POST',
        url: '/v1/collect',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'application/json',
        },
        payload: {
          engine: 'claude',
          prompt: 'best cloud observability tools',
        },
      });
      expect(collectRes.statusCode).toBe(200);
    });
  });
});
