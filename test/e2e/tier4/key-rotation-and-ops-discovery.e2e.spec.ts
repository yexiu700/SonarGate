import { afterEach, describe, expect, it } from 'vitest';
import {
  SUPPORTED_ENGINES,
  assertValidGeoMixResponse,
  errorEnvelopeSchema,
} from '../helpers/geomix-schema.js';
import { DEFAULT_E2E_ENV, createE2EHarness } from '../helpers/e2e-harness.js';
import type { E2EHarness } from '../helpers/e2e-harness.js';
import { buildDoubaoPayload, buildTongyiPayload } from '../helpers/mock-upstreams.js';

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

describe('Tier 4 Scenario 4: Zero-Downtime Key Rotation & Ops Discovery Workflow', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await harness.close();
      harness = undefined;
    }
  });

  it('supports concurrent old/new gateway keys, rejects revoked keys, and exposes sanitized ops endpoints with zero secret leakage', async () => {
    const newKey = 'rotated-new-gateway-key-2026-0001';
    const oldKey = 'rotated-old-gateway-key-2026-0002';
    const revokedKey = 'revoked-retired-gateway-key-0003';

    harness = createE2EHarness({
      GATEWAY_API_KEYS: `${newKey},${oldKey}`,
    });

    // 1. GET /health (unauthenticated)
    const healthRes = await harness.getHealth();
    expect(healthRes.statusCode).toBe(200);
    const healthJson = healthRes.json() as Record<string, unknown>;
    expect(healthJson['status']).toBe('ok');
    expect(healthJson['service']).toBe('sonargate');
    expect(typeof healthJson['uptimeSec']).toBe('number');
    expect(Number(healthJson['uptimeSec'])).toBeGreaterThanOrEqual(0);

    // 2. GET /ready (unauthenticated)
    const readyRes = await harness.getReady();
    expect(readyRes.statusCode).toBe(200);
    const readyJson = readyRes.json() as Record<string, unknown>;
    expect(readyJson['ready']).toBe(true);
    expect(readyJson['configuredCount']).toBe(10);
    expect(readyJson['totalSupported']).toBe(10);

    // 3. GET /v1/engines works with both oldKey and newKey and leaks zero secrets
    const enginesOldRes = await harness.getEngines({ apiKey: oldKey, requestId: 'ops-eng-old' });
    const enginesNewRes = await harness.getEngines({ apiKey: newKey, requestId: 'ops-eng-new' });
    expect(enginesOldRes.statusCode).toBe(200);
    expect(enginesNewRes.statusCode).toBe(200);
    expect(enginesOldRes.headers['x-request-id']).toBe('ops-eng-old');
    expect(enginesNewRes.headers['x-request-id']).toBe('ops-eng-new');

    const secretValues = [
      newKey,
      oldKey,
      DEFAULT_E2E_ENV['DOUBAO_API_KEY']!,
      DEFAULT_E2E_ENV['DEEPSEEK_API_KEY']!,
      DEFAULT_E2E_ENV['TONGYI_API_KEY']!,
      DEFAULT_E2E_ENV['ZHIPU_API_KEY']!,
      DEFAULT_E2E_ENV['WENXIN_API_KEY']!,
      DEFAULT_E2E_ENV['DATAFORSEO_LOGIN']!,
      DEFAULT_E2E_ENV['DATAFORSEO_PASSWORD']!,
    ];

    for (const secret of secretValues) {
      expect(enginesNewRes.body).not.toContain(secret);
      expect(enginesOldRes.body).not.toContain(secret);
    }

    const enginesList = extractEnginesList(enginesNewRes.json());
    expect(enginesList).toHaveLength(10);
    const listedNames = enginesList.map((e) => e.engine).sort();
    expect(listedNames).toEqual([...SUPPORTED_ENGINES].sort());
    for (const entry of enginesList) {
      expect(entry.configured ?? entry.enabled).toBe(true);
      expect(['domestic', 'overseas']).toContain(entry.region);
    }

    // 4. Concurrent POST /v1/collect using oldKey and newKey both succeed; revokedKey gets 401
    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({ answerText: '旧密钥请求成功' }),
    );
    harness.upstreams.mockEngineSuccess(
      'tongyi',
      buildTongyiPayload({ answerText: '新密钥请求成功' }),
    );

    const [oldCollect, newCollect, revokedCollect] = await Promise.all([
      harness.collect(
        { engine: 'doubao', prompt: 'worker using old key' },
        { apiKey: oldKey, requestId: 'rot-old-001' },
      ),
      harness.collect(
        { engine: 'tongyi', prompt: 'worker using new key' },
        { apiKey: newKey, requestId: 'rot-new-001' },
      ),
      harness.collect(
        { engine: 'doubao', prompt: 'worker using revoked key' },
        { apiKey: revokedKey, requestId: 'rot-revoked-001' },
      ),
    ]);

    expect(oldCollect.statusCode).toBe(200);
    expect(oldCollect.headers['x-request-id']).toBe('rot-old-001');
    assertValidGeoMixResponse(oldCollect.body, oldCollect.json());

    expect(newCollect.statusCode).toBe(200);
    expect(newCollect.headers['x-request-id']).toBe('rot-new-001');
    assertValidGeoMixResponse(newCollect.body, newCollect.json());

    expect(revokedCollect.statusCode).toBe(401);
    expect(revokedCollect.headers['x-request-id']).toBe('rot-revoked-001');
    expect(errorEnvelopeSchema.parse(revokedCollect.json()).error).toMatchObject({
      code: 'UNAUTHORIZED',
      retryable: false,
      requestId: 'rot-revoked-001',
    });
  });
});
