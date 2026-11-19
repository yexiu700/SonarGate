import { afterEach, describe, expect, it } from 'vitest';
import { assertValidGeoMixResponse, errorEnvelopeSchema } from '../helpers/geomix-schema.js';
import { createE2EHarness } from '../helpers/e2e-harness.js';
import type { E2EHarness } from '../helpers/e2e-harness.js';
import {
  buildChatGptPayload,
  buildClaudePayload,
  buildDeepseekPayload,
  buildDoubaoPayload,
  buildTongyiPayload,
  buildZhipuPayload,
} from '../helpers/mock-upstreams.js';

describe('Tier 3: Multi-Engine Semaphore Isolation (Domestic Per-Engine vs Overseas Shared)', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await harness.close();
      harness = undefined;
    }
  });

  it('isolates domestic engines per-engine so saturating doubao does not block deepseek or tongyi', async () => {
    harness = createE2EHarness({
      DOMESTIC_CONCURRENCY_PER_ENGINE: '1',
      SEMAPHORE_WAIT_MS: '150',
      MAX_UPSTREAM_RETRIES: '0',
    });

    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({ answerText: '豆包慢速占用回答' }),
      { delayMs: 400, persist: true },
    );
    harness.upstreams.mockEngineSuccess(
      'deepseek',
      buildDeepseekPayload({ answerText: 'DeepSeek 独立并发正常返回' }),
      { delayMs: 10 },
    );
    harness.upstreams.mockEngineSuccess(
      'tongyi',
      buildTongyiPayload({ answerText: '通义独立并发正常返回' }),
      { delayMs: 10 },
    );

    const [doubaoFirst, doubaoSecond, deepseekRes, tongyiRes] = await Promise.all([
      harness.collect({ engine: 'doubao', prompt: 'doubao saturate 1' }),
      harness.collect({ engine: 'doubao', prompt: 'doubao saturate 2' }),
      harness.collect({ engine: 'deepseek', prompt: 'deepseek unaffected' }),
      harness.collect({ engine: 'tongyi', prompt: 'tongyi unaffected' }),
    ]);

    expect(deepseekRes.statusCode).toBe(200);
    assertValidGeoMixResponse(deepseekRes.body, deepseekRes.json());

    expect(tongyiRes.statusCode).toBe(200);
    assertValidGeoMixResponse(tongyiRes.body, tongyiRes.json());

    const doubaoStatuses = [doubaoFirst.statusCode, doubaoSecond.statusCode].sort((a, b) => a - b);
    expect(doubaoStatuses).toEqual([200, 429]);

    const rejectedDoubao = doubaoFirst.statusCode === 429 ? doubaoFirst : doubaoSecond;
    const err = errorEnvelopeSchema.parse(rejectedDoubao.json());
    expect(err.error.code).toBe('RATE_LIMITED');
    expect(err.error.retryable).toBe(true);
    expect(harness.upstreams.getHitCount('doubao')).toBe(1);
  });

  it('isolates domestic engines from a saturated overseas DataForSEO pool', async () => {
    harness = createE2EHarness({
      DATAFORSEO_CONCURRENCY: '1',
      SEMAPHORE_WAIT_MS: '150',
      MAX_UPSTREAM_RETRIES: '0',
    });

    harness.upstreams.mockEngineSuccess(
      'chatgpt',
      buildChatGptPayload({ answerText: 'ChatGPT holding overseas pool' }),
      { delayMs: 400 },
    );
    harness.upstreams.mockEngineSuccess(
      'zhipu',
      buildZhipuPayload({ answerText: '智谱不受海外池饱和影响' }),
      { delayMs: 10 },
    );

    const [chatgptRes, zhipuRes] = await Promise.all([
      harness.collect({ engine: 'chatgpt', prompt: 'overseas slow prompt' }),
      harness.collect({ engine: 'zhipu', prompt: 'domestic fast prompt' }),
    ]);

    expect(chatgptRes.statusCode).toBe(200);
    assertValidGeoMixResponse(chatgptRes.body, chatgptRes.json());

    expect(zhipuRes.statusCode).toBe(200);
    assertValidGeoMixResponse(zhipuRes.body, zhipuRes.json());
  });

  it('shares a single DataForSEO semaphore across distinct overseas engines (chatgpt blocks claude)', async () => {
    harness = createE2EHarness({
      DATAFORSEO_CONCURRENCY: '1',
      SEMAPHORE_WAIT_MS: '150',
      MAX_UPSTREAM_RETRIES: '0',
    });

    let resolveFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });

    harness.upstreams.mockEngineSuccess(
      'chatgpt',
      buildChatGptPayload({ answerText: 'ChatGPT holds shared DataForSEO semaphore' }),
      {
        delayMs: 400,
        onRequest: () => {
          resolveFirstStarted();
        },
      },
    );
    harness.upstreams.mockEngineSuccess(
      'claude',
      buildClaudePayload({ answerText: 'Claude should time out waiting for shared pool' }),
      { delayMs: 10 },
    );

    const chatgptPromise = harness.collect({
      engine: 'chatgpt',
      prompt: 'occupy shared overseas slot',
    });
    // Deterministically wait until chatgpt has acquired the single DataForSEO slot and hit upstream
    await firstStarted;
    const claudePromise = harness.collect({
      engine: 'claude',
      prompt: 'blocked on shared overseas slot',
    });

    const [chatgptRes, claudeRes] = await Promise.all([chatgptPromise, claudePromise]);

    expect(chatgptRes.statusCode).toBe(200);
    assertValidGeoMixResponse(chatgptRes.body, chatgptRes.json());

    expect(claudeRes.statusCode).toBe(429);
    const err = errorEnvelopeSchema.parse(claudeRes.json());
    expect(err.error.code).toBe('RATE_LIMITED');
    expect(err.error.retryable).toBe(true);
    expect(harness.upstreams.getHitCount('claude')).toBe(0);
  });
});
