import { afterEach, describe, expect, it } from 'vitest';
import { assertValidGeoMixResponse } from '../helpers/geomix-schema.js';
import { createE2EHarness } from '../helpers/e2e-harness.js';
import type { E2EHarness } from '../helpers/e2e-harness.js';
import { buildDoubaoPayload } from '../helpers/mock-upstreams.js';

describe('Tier 4 Scenario 5: Graceful Shutdown Readiness Flip (/ready -> 503) & In-Flight Drain', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await harness.close();
      harness = undefined;
    }
  });

  it('flips GET /ready to 503 immediately on shutdown while draining in-flight POST /v1/collect to 200', async () => {
    harness = createE2EHarness();

    // Before shutdown: /ready is 200
    const readyBefore = await harness.getReady();
    expect(readyBefore.statusCode).toBe(200);
    expect(readyBefore.json()).toMatchObject({ ready: true });

    let resolveInFlightStarted!: () => void;
    const inFlightStarted = new Promise<void>((resolve) => {
      resolveInFlightStarted = resolve;
    });

    // Start an in-flight POST /v1/collect with a 250ms upstream delay
    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({ answerText: '优雅停机期间在途请求顺利完成' }),
      {
        delayMs: 250,
        times: 1,
        onRequest: () => {
          resolveInFlightStarted();
        },
      },
    );

    const inFlightPromise = harness.collect(
      { engine: 'doubao', prompt: 'in-flight request during rolling deploy' },
      { requestId: 'drain-inflight-001' },
    );

    // Deterministically wait until the request enters upstream execution, then flip shutdown state
    await inFlightStarted;
    harness.markShuttingDown();

    // Immediately after markShuttingDown(): /ready returns 503, /health remains 200
    const readyDuringShutdown = await harness.getReady();
    expect(readyDuringShutdown.statusCode).toBe(503);
    expect(readyDuringShutdown.json()).toMatchObject({ ready: false });

    const healthDuringShutdown = await harness.getHealth();
    expect(healthDuringShutdown.statusCode).toBe(200);
    expect(healthDuringShutdown.json()).toMatchObject({ status: 'ok', service: 'sonargate' });

    // In-flight request drains cleanly with HTTP 200 and valid GeoMix payload
    const inFlightRes = await inFlightPromise;
    expect(inFlightRes.statusCode).toBe(200);
    expect(inFlightRes.headers['x-request-id']).toBe('drain-inflight-001');
    const parsed = assertValidGeoMixResponse(inFlightRes.body, inFlightRes.json());
    expect(parsed.answerText).toBe('优雅停机期间在途请求顺利完成');
  });

  it('returns 503 on GET /ready when zero engines are configured at startup', async () => {
    harness = createE2EHarness({
      DOUBAO_API_KEY: '',
      DOUBAO_MODEL: '',
      DEEPSEEK_API_KEY: '',
      TONGYI_API_KEY: '',
      ZHIPU_API_KEY: '',
      WENXIN_API_KEY: '',
      DATAFORSEO_LOGIN: '',
      DATAFORSEO_PASSWORD: '',
    });

    const readyRes = await harness.getReady();
    expect(readyRes.statusCode).toBe(503);
    const readyJson = readyRes.json() as Record<string, unknown>;
    expect(readyJson['ready']).toBe(false);
    expect(readyJson['configuredCount']).toBe(0);
    expect(readyJson['totalSupported']).toBe(10);

    // /health still reports liveness
    const healthRes = await harness.getHealth();
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json()).toMatchObject({ status: 'ok', service: 'sonargate' });
  });
});
