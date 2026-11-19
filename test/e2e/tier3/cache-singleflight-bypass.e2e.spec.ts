import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertPassesGeoMixTopicRelevanceFallback,
  assertValidGeoMixResponse,
  errorEnvelopeSchema,
} from '../helpers/geomix-schema.js';
import { createE2EHarness } from '../helpers/e2e-harness.js';
import type { E2EHarness } from '../helpers/e2e-harness.js';
import {
  buildChatGptPayload,
  buildClaudePayload,
  buildDeepseekPayload,
  buildDoubaoPayload,
  buildGoogleAioNoAioPayload,
  buildGoogleAioPayload,
  buildTongyiPayload,
  buildWenxinPayload,
  buildZhipuPayload,
} from '../helpers/mock-upstreams.js';

describe('Tier 3: Cache + Singleflight + Bypass + google_aio Short TTL', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (harness !== undefined) {
      await harness.close();
      harness = undefined;
    }
  });

  it('collapses concurrent identical requests via singleflight and serves subsequent sequential call from LRU cache', async () => {
    harness = createE2EHarness({ CACHE_TTL_SECONDS: '600' });
    const expectedAnswer = '豆包单飞与缓存联调回答：2026 年中小企业 CRM 选型核心建议。';
    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({ answerText: expectedAnswer }),
      { delayMs: 80, times: 1 },
    );

    const payload = { engine: 'doubao', prompt: '2026 中小企业 CRM 选型建议' };
    const concurrentResponses = await Promise.all([
      harness.collect(payload),
      harness.collect(payload),
      harness.collect(payload),
      harness.collect(payload),
    ]);

    expect(harness.upstreams.getHitCount('doubao')).toBe(1);
    for (const res of concurrentResponses) {
      expect(res.statusCode).toBe(200);
      const parsed = assertValidGeoMixResponse(res.body, res.json());
      expect(parsed.answerText).toBe(expectedAnswer);
      expect(parsed.rawMeta?.['cached']).toBe(false);
    }

    const cachedRes = await harness.collect(payload);
    expect(cachedRes.statusCode).toBe(200);
    const cachedParsed = assertValidGeoMixResponse(cachedRes.body, cachedRes.json());
    expect(cachedParsed.answerText).toBe(expectedAnswer);
    expect(cachedParsed.rawMeta?.['cached']).toBe(true);
    expect(harness.upstreams.getHitCount('doubao')).toBe(1);
  });

  it('skips cache read on X-Bypass-Cache: true and writes back refreshed response', async () => {
    harness = createE2EHarness({ CACHE_TTL_SECONDS: '600' });
    harness.upstreams.mockEngineSuccess(
      'deepseek',
      buildDeepseekPayload({ answerText: 'DeepSeek 首次缓存回答' }),
      { times: 1 },
    );
    harness.upstreams.mockEngineSuccess(
      'deepseek',
      buildDeepseekPayload({ answerText: 'DeepSeek 通过请求头刷新后的回答' }),
      { times: 1 },
    );

    const body = { engine: 'deepseek', prompt: '企业 CRM 如何选型' };

    const first = await harness.collect(body);
    expect(first.statusCode).toBe(200);
    const firstParsed = assertValidGeoMixResponse(first.body, first.json());
    expect(firstParsed.answerText).toBe('DeepSeek 首次缓存回答');
    expect(firstParsed.rawMeta?.['cached']).toBe(false);
    expect(harness.upstreams.getHitCount('deepseek')).toBe(1);

    const second = await harness.collect(body);
    expect(second.statusCode).toBe(200);
    const secondParsed = assertValidGeoMixResponse(second.body, second.json());
    expect(secondParsed.answerText).toBe('DeepSeek 首次缓存回答');
    expect(secondParsed.rawMeta?.['cached']).toBe(true);
    expect(harness.upstreams.getHitCount('deepseek')).toBe(1);

    const bypassed = await harness.collect(body, { bypassCache: true });
    expect(bypassed.statusCode).toBe(200);
    const bypassedParsed = assertValidGeoMixResponse(bypassed.body, bypassed.json());
    expect(bypassedParsed.answerText).toBe('DeepSeek 通过请求头刷新后的回答');
    expect(bypassedParsed.rawMeta?.['cached']).toBe(false);
    expect(harness.upstreams.getHitCount('deepseek')).toBe(2);

    const afterWriteBack = await harness.collect(body);
    expect(afterWriteBack.statusCode).toBe(200);
    const afterParsed = assertValidGeoMixResponse(afterWriteBack.body, afterWriteBack.json());
    expect(afterParsed.answerText).toBe('DeepSeek 通过请求头刷新后的回答');
    expect(afterParsed.rawMeta?.['cached']).toBe(true);
    expect(harness.upstreams.getHitCount('deepseek')).toBe(2);
  });

  it('skips cache read on body.noCache: true and writes back refreshed response', async () => {
    harness = createE2EHarness({ CACHE_TTL_SECONDS: '600' });
    harness.upstreams.mockEngineSuccess(
      'tongyi',
      buildTongyiPayload({ answerText: '通义初始回答' }),
      { times: 1 },
    );
    harness.upstreams.mockEngineSuccess(
      'tongyi',
      buildTongyiPayload({ answerText: '通义通过 noCache 刷新后的回答' }),
      { times: 1 },
    );

    const baseBody = { engine: 'tongyi', prompt: '通义 CRM 推荐' };

    const first = await harness.collect(baseBody);
    expect(first.statusCode).toBe(200);
    const firstParsed = assertValidGeoMixResponse(first.body, first.json());
    expect(firstParsed.answerText).toBe('通义初始回答');
    expect(firstParsed.rawMeta?.['cached']).toBe(false);

    const bypassed = await harness.collect({ ...baseBody, noCache: true });
    expect(bypassed.statusCode).toBe(200);
    const bypassedParsed = assertValidGeoMixResponse(bypassed.body, bypassed.json());
    expect(bypassedParsed.answerText).toBe('通义通过 noCache 刷新后的回答');
    expect(bypassedParsed.rawMeta?.['cached']).toBe(false);
    expect(harness.upstreams.getHitCount('tongyi')).toBe(2);

    const cachedFresh = await harness.collect(baseBody);
    expect(cachedFresh.statusCode).toBe(200);
    const cachedParsed = assertValidGeoMixResponse(cachedFresh.body, cachedFresh.json());
    expect(cachedParsed.answerText).toBe('通义通过 noCache 刷新后的回答');
    expect(cachedParsed.rawMeta?.['cached']).toBe(true);
    expect(harness.upstreams.getHitCount('tongyi')).toBe(2);
  });

  it('propagates singleflight failure to all concurrent waiters without poisoning cache', async () => {
    harness = createE2EHarness({ MAX_UPSTREAM_RETRIES: '0', CACHE_TTL_SECONDS: '600' });
    harness.upstreams.mockEngineReply(
      'zhipu',
      500,
      { error: { message: 'Internal vendor failure' } },
      { delayMs: 60, times: 1 },
    );
    harness.upstreams.mockEngineSuccess(
      'zhipu',
      buildZhipuPayload({ answerText: '智谱恢复后的有效回答' }),
      { times: 1 },
    );

    const body = { engine: 'zhipu', prompt: '智谱故障恢复测试' };
    const failedWave = await Promise.all([
      harness.collect(body),
      harness.collect(body),
      harness.collect(body),
    ]);

    expect(harness.upstreams.getHitCount('zhipu')).toBe(1);
    for (const res of failedWave) {
      expect(res.statusCode).toBe(502);
      const err = errorEnvelopeSchema.parse(res.json());
      expect(err.error.code).toBe('UPSTREAM_BAD_RESPONSE');
      expect(err.error.retryable).toBe(true);
    }

    const recovery = await harness.collect(body);
    expect(recovery.statusCode).toBe(200);
    const recoveryParsed = assertValidGeoMixResponse(recovery.body, recovery.json());
    expect(recoveryParsed.answerText).toBe('智谱恢复后的有效回答');
    expect(recoveryParsed.rawMeta?.['cached']).toBe(false);
    expect(harness.upstreams.getHitCount('zhipu')).toBe(2);
  });

  it('disables LRU cache when CACHE_TTL_SECONDS=0 while keeping singleflight active', async () => {
    harness = createE2EHarness({ CACHE_TTL_SECONDS: '0' });
    harness.upstreams.mockEngineSuccess(
      'wenxin',
      buildWenxinPayload({ answerText: '文心第一波单飞回答' }),
      { delayMs: 80, times: 1 },
    );
    harness.upstreams.mockEngineSuccess(
      'wenxin',
      buildWenxinPayload({ answerText: '文心第二波实时回答' }),
      { times: 1 },
    );

    const body = { engine: 'wenxin', prompt: 'TTL 为零的单飞测试' };
    const wave1 = await Promise.all([
      harness.collect(body),
      harness.collect(body),
      harness.collect(body),
    ]);

    expect(harness.upstreams.getHitCount('wenxin')).toBe(1);
    for (const res of wave1) {
      expect(res.statusCode).toBe(200);
      const parsed = assertValidGeoMixResponse(res.body, res.json());
      expect(parsed.answerText).toBe('文心第一波单飞回答');
      expect(parsed.rawMeta?.['cached']).toBe(false);
    }

    const wave2 = await harness.collect(body);
    expect(wave2.statusCode).toBe(200);
    const wave2Parsed = assertValidGeoMixResponse(wave2.body, wave2.json());
    expect(wave2Parsed.answerText).toBe('文心第二波实时回答');
    expect(wave2Parsed.rawMeta?.['cached']).toBe(false);
    expect(harness.upstreams.getHitCount('wenxin')).toBe(2);
  });

  it('normalizes trimmed prompt in cache key and isolates by engine, locationCode, and languageCode', async () => {
    harness = createE2EHarness({ CACHE_TTL_SECONDS: '600' });
    harness.upstreams.mockEngineSuccess(
      'chatgpt',
      buildChatGptPayload({ answerText: 'ChatGPT US EN result' }),
      { times: 1 },
    );
    harness.upstreams.mockEngineSuccess(
      'chatgpt',
      buildChatGptPayload({ answerText: 'ChatGPT UK EN result' }),
      { times: 1 },
    );
    harness.upstreams.mockEngineSuccess(
      'chatgpt',
      buildChatGptPayload({ answerText: 'ChatGPT US FR result' }),
      { times: 1 },
    );
    harness.upstreams.mockEngineSuccess(
      'claude',
      buildClaudePayload({ answerText: 'Claude US EN result' }),
      { times: 1 },
    );

    const resUsEnPadded = await harness.collect({
      engine: 'chatgpt',
      prompt: '   best crm 2026   ',
      locationCode: 2840,
      languageCode: 'en',
    });
    expect(resUsEnPadded.statusCode).toBe(200);
    const parsed1 = assertValidGeoMixResponse(resUsEnPadded.body, resUsEnPadded.json());
    expect(parsed1.answerText).toBe('ChatGPT US EN result');
    expect(parsed1.rawMeta?.['cached']).toBe(false);

    const resUsEnTrimmed = await harness.collect({
      engine: 'chatgpt',
      prompt: 'best crm 2026',
      locationCode: 2840,
      languageCode: 'en',
    });
    expect(resUsEnTrimmed.statusCode).toBe(200);
    const parsed2 = assertValidGeoMixResponse(resUsEnTrimmed.body, resUsEnTrimmed.json());
    expect(parsed2.answerText).toBe('ChatGPT US EN result');
    expect(parsed2.rawMeta?.['cached']).toBe(true);
    expect(harness.upstreams.getHitCount('chatgpt')).toBe(1);

    const resUkEn = await harness.collect({
      engine: 'chatgpt',
      prompt: 'best crm 2026',
      locationCode: 2826,
      languageCode: 'en',
    });
    expect(resUkEn.statusCode).toBe(200);
    const parsedUk = assertValidGeoMixResponse(resUkEn.body, resUkEn.json());
    expect(parsedUk.answerText).toBe('ChatGPT UK EN result');
    expect(parsedUk.rawMeta?.['cached']).toBe(false);

    const resUsFr = await harness.collect({
      engine: 'chatgpt',
      prompt: 'best crm 2026',
      locationCode: 2840,
      languageCode: 'fr',
    });
    expect(resUsFr.statusCode).toBe(200);
    const parsedFr = assertValidGeoMixResponse(resUsFr.body, resUsFr.json());
    expect(parsedFr.answerText).toBe('ChatGPT US FR result');
    expect(parsedFr.rawMeta?.['cached']).toBe(false);
    expect(harness.upstreams.getHitCount('chatgpt')).toBe(3);

    const resClaude = await harness.collect({
      engine: 'claude',
      prompt: 'best crm 2026',
      locationCode: 2840,
      languageCode: 'en',
    });
    expect(resClaude.statusCode).toBe(200);
    const parsedClaude = assertValidGeoMixResponse(resClaude.body, resClaude.json());
    expect(parsedClaude.answerText).toBe('Claude US EN result');
    expect(parsedClaude.rawMeta?.['cached']).toBe(false);
    expect(harness.upstreams.getHitCount('claude')).toBe(1);
  });

  it('expires google_aio No-AIO short TTL (300s) before normal 600s AIO-present cache entries', async () => {
    let offsetMs = 0;
    const basePerf = performance.now();
    const baseDate = Date.now();
    const perfSpy = vi.spyOn(performance, 'now').mockImplementation(() => basePerf + offsetMs);
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => baseDate + offsetMs);

    try {
      harness = createE2EHarness({ CACHE_TTL_SECONDS: '600' });
      harness.upstreams.mockEngineSuccess('google_aio', buildGoogleAioNoAioPayload(), { times: 1 });
      harness.upstreams.mockEngineSuccess(
        'google_aio',
        buildGoogleAioPayload({ answerText: 'Google AIO triggered normal answer for CRM.' }),
        { times: 1 },
      );
      harness.upstreams.mockEngineSuccess(
        'google_aio',
        buildGoogleAioPayload({ answerText: 'Google AIO appeared after 300s short TTL expired.' }),
        { times: 1 },
      );

      const noAioReq = { engine: 'google_aio', prompt: 'rare query without ai overview' };
      const withAioReq = { engine: 'google_aio', prompt: 'popular query with ai overview' };

      const firstNoAio = await harness.collect(noAioReq);
      expect(firstNoAio.statusCode).toBe(200);
      const parsedNoAio = assertValidGeoMixResponse(firstNoAio.body, firstNoAio.json());
      expect(parsedNoAio.rawMeta?.['aiOverviewTriggered']).toBe(false);
      expect(parsedNoAio.rawMeta?.['cached']).toBe(false);
      assertPassesGeoMixTopicRelevanceFallback(parsedNoAio.answerText);

      const firstWithAio = await harness.collect(withAioReq);
      expect(firstWithAio.statusCode).toBe(200);
      const parsedWithAio = assertValidGeoMixResponse(firstWithAio.body, firstWithAio.json());
      expect(parsedWithAio.rawMeta?.['aiOverviewTriggered']).toBe(true);
      expect(parsedWithAio.rawMeta?.['cached']).toBe(false);
      expect(harness.upstreams.getHitCount('google_aio')).toBe(2);

      const immediateNoAioHit = await harness.collect(noAioReq);
      expect(immediateNoAioHit.statusCode).toBe(200);
      expect(
        assertValidGeoMixResponse(immediateNoAioHit.body, immediateNoAioHit.json()).rawMeta?.[
          'cached'
        ],
      ).toBe(true);
      expect(harness.upstreams.getHitCount('google_aio')).toBe(2);

      offsetMs = 301_000;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });

      const stillCachedAio = await harness.collect(withAioReq);
      expect(stillCachedAio.statusCode).toBe(200);
      const stillCachedParsed = assertValidGeoMixResponse(
        stillCachedAio.body,
        stillCachedAio.json(),
      );
      expect(stillCachedParsed.rawMeta?.['cached']).toBe(true);
      expect(stillCachedParsed.answerText).toBe('Google AIO triggered normal answer for CRM.');
      expect(harness.upstreams.getHitCount('google_aio')).toBe(2);

      const expiredNoAio = await harness.collect(noAioReq);
      expect(expiredNoAio.statusCode).toBe(200);
      const expiredParsed = assertValidGeoMixResponse(expiredNoAio.body, expiredNoAio.json());
      expect(expiredParsed.rawMeta?.['cached']).toBe(false);
      expect(expiredParsed.rawMeta?.['aiOverviewTriggered']).toBe(true);
      expect(expiredParsed.answerText).toBe('Google AIO appeared after 300s short TTL expired.');
      expect(harness.upstreams.getHitCount('google_aio')).toBe(3);
    } finally {
      perfSpy.mockRestore();
      dateSpy.mockRestore();
    }
  });
});
