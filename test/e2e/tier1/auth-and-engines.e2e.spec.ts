import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_E2E_ENV,
  PRIMARY_API_KEY,
  SECONDARY_API_KEY,
  createE2EHarness,
} from '../helpers/e2e-harness.js';
import type { E2EHarness } from '../helpers/e2e-harness.js';
import {
  DOMESTIC_ENGINES,
  OVERSEAS_ENGINES,
  SUPPORTED_ENGINES,
  assertValidGeoMixResponse,
  errorEnvelopeSchema,
} from '../helpers/geomix-schema.js';

interface EngineSummaryLike {
  engine?: string;
  region?: string;
  configured?: boolean;
  enabled?: boolean;
  model?: string;
}

function extractEnginesList(payload: unknown): EngineSummaryLike[] {
  if (Array.isArray(payload)) {
    return payload as EngineSummaryLike[];
  }
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record['engines'])) {
      return record['engines'] as EngineSummaryLike[];
    }
  }
  throw new Error(`Unexpected GET /v1/engines response shape: ${JSON.stringify(payload)}`);
}

describe('Tier 1 — Auth, Key Rotation & GET /v1/engines', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.close();
      harness = undefined;
    }
  });

  describe('Authentication enforcement on protected endpoints', () => {
    const badAuthCases: Array<{
      label: string;
      headers: Record<string, string>;
    }> = [
      { label: 'missing Authorization header', headers: {} },
      { label: 'non-Bearer Basic scheme', headers: { authorization: 'Basic dXNlcjpwYXNz' } },
      { label: 'non-Bearer Token scheme', headers: { authorization: `Token ${PRIMARY_API_KEY}` } },
      { label: 'wrong Bearer token', headers: { authorization: 'Bearer completely-wrong-key' } },
      {
        label: 'prefix/substring of valid key',
        headers: { authorization: `Bearer ${PRIMARY_API_KEY.slice(0, 12)}` },
      },
      {
        label: 'valid key with trailing character',
        headers: { authorization: `Bearer ${PRIMARY_API_KEY}x` },
      },
    ];

    for (const testCase of badAuthCases) {
      it(`rejects GET /v1/engines with 401 UNAUTHORIZED when ${testCase.label}`, async () => {
        harness = createE2EHarness();

        const res = await harness.getEngines({ apiKey: null, headers: testCase.headers });

        expect(res.statusCode).toBe(401);
        const envelope = errorEnvelopeSchema.parse(res.json());
        expect(envelope.error.code).toBe('UNAUTHORIZED');
        expect(envelope.error.retryable).toBe(false);
        expect(envelope.error.requestId.length).toBeGreaterThan(0);
      });

      it(`rejects POST /v1/collect with 401 UNAUTHORIZED when ${testCase.label}`, async () => {
        harness = createE2EHarness();

        const res = await harness.collect(
          { engine: 'deepseek', prompt: 'auth check prompt' },
          { apiKey: null, headers: testCase.headers },
        );

        expect(res.statusCode).toBe(401);
        const envelope = errorEnvelopeSchema.parse(res.json());
        expect(envelope.error.code).toBe('UNAUTHORIZED');
        expect(envelope.error.retryable).toBe(false);
        expect(envelope.error.requestId.length).toBeGreaterThan(0);
        expect(harness.upstreams.getTotalHits()).toBe(0);
      });
    }
  });

  it('supports multi-key rotation via GATEWAY_API_KEYS on /v1/engines and /v1/collect', async () => {
    harness = createE2EHarness();
    harness.upstreams.mockEngineSuccess('deepseek', undefined, { times: 2 });

    const enginesPrimary = await harness.getEngines({ apiKey: PRIMARY_API_KEY });
    expect(enginesPrimary.statusCode).toBe(200);

    const enginesSecondary = await harness.getEngines({ apiKey: SECONDARY_API_KEY });
    expect(enginesSecondary.statusCode).toBe(200);

    const collectPrimary = await harness.collect(
      { engine: 'deepseek', prompt: 'primary key prompt' },
      { apiKey: PRIMARY_API_KEY },
    );
    expect(collectPrimary.statusCode).toBe(200);
    assertValidGeoMixResponse(collectPrimary.body, collectPrimary.json());

    const collectSecondary = await harness.collect(
      { engine: 'deepseek', prompt: 'secondary key prompt' },
      { apiKey: SECONDARY_API_KEY },
    );
    expect(collectSecondary.statusCode).toBe(200);
    assertValidGeoMixResponse(collectSecondary.body, collectSecondary.json());
  });

  it('supports legacy single-key GATEWAY_API_KEY fallback when GATEWAY_API_KEYS is unset', async () => {
    const legacyKey = 'legacy-single-gateway-key-00001';
    harness = createE2EHarness({
      GATEWAY_API_KEYS: undefined,
      GATEWAY_API_KEY: legacyKey,
    });
    harness.upstreams.mockEngineSuccess('tongyi');

    const enginesRes = await harness.getEngines({ apiKey: legacyKey });
    expect(enginesRes.statusCode).toBe(200);

    const collectRes = await harness.collect(
      { engine: 'tongyi', prompt: 'legacy key collect test' },
      { apiKey: legacyKey },
    );
    expect(collectRes.statusCode).toBe(200);
    assertValidGeoMixResponse(collectRes.body, collectRes.json());

    const rejectedRes = await harness.getEngines({ apiKey: PRIMARY_API_KEY });
    expect(rejectedRes.statusCode).toBe(401);
    const envelope = errorEnvelopeSchema.parse(rejectedRes.json());
    expect(envelope.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /v1/engines returns all 10 supported engines with metadata and zero leaked secrets', async () => {
    harness = createE2EHarness();

    const res = await harness.getEngines();
    expect(res.statusCode).toBe(200);

    const engines = extractEnginesList(res.json());
    expect(engines).toHaveLength(SUPPORTED_ENGINES.length);

    const byName = new Map(engines.map((entry) => [entry.engine, entry]));

    for (const engine of DOMESTIC_ENGINES) {
      const entry = byName.get(engine);
      expect(entry).toBeDefined();
      expect(entry?.region).toBe('domestic');
      expect(entry?.configured ?? entry?.enabled).toBe(true);
    }

    for (const engine of OVERSEAS_ENGINES) {
      const entry = byName.get(engine);
      expect(entry).toBeDefined();
      expect(entry?.region).toBe('overseas');
      expect(entry?.configured ?? entry?.enabled).toBe(true);
    }

    const secretValues = [
      PRIMARY_API_KEY,
      SECONDARY_API_KEY,
      DEFAULT_E2E_ENV['DOUBAO_API_KEY'],
      DEFAULT_E2E_ENV['DEEPSEEK_API_KEY'],
      DEFAULT_E2E_ENV['TONGYI_API_KEY'],
      DEFAULT_E2E_ENV['ZHIPU_API_KEY'],
      DEFAULT_E2E_ENV['WENXIN_API_KEY'],
      DEFAULT_E2E_ENV['YUANBAO_API_KEY'],
      DEFAULT_E2E_ENV['KIMI_API_KEY'],
      DEFAULT_E2E_ENV['DATAFORSEO_LOGIN'],
      DEFAULT_E2E_ENV['DATAFORSEO_PASSWORD'],
    ].filter((v): v is string => typeof v === 'string' && v.length > 0);

    for (const secret of secretValues) {
      expect(res.body).not.toContain(secret);
    }
  });
});
