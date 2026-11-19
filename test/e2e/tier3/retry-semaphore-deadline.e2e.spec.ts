import { afterEach, describe, expect, it } from 'vitest';
import { assertValidGeoMixResponse, errorEnvelopeSchema } from '../helpers/geomix-schema.js';
import { createE2EHarness } from '../helpers/e2e-harness.js';
import type { E2EHarness } from '../helpers/e2e-harness.js';
import {
  buildChatGptPayload,
  buildDataForSeoTaskErrorPayload,
  buildDoubaoPayload,
  buildTongyiPayload,
} from '../helpers/mock-upstreams.js';

describe('Tier 3: Retry + Semaphore + Deadline Budget + Singleflight', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await harness.close();
      harness = undefined;
    }
  });

  it('retries transient HTTP/network/DataForSEO errors and reports exact rawMeta.attempts on recovery', async () => {
    harness = createE2EHarness({
      MAX_UPSTREAM_RETRIES: '2',
      RETRY_BASE_DELAY_MS: '50',
    });

    // Domestic tongyi: 503 -> ECONNRESET -> 200 (3 attempts)
    harness.upstreams.mockEngineReply('tongyi', 503, { error: 'temporary overload' }, { times: 1 });
    const connResetErr = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    harness.upstreams.mockEngineNetworkError('tongyi', connResetErr, { times: 1 });
    harness.upstreams.mockEngineSuccess(
      'tongyi',
      buildTongyiPayload({ answerText: '通义第三次尝试恢复成功' }),
      { times: 1 },
    );

    const tongyiRes = await harness.collect({ engine: 'tongyi', prompt: 'retry recovery test' });
    expect(tongyiRes.statusCode).toBe(200);
    const tongyiParsed = assertValidGeoMixResponse(tongyiRes.body, tongyiRes.json());
    expect(tongyiParsed.answerText).toBe('通义第三次尝试恢复成功');
    expect(tongyiParsed.rawMeta?.['attempts']).toBe(3);
    expect(harness.upstreams.getHitCount('tongyi')).toBe(3);

    // Overseas chatgpt: DataForSEO 42900 -> 200 (2 attempts)
    harness.upstreams.mockEngineReply(
      'chatgpt',
      200,
      buildDataForSeoTaskErrorPayload(42900, 'Rate limit exceeded'),
      { times: 1 },
    );
    harness.upstreams.mockEngineSuccess(
      'chatgpt',
      buildChatGptPayload({ answerText: 'ChatGPT recovered on attempt 2', costUsd: 0.022 }),
      { times: 1 },
    );

    const chatgptRes = await harness.collect({ engine: 'chatgpt', prompt: 'dfs 42900 recovery' });
    expect(chatgptRes.statusCode).toBe(200);
    const chatgptParsed = assertValidGeoMixResponse(chatgptRes.body, chatgptRes.json());
    expect(chatgptParsed.answerText).toBe('ChatGPT recovered on attempt 2');
    expect(chatgptParsed.rawMeta?.['attempts']).toBe(2);
    expect(harness.upstreams.getHitCount('chatgpt')).toBe(2);

    // Retry-After header support on HTTP 429 -> 200 (2 attempts)
    harness.upstreams.mockEngineReply(
      'doubao',
      429,
      { error: 'rate limited' },
      { times: 1, headers: { 'retry-after': '0' } },
    );
    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({ answerText: '豆包遵循 Retry-After 后恢复成功' }),
      { times: 1 },
    );

    const doubaoRes = await harness.collect({ engine: 'doubao', prompt: 'retry-after test' });
    expect(doubaoRes.statusCode).toBe(200);
    const doubaoParsed = assertValidGeoMixResponse(doubaoRes.body, doubaoRes.json());
    expect(doubaoParsed.rawMeta?.['attempts']).toBe(2);
    expect(harness.upstreams.getHitCount('doubao')).toBe(2);
  });

  it('never retries non-retryable upstream errors (exact 1 upstream call)', async () => {
    harness = createE2EHarness({
      MAX_UPSTREAM_RETRIES: '2',
      RETRY_BASE_DELAY_MS: '50',
    });

    harness.upstreams.mockEngineReply(
      'deepseek',
      401,
      { error: 'unauthorized' },
      { persist: true },
    );
    const deepseekRes = await harness.collect({ engine: 'deepseek', prompt: 'no retry 401' });
    expect(deepseekRes.statusCode).toBe(503);
    expect(errorEnvelopeSchema.parse(deepseekRes.json()).error).toMatchObject({
      code: 'UPSTREAM_AUTH_OR_QUOTA',
      retryable: false,
    });
    expect(harness.upstreams.getHitCount('deepseek')).toBe(1);

    harness.upstreams.mockEngineReply('wenxin', 403, { error: 'forbidden' }, { persist: true });
    const wenxinRes = await harness.collect({ engine: 'wenxin', prompt: 'no retry 403' });
    expect(wenxinRes.statusCode).toBe(503);
    expect(errorEnvelopeSchema.parse(wenxinRes.json()).error).toMatchObject({
      code: 'UPSTREAM_AUTH_OR_QUOTA',
      retryable: false,
    });
    expect(harness.upstreams.getHitCount('wenxin')).toBe(1);

    harness.upstreams.mockEngineReply('zhipu', 400, { error: 'bad request' }, { persist: true });
    const zhipuRes = await harness.collect({ engine: 'zhipu', prompt: 'no retry 400' });
    expect(zhipuRes.statusCode).toBeGreaterThanOrEqual(400);
    expect(errorEnvelopeSchema.parse(zhipuRes.json()).error.retryable).toBe(false);
    expect(harness.upstreams.getHitCount('zhipu')).toBe(1);

    harness.upstreams.mockEngineReply(
      'claude',
      200,
      buildDataForSeoTaskErrorPayload(40200, 'Insufficient balance'),
      { persist: true },
    );
    const claudeRes = await harness.collect({ engine: 'claude', prompt: 'no retry dfs 40200' });
    expect(claudeRes.statusCode).toBe(503);
    expect(errorEnvelopeSchema.parse(claudeRes.json()).error).toMatchObject({
      code: 'UPSTREAM_AUTH_OR_QUOTA',
      retryable: false,
    });
    expect(harness.upstreams.getHitCount('claude')).toBe(1);

    harness.upstreams.mockEngineReply(
      'perplexity',
      200,
      buildDataForSeoTaskErrorPayload(40000, 'Invalid task parameters'),
      { persist: true },
    );
    const perplexityRes = await harness.collect({
      engine: 'perplexity',
      prompt: 'no retry dfs 40000',
    });
    expect(perplexityRes.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(perplexityRes.json()).error).toMatchObject({
      code: 'INVALID_REQUEST',
      retryable: false,
    });
    expect(harness.upstreams.getHitCount('perplexity')).toBe(1);
  });

  it('aborts retry immediately when remaining deadline budget after backoff falls below 12000ms', async () => {
    harness = createE2EHarness({
      GATEWAY_REQUEST_TIMEOUT_MS: '12500',
      RETRY_BASE_DELAY_MS: '1000',
      MAX_UPSTREAM_RETRIES: '2',
    });

    harness.upstreams.mockEngineReply(
      'doubao',
      503,
      { error: 'service unavailable' },
      { delayMs: 100, persist: true },
    );

    const startMs = Date.now();
    const res = await harness.collect({ engine: 'doubao', prompt: 'deadline circuit breaker' });
    const elapsedMs = Date.now() - startMs;

    expect(res.statusCode).toBe(502);
    const err = errorEnvelopeSchema.parse(res.json());
    expect(err.error.code).toBe('UPSTREAM_BAD_RESPONSE');
    expect(err.error.retryable).toBe(true);
    expect(harness.upstreams.getHitCount('doubao')).toBe(1);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('queues concurrent distinct requests through semaphore during retry and returns 429 on wait timeout', async () => {
    // Subcase A: Request B waits for Request A (which retries once) and succeeds
    harness = createE2EHarness({
      DOMESTIC_CONCURRENCY_PER_ENGINE: '1',
      SEMAPHORE_WAIT_MS: '1500',
      RETRY_BASE_DELAY_MS: '50',
      MAX_UPSTREAM_RETRIES: '2',
    });

    harness.upstreams.mockEngineReply(
      'doubao',
      503,
      { error: 'transient' },
      { delayMs: 40, times: 1 },
    );
    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({ answerText: '豆包请求 A 重试成功' }),
      { delayMs: 40, times: 1 },
    );
    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({ answerText: '豆包请求 B 排队成功' }),
      { delayMs: 20, times: 1 },
    );

    const [resA, resB] = await Promise.all([
      harness.collect({ engine: 'doubao', prompt: 'prompt A with retry' }),
      harness.collect({ engine: 'doubao', prompt: 'prompt B queued behind A' }),
    ]);

    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);
    assertValidGeoMixResponse(resA.body, resA.json());
    assertValidGeoMixResponse(resB.body, resB.json());
    expect(harness.upstreams.getHitCount('doubao')).toBe(3);

    await harness.close();
    harness = undefined;

    // Subcase B: Request B exceeds SEMAPHORE_WAIT_MS and fails with 429 RATE_LIMITED
    harness = createE2EHarness({
      DOMESTIC_CONCURRENCY_PER_ENGINE: '1',
      SEMAPHORE_WAIT_MS: '150',
      MAX_UPSTREAM_RETRIES: '0',
    });

    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({ answerText: '慢速请求占用信号量' }),
      { delayMs: 400, persist: true },
    );

    const [slowRes, timedOutRes] = await Promise.all([
      harness.collect({ engine: 'doubao', prompt: 'slow slot holder' }),
      harness.collect({ engine: 'doubao', prompt: 'distinct queued waiter' }),
    ]);

    const statuses = [slowRes.statusCode, timedOutRes.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 429]);

    const rateLimitedRes = slowRes.statusCode === 429 ? slowRes : timedOutRes;
    const err = errorEnvelopeSchema.parse(rateLimitedRes.json());
    expect(err.error.code).toBe('RATE_LIMITED');
    expect(err.error.retryable).toBe(true);
    expect(harness.upstreams.getHitCount('doubao')).toBe(1);
  });

  it('runs singleflight before semaphore so 5 identical concurrent requests succeed under concurrency=1', async () => {
    harness = createE2EHarness({
      DOMESTIC_CONCURRENCY_PER_ENGINE: '1',
      SEMAPHORE_WAIT_MS: '150',
    });

    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({ answerText: '单飞优先于信号量验证回答' }),
      { delayMs: 300, times: 1 },
    );

    const body = { engine: 'doubao', prompt: 'identical singleflight before semaphore' };
    const responses = await Promise.all([
      harness.collect(body),
      harness.collect(body),
      harness.collect(body),
      harness.collect(body),
      harness.collect(body),
    ]);

    expect(harness.upstreams.getHitCount('doubao')).toBe(1);
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
      const parsed = assertValidGeoMixResponse(res.body, res.json());
      expect(parsed.answerText).toBe('单飞优先于信号量验证回答');
    }
  });

  it('returns 408 UPSTREAM_TIMEOUT when upstream exceeds configured timeout', async () => {
    harness = createE2EHarness({
      DOMESTIC_TIMEOUT_MS: '1000',
      GATEWAY_REQUEST_TIMEOUT_MS: '2000',
      MAX_UPSTREAM_RETRIES: '0',
    });

    harness.upstreams.mockEngineSuccess('tongyi', buildTongyiPayload(), {
      delayMs: 1500,
      times: 1,
    });

    const res = await harness.collect({ engine: 'tongyi', prompt: 'trigger timeout' });
    expect(res.statusCode).toBe(408);
    const err = errorEnvelopeSchema.parse(res.json());
    expect(err.error.code).toBe('UPSTREAM_TIMEOUT');
    expect(err.error.retryable).toBe(true);
  });
});
