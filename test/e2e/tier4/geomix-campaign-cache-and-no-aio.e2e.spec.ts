import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPassesGeoMixTopicRelevanceFallback,
  assertValidGeoMixResponse,
} from '../helpers/geomix-schema.js';
import { createE2EHarness } from '../helpers/e2e-harness.js';
import type { E2EHarness } from '../helpers/e2e-harness.js';
import {
  buildChatGptPayload,
  buildDoubaoPayload,
  buildGoogleAioNoAioPayload,
  buildGoogleAioPayload,
} from '../helpers/mock-upstreams.js';

describe('Tier 4 Scenario 2: Multi-Brand GeoMix Campaign Cache Warmup, Bypass Refresh & google_aio No-AIO', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await harness.close();
      harness = undefined;
    }
  });

  it('deduplicates overlapping brand prompts, serves warm cache, refreshes on bypass, and handles google_aio No-AIO cleanly', async () => {
    harness = createE2EHarness({ CACHE_TTL_SECONDS: '600' });

    // Wave 1 mocks (initial campaign run)
    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({ answerText: '豆包第一波品牌可见度回答' }),
      { delayMs: 50, times: 1 },
    );
    harness.upstreams.mockEngineSuccess(
      'chatgpt',
      buildChatGptPayload({ answerText: 'ChatGPT wave 1 brand visibility response' }),
      { delayMs: 50, times: 1 },
    );
    harness.upstreams.mockEngineSuccess(
      'google_aio',
      buildGoogleAioPayload({ answerText: 'Google AIO wave 1 brand overview' }),
      { delayMs: 50, times: 1 },
    );

    // Wave 3 mocks (operator debug bypass refreshes)
    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({ answerText: '豆包第三波强制刷新后的最新回答' }),
      { times: 1 },
    );
    harness.upstreams.mockEngineSuccess(
      'chatgpt',
      buildChatGptPayload({ answerText: 'ChatGPT wave 3 refreshed via noCache' }),
      { times: 1 },
    );

    const sharedDoubaoPrompt = '2026 国内热门 SaaS 营销工具推荐';
    const sharedChatgptPrompt = 'Top B2B marketing automation tools 2026';
    const aioTriggeredPrompt = 'best b2b marketing automation 2026';

    // Wave 1: 3 brands concurrently query overlapping prompts -> Singleflight collapses duplicates
    const wave1 = await Promise.all([
      harness.collect({ engine: 'doubao', prompt: sharedDoubaoPrompt }),
      harness.collect({ engine: 'doubao', prompt: `  ${sharedDoubaoPrompt}  ` }),
      harness.collect({ engine: 'doubao', prompt: sharedDoubaoPrompt }),
      harness.collect({ engine: 'chatgpt', prompt: sharedChatgptPrompt }),
      harness.collect({ engine: 'chatgpt', prompt: sharedChatgptPrompt }),
      harness.collect({ engine: 'google_aio', prompt: aioTriggeredPrompt }),
      harness.collect({ engine: 'google_aio', prompt: aioTriggeredPrompt }),
    ]);

    for (const res of wave1) {
      expect(res.statusCode).toBe(200);
      const parsed = assertValidGeoMixResponse(res.body, res.json());
      expect(parsed.rawMeta?.['cached']).toBe(false);
    }
    expect(harness.upstreams.getHitCount('doubao')).toBe(1);
    expect(harness.upstreams.getHitCount('chatgpt')).toBe(1);
    expect(harness.upstreams.getHitCount('google_aio')).toBe(1);

    // Wave 2: Repeat batch -> all served from LRU cache with 0 new upstream calls
    const wave2 = await Promise.all([
      harness.collect({ engine: 'doubao', prompt: sharedDoubaoPrompt }),
      harness.collect({ engine: 'chatgpt', prompt: sharedChatgptPrompt }),
      harness.collect({ engine: 'google_aio', prompt: aioTriggeredPrompt }),
    ]);

    for (const res of wave2) {
      expect(res.statusCode).toBe(200);
      const parsed = assertValidGeoMixResponse(res.body, res.json());
      expect(parsed.rawMeta?.['cached']).toBe(true);
    }
    expect(harness.upstreams.getHitCount('doubao')).toBe(1);
    expect(harness.upstreams.getHitCount('chatgpt')).toBe(1);
    expect(harness.upstreams.getHitCount('google_aio')).toBe(1);

    // Wave 3: Operator debug refresh via X-Bypass-Cache: true and body.noCache: true
    const doubaoRefresh = await harness.collect(
      { engine: 'doubao', prompt: sharedDoubaoPrompt },
      { bypassCache: true },
    );
    expect(doubaoRefresh.statusCode).toBe(200);
    const doubaoRefreshParsed = assertValidGeoMixResponse(doubaoRefresh.body, doubaoRefresh.json());
    expect(doubaoRefreshParsed.answerText).toBe('豆包第三波强制刷新后的最新回答');
    expect(doubaoRefreshParsed.rawMeta?.['cached']).toBe(false);

    const chatgptRefresh = await harness.collect({
      engine: 'chatgpt',
      prompt: sharedChatgptPrompt,
      noCache: true,
    });
    expect(chatgptRefresh.statusCode).toBe(200);
    const chatgptRefreshParsed = assertValidGeoMixResponse(
      chatgptRefresh.body,
      chatgptRefresh.json(),
    );
    expect(chatgptRefreshParsed.answerText).toBe('ChatGPT wave 3 refreshed via noCache');
    expect(chatgptRefreshParsed.rawMeta?.['cached']).toBe(false);
    expect(harness.upstreams.getHitCount('doubao')).toBe(2);
    expect(harness.upstreams.getHitCount('chatgpt')).toBe(2);

    // Wave 4: Normal follow-up confirms cache write-back with refreshed answers
    const doubaoAfterRefresh = await harness.collect({
      engine: 'doubao',
      prompt: sharedDoubaoPrompt,
    });
    const doubaoAfterParsed = assertValidGeoMixResponse(
      doubaoAfterRefresh.body,
      doubaoAfterRefresh.json(),
    );
    expect(doubaoAfterParsed.answerText).toBe('豆包第三波强制刷新后的最新回答');
    expect(doubaoAfterParsed.rawMeta?.['cached']).toBe(true);

    const chatgptAfterRefresh = await harness.collect({
      engine: 'chatgpt',
      prompt: sharedChatgptPrompt,
    });
    const chatgptAfterParsed = assertValidGeoMixResponse(
      chatgptAfterRefresh.body,
      chatgptAfterRefresh.json(),
    );
    expect(chatgptAfterParsed.answerText).toBe('ChatGPT wave 3 refreshed via noCache');
    expect(chatgptAfterParsed.rawMeta?.['cached']).toBe(true);
    expect(harness.upstreams.getHitCount('doubao')).toBe(2);
    expect(harness.upstreams.getHitCount('chatgpt')).toBe(2);

    // google_aio No-AIO query in the same campaign
    harness.upstreams.mockEngineSuccess('google_aio', buildGoogleAioNoAioPayload(), { times: 1 });
    const noAioRes = await harness.collect({
      engine: 'google_aio',
      prompt: 'obscure brand sku 9981234',
    });
    expect(noAioRes.statusCode).toBe(200);
    const noAioParsed = assertValidGeoMixResponse(noAioRes.body, noAioRes.json());
    expect(noAioParsed.rawMeta?.['aiOverviewTriggered']).toBe(false);
    expect(noAioParsed.citations).toEqual([]);
    expect(noAioParsed.fanOutQueries).toEqual([]);
    assertPassesGeoMixTopicRelevanceFallback(noAioParsed.answerText);
  });
});
