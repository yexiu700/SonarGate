import { afterEach, describe, expect, it } from 'vitest';
import { createE2EHarness } from '../helpers/e2e-harness.js';
import type { E2EHarness } from '../helpers/e2e-harness.js';
import { assertValidGeoMixResponse, errorEnvelopeSchema } from '../helpers/geomix-schema.js';
import { buildDeepseekPayload } from '../helpers/mock-upstreams.js';

describe('Tier 2 — Timeout, Retry Budget & Semaphore Queue Boundaries', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.close();
      harness = undefined;
    }
  });

  it('retries after a transient 503 and succeeds with rawMeta.attempts >= 2', async () => {
    harness = createE2EHarness({
      MAX_UPSTREAM_RETRIES: '2',
      RETRY_BASE_DELAY_MS: '50',
    });

    harness.upstreams.mockEngineReply(
      'deepseek',
      503,
      { error: { message: 'Service temporarily unavailable' } },
      { times: 1 },
    );
    harness.upstreams.mockEngineSuccess(
      'deepseek',
      buildDeepseekPayload({ answerText: '重试后成功返回内容' }),
      { times: 1 },
    );

    const res = await harness.collect({
      engine: 'deepseek',
      prompt: 'transient 503 retry recovery',
    });

    expect(res.statusCode).toBe(200);
    const parsed = assertValidGeoMixResponse(res.body, res.json());
    expect(parsed.answerText).toContain('重试后成功返回内容');
    expect(parsed.rawMeta?.['attempts']).toBeGreaterThanOrEqual(2);
    expect(harness.upstreams.getHitCount('deepseek')).toBe(2);
  });

  it('retries after a transient 429 and succeeds with rawMeta.attempts >= 2', async () => {
    harness = createE2EHarness({
      MAX_UPSTREAM_RETRIES: '2',
      RETRY_BASE_DELAY_MS: '50',
    });

    harness.upstreams.mockEngineReply(
      'deepseek',
      429,
      { error: { message: 'Too Many Requests' } },
      { times: 1 },
    );
    harness.upstreams.mockEngineSuccess(
      'deepseek',
      buildDeepseekPayload({ answerText: '限流重试成功内容' }),
      { times: 1 },
    );

    const res = await harness.collect({
      engine: 'deepseek',
      prompt: 'transient 429 retry recovery',
    });

    expect(res.statusCode).toBe(200);
    const parsed = assertValidGeoMixResponse(res.body, res.json());
    expect(parsed.answerText).toContain('限流重试成功内容');
    expect(parsed.rawMeta?.['attempts']).toBeGreaterThanOrEqual(2);
    expect(harness.upstreams.getHitCount('deepseek')).toBe(2);
  });

  it('returns 502 UPSTREAM_BAD_RESPONSE when retry budget is exhausted', async () => {
    harness = createE2EHarness({
      MAX_UPSTREAM_RETRIES: '1',
      RETRY_BASE_DELAY_MS: '50',
    });

    harness.upstreams.mockEngineReply(
      'deepseek',
      502,
      { error: { message: 'Bad Gateway' } },
      { times: 2 },
    );

    const res = await harness.collect({
      engine: 'deepseek',
      prompt: 'exhausted retries test',
    });

    expect(res.statusCode).toBe(502);
    const envelope = errorEnvelopeSchema.parse(res.json());
    expect(envelope.error.code).toBe('UPSTREAM_BAD_RESPONSE');
    expect(envelope.error.retryable).toBe(true);
    expect(harness.upstreams.getHitCount('deepseek')).toBe(2);
  });

  it('returns 408 UPSTREAM_TIMEOUT when upstream exceeds DOMESTIC_TIMEOUT_MS', async () => {
    harness = createE2EHarness({
      DOMESTIC_TIMEOUT_MS: '1000',
      MAX_UPSTREAM_RETRIES: '0',
    });

    harness.upstreams.mockEngineSuccess('deepseek', undefined, { delayMs: 1400 });

    const res = await harness.collect({
      engine: 'deepseek',
      prompt: 'upstream timeout boundary test',
    });

    expect(res.statusCode).toBe(408);
    const envelope = errorEnvelopeSchema.parse(res.json());
    expect(envelope.error.code).toBe('UPSTREAM_TIMEOUT');
    expect(envelope.error.retryable).toBe(true);
  });

  it('triggers deadline circuit-breaker (remainingMs - delayMs < 12_000) without retrying', async () => {
    harness = createE2EHarness({
      GATEWAY_REQUEST_TIMEOUT_MS: '11000',
      MAX_UPSTREAM_RETRIES: '2',
      RETRY_BASE_DELAY_MS: '100',
    });

    harness.upstreams.mockEngineReply(
      'deepseek',
      503,
      { error: { message: 'Transient 503 under tight deadline' } },
      { persist: true },
    );

    const startedAt = Date.now();
    const res = await harness.collect({
      engine: 'deepseek',
      prompt: 'deadline circuit breaker test',
    });
    const elapsedMs = Date.now() - startedAt;

    expect(res.statusCode).toBe(502);
    const envelope = errorEnvelopeSchema.parse(res.json());
    expect(envelope.error.code).toBe('UPSTREAM_BAD_RESPONSE');
    expect(harness.upstreams.getHitCount('deepseek')).toBe(1);
    expect(elapsedMs).toBeLessThan(3000);
  });

  it('enforces per-engine domestic semaphore queue timeout with 429 RATE_LIMITED', async () => {
    harness = createE2EHarness({
      DOMESTIC_CONCURRENCY_PER_ENGINE: '1',
      SEMAPHORE_WAIT_MS: '150',
      MAX_UPSTREAM_RETRIES: '0',
    });

    let onFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      onFirstStarted = resolve;
    });

    harness.upstreams.mockEngineSuccess('deepseek', undefined, {
      delayMs: 400,
      times: 2,
      onRequest: () => {
        onFirstStarted();
      },
    });

    const firstPromise = harness.collect({
      engine: 'deepseek',
      prompt: 'domestic semaphore holder prompt',
    });

    await firstStarted;

    const secondPromise = harness.collect({
      engine: 'deepseek',
      prompt: 'domestic semaphore waiter distinct prompt',
    });

    const [firstRes, secondRes] = await Promise.all([firstPromise, secondPromise]);

    expect(firstRes.statusCode).toBe(200);
    assertValidGeoMixResponse(firstRes.body, firstRes.json());

    expect(secondRes.statusCode).toBe(429);
    const envelope = errorEnvelopeSchema.parse(secondRes.json());
    expect(envelope.error.code).toBe('RATE_LIMITED');
    expect(envelope.error.retryable).toBe(true);
  });

  it('enforces shared overseas DataForSEO semaphore across distinct overseas engines', async () => {
    harness = createE2EHarness({
      DATAFORSEO_CONCURRENCY: '1',
      SEMAPHORE_WAIT_MS: '150',
      MAX_UPSTREAM_RETRIES: '0',
    });

    let onFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      onFirstStarted = resolve;
    });

    harness.upstreams.mockEngineSuccess('chatgpt', undefined, {
      delayMs: 400,
      onRequest: () => {
        onFirstStarted();
      },
    });
    harness.upstreams.mockEngineSuccess('perplexity', undefined, { delayMs: 50 });

    const chatgptPromise = harness.collect({
      engine: 'chatgpt',
      prompt: 'shared overseas semaphore holder',
    });

    await firstStarted;

    const perplexityPromise = harness.collect({
      engine: 'perplexity',
      prompt: 'shared overseas semaphore contender',
    });

    const [chatgptRes, perplexityRes] = await Promise.all([chatgptPromise, perplexityPromise]);

    expect(chatgptRes.statusCode).toBe(200);
    assertValidGeoMixResponse(chatgptRes.body, chatgptRes.json());

    expect(perplexityRes.statusCode).toBe(429);
    const envelope = errorEnvelopeSchema.parse(perplexityRes.json());
    expect(envelope.error.code).toBe('RATE_LIMITED');
    expect(envelope.error.retryable).toBe(true);
  });
});
