import { afterEach, describe, expect, it } from 'vitest';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { buildApp, type SonarGateApp } from '../../../src/app.js';
import { loadConfig } from '../../../src/config.js';
import { remoteScraperResponseSchema } from '../helpers/geomix-schema.js';

const RELAY_ORIGIN = 'https://relay.newapi.test';
const API_KEY = 'e2e-relay-gateway-key-0001';

describe('Tier 1 — Overseas OpenAI-Compatible Relay (NewAPI / SubAPI)', () => {
  const originalDispatcher = getGlobalDispatcher();
  let mockAgent: MockAgent | undefined;
  let app: SonarGateApp | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
    if (mockAgent !== undefined) {
      await mockAgent.close();
      mockAgent = undefined;
    }
    setGlobalDispatcher(originalDispatcher);
  });

  it('serves all 5 overseas engines through a single OVERSEAS_RELAY_* config with google_aio Gemini placeholder', async () => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);

    const pool = mockAgent.get(RELAY_ORIGIN);
    const seenModels: string[] = [];

    pool
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply((opts) => {
        const parsed = JSON.parse(String(opts.body)) as { model: string };
        seenModels.push(parsed.model);
        return {
          statusCode: 200,
          data: {
            id: `chatcmpl-${parsed.model}`,
            model: parsed.model,
            choices: [
              {
                message: {
                  content: `Verified response from ${parsed.model} with source [Example](https://example.com/${parsed.model}).`,
                  annotations: [
                    {
                      type: 'url_citation',
                      url_citation: {
                        url: `https://docs.example.com/${parsed.model}`,
                        title: `Docs for ${parsed.model}`,
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 15, completion_tokens: 30 },
          },
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      })
      .times(5);

    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      GATEWAY_API_KEYS: API_KEY,
      OVERSEAS_RELAY_BASE_URL: `${RELAY_ORIGIN}/v1`,
      OVERSEAS_RELAY_API_KEY: 'sk-newapi-secret-key',
      GEMINI_MODEL: 'gemini-2.5-pro',
    });
    app = buildApp({ config, logger: false });

    const enginesRes = await app.inject({
      method: 'GET',
      url: '/v1/engines',
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(enginesRes.statusCode).toBe(200);
    const enginesJson = enginesRes.json() as {
      engines: Array<{ engine: string; region: string; provider: string; configured: boolean }>;
    };
    const overseas = enginesJson.engines.filter((e) => e.region === 'overseas');
    expect(overseas.every((e) => e.provider === 'openai_compat' && e.configured)).toBe(true);

    for (const engine of ['chatgpt', 'perplexity', 'gemini', 'claude', 'google_aio'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/collect',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'application/json',
        },
        payload: {
          engine,
          prompt: `Test prompt for ${engine}`,
          noCache: true,
        },
      });

      expect(res.statusCode).toBe(200);
      const parsed = remoteScraperResponseSchema.parse(res.json());
      expect(parsed.rawMeta?.['provider']).toBe('openai_compat');
      expect(parsed.citations.length).toBeGreaterThanOrEqual(1);
      if (engine === 'google_aio') {
        expect(parsed.rawMeta?.['placeholder']).toBe('gemini_openai_compat');
        expect(parsed.rawMeta?.['model']).toBe('gemini-2.5-pro');
      }
    }

    expect(seenModels).toEqual([
      'gpt-4o-search-preview',
      'sonar-pro',
      'gemini-2.5-pro',
      'claude-sonnet-4-5',
      'gemini-2.5-pro',
    ]);
  });
});
