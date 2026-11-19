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

describe('Tier 4 Scenario 3: Partial-Degradation Production Batch & GeoMix Error Taxonomy', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await harness.close();
      harness = undefined;
    }
  });

  it('isolates faults across a 7-engine noisy GeoMix batch while healthy/retryable engines recover cleanly', async () => {
    harness = createE2EHarness({
      WENXIN_API_KEY: '',
      MAX_UPSTREAM_RETRIES: '2',
      RETRY_BASE_DELAY_MS: '50',
    });

    // 1. doubao: clean 200
    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({ answerText: '豆包健康引擎正常返回结果' }),
      { times: 1 },
    );

    // 2. tongyi: transient 503 -> retries and recovers (200, attempts: 2)
    harness.upstreams.mockEngineReply('tongyi', 503, { error: 'upstream busy' }, { times: 1 });
    harness.upstreams.mockEngineSuccess(
      'tongyi',
      buildTongyiPayload({ answerText: '通义短暂 503 后重试恢复成功' }),
      { times: 1 },
    );

    // 3. chatgpt: DataForSEO 42900 -> retries and recovers (200, attempts: 2, costUsd present)
    harness.upstreams.mockEngineReply(
      'chatgpt',
      200,
      buildDataForSeoTaskErrorPayload(42900, 'Rate limit exceeded'),
      { times: 1 },
    );
    harness.upstreams.mockEngineSuccess(
      'chatgpt',
      buildChatGptPayload({ answerText: 'ChatGPT recovered after 42900', costUsd: 0.024 }),
      { times: 1 },
    );

    // 4. zhipu: expired vendor key (upstream 401) -> 503 UPSTREAM_AUTH_OR_QUOTA (NEVER 401!)
    harness.upstreams.mockEngineReply(
      'zhipu',
      401,
      { error: { message: 'Invalid API key' } },
      { persist: true },
    );

    // 5. claude: DataForSEO 40200 (balance exhausted) -> 503 UPSTREAM_AUTH_OR_QUOTA
    harness.upstreams.mockEngineReply(
      'claude',
      200,
      buildDataForSeoTaskErrorPayload(40200, 'Payment required / insufficient balance'),
      { persist: true },
    );

    // 6. wenxin: unconfigured -> 501 ENGINE_NOT_CONFIGURED (no upstream call)
    // 7. yuanbao: unsupported legacy engine -> 400 UNSUPPORTED_ENGINE (no upstream call)

    const [doubaoRes, tongyiRes, chatgptRes, zhipuRes, claudeRes, wenxinRes, yuanbaoRes] =
      await Promise.all([
        harness.collect(
          { engine: 'doubao', prompt: '品牌可见度批量采集' },
          { requestId: 'batch-doubao' },
        ),
        harness.collect(
          { engine: 'tongyi', prompt: '品牌可见度批量采集' },
          { requestId: 'batch-tongyi' },
        ),
        harness.collect(
          { engine: 'chatgpt', prompt: 'Brand visibility batch collect' },
          { requestId: 'batch-chatgpt' },
        ),
        harness.collect(
          { engine: 'zhipu', prompt: '品牌可见度批量采集' },
          { requestId: 'batch-zhipu' },
        ),
        harness.collect(
          { engine: 'claude', prompt: 'Brand visibility batch collect' },
          { requestId: 'batch-claude' },
        ),
        harness.collect(
          { engine: 'wenxin', prompt: '品牌可见度批量采集' },
          { requestId: 'batch-wenxin' },
        ),
        harness.collect(
          { engine: 'yuanbao', prompt: '品牌可见度批量采集' },
          { requestId: 'batch-yuanbao' },
        ),
      ]);

    // 1. doubao
    expect(doubaoRes.statusCode).toBe(200);
    const doubaoParsed = assertValidGeoMixResponse(doubaoRes.body, doubaoRes.json());
    expect(doubaoParsed.answerText).toBe('豆包健康引擎正常返回结果');
    expect(doubaoParsed.rawMeta?.['attempts']).toBe(1);

    // 2. tongyi
    expect(tongyiRes.statusCode).toBe(200);
    const tongyiParsed = assertValidGeoMixResponse(tongyiRes.body, tongyiRes.json());
    expect(tongyiParsed.answerText).toBe('通义短暂 503 后重试恢复成功');
    expect(tongyiParsed.rawMeta?.['attempts']).toBe(2);
    expect(harness.upstreams.getHitCount('tongyi')).toBe(2);

    // 3. chatgpt
    expect(chatgptRes.statusCode).toBe(200);
    const chatgptParsed = assertValidGeoMixResponse(chatgptRes.body, chatgptRes.json());
    expect(chatgptParsed.answerText).toBe('ChatGPT recovered after 42900');
    expect(chatgptParsed.rawMeta?.['attempts']).toBe(2);
    expect(chatgptParsed.rawMeta?.['costUsd']).toBeCloseTo(0.024, 6);
    expect(harness.upstreams.getHitCount('chatgpt')).toBe(2);

    // 4. zhipu -> 503 UPSTREAM_AUTH_OR_QUOTA (not 401, no retry)
    expect(zhipuRes.statusCode).toBe(503);
    expect(errorEnvelopeSchema.parse(zhipuRes.json()).error).toMatchObject({
      code: 'UPSTREAM_AUTH_OR_QUOTA',
      retryable: false,
      requestId: 'batch-zhipu',
    });
    expect(harness.upstreams.getHitCount('zhipu')).toBe(1);

    // 5. claude -> 503 UPSTREAM_AUTH_OR_QUOTA (no retry)
    expect(claudeRes.statusCode).toBe(503);
    expect(errorEnvelopeSchema.parse(claudeRes.json()).error).toMatchObject({
      code: 'UPSTREAM_AUTH_OR_QUOTA',
      retryable: false,
      requestId: 'batch-claude',
    });
    expect(harness.upstreams.getHitCount('claude')).toBe(1);

    // 6. wenxin -> 501 ENGINE_NOT_CONFIGURED
    expect(wenxinRes.statusCode).toBe(501);
    expect(errorEnvelopeSchema.parse(wenxinRes.json()).error).toMatchObject({
      code: 'ENGINE_NOT_CONFIGURED',
      retryable: false,
      engine: 'wenxin',
      requestId: 'batch-wenxin',
    });
    expect(harness.upstreams.getHitCount('wenxin')).toBe(0);

    // 7. yuanbao -> 400 UNSUPPORTED_ENGINE
    expect(yuanbaoRes.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(yuanbaoRes.json()).error).toMatchObject({
      code: 'UNSUPPORTED_ENGINE',
      retryable: false,
      requestId: 'batch-yuanbao',
    });
  });
});
