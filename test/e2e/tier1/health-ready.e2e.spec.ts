import { afterEach, describe, expect, it } from 'vitest';
import { createE2EHarness } from '../helpers/e2e-harness.js';
import type { E2EHarness } from '../helpers/e2e-harness.js';

const UNCONFIGURED_ALL_ENV: Record<string, string> = {
  DOUBAO_API_KEY: '',
  DOUBAO_MODEL: '',
  DEEPSEEK_API_KEY: '',
  TONGYI_API_KEY: '',
  ZHIPU_API_KEY: '',
  WENXIN_API_KEY: '',
  DATAFORSEO_LOGIN: '',
  DATAFORSEO_PASSWORD: '',
};

describe('Tier 1 — Health & Readiness endpoints', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.close();
      harness = undefined;
    }
  });

  it('GET /health returns 200 without authentication and reports service metadata', async () => {
    harness = createE2EHarness();

    const res = await harness.getHealth();

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(body['service']).toBe('sonargate');
    expect(typeof body['version']).toBe('string');
    expect((body['version'] as string).length).toBeGreaterThan(0);
    expect(typeof body['uptimeSec']).toBe('number');
    expect(body['uptimeSec'] as number).toBeGreaterThanOrEqual(0);
  });

  it('GET /ready returns 200 without authentication when all 10 engines are configured', async () => {
    harness = createE2EHarness();

    const res = await harness.getReady();

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['ready']).toBe(true);
    expect(body['configuredCount']).toBe(10);
    expect(body['totalSupported']).toBe(10);
  });

  it('GET /ready returns 200 when at least one engine is configured', async () => {
    harness = createE2EHarness({
      ...UNCONFIGURED_ALL_ENV,
      DEEPSEEK_API_KEY: 'e2e-single-deepseek-key',
    });

    const res = await harness.getReady();

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['ready']).toBe(true);
    expect(body['configuredCount']).toBe(1);
    expect(body['totalSupported']).toBe(10);
  });

  it('GET /ready returns 503 when zero engines are configured', async () => {
    harness = createE2EHarness(UNCONFIGURED_ALL_ENV);

    const res = await harness.getReady();

    expect(res.statusCode).toBe(503);
    const body = res.json() as Record<string, unknown>;
    expect(body['ready']).toBe(false);
    expect(body['configuredCount']).toBe(0);
    expect(body['totalSupported']).toBe(10);
  });

  it('GET /ready flips to 503 after markShuttingDown() is invoked', async () => {
    harness = createE2EHarness();

    const before = await harness.getReady();
    expect(before.statusCode).toBe(200);

    harness.markShuttingDown();

    const after = await harness.getReady();
    expect(after.statusCode).toBe(503);
    const body = after.json() as Record<string, unknown>;
    expect(body['ready']).toBe(false);
    expect(body['totalSupported']).toBe(10);
  });
});
