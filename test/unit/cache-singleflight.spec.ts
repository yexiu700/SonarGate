import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCacheKey, computeResponseTtlMs, ResponseCache } from '../../src/core/cache.js';
import type { CollectResponse } from '../../src/core/contract.js';

function makeResponse(
  engine: string,
  answerText: string,
  aiOverviewTriggered?: boolean,
): CollectResponse {
  return {
    answerText,
    citations: [],
    fanOutQueries: [],
    rawMeta: {
      engine,
      region: engine === 'google_aio' ? 'overseas' : 'domestic',
      provider: engine === 'google_aio' ? 'dataforseo' : engine,
      requestId: 'req-1',
      latencyMs: 50,
      attempts: 1,
      cached: false,
      ...(aiOverviewTriggered !== undefined ? { aiOverviewTriggered } : {}),
    },
  };
}

describe('cache & singleflight', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('buildCacheKey trims prompt and produces deterministic 64-char sha256 hex varying on all dimensions', () => {
    const k1 = buildCacheKey('doubao', '  hello world  ', 2840, 'en');
    const k2 = buildCacheKey('doubao', 'hello world', 2840, 'en');
    const k3 = buildCacheKey('deepseek', 'hello world', 2840, 'en');
    const k4 = buildCacheKey('doubao', 'hello world', 2156, 'en');
    const k5 = buildCacheKey('doubao', 'hello world', 2840, 'zh');

    expect(k1).toMatch(/^[a-f0-9]{64}$/);
    expect(k1).toBe(k2);
    expect(new Set([k1, k3, k4, k5]).size).toBe(4);
  });

  it('deduplicates 5 concurrent identical requests via singleflight and serves subsequent call from LRU cache', async () => {
    const cache = new ResponseCache<CollectResponse>({ ttlSeconds: 600, maxEntries: 100 });
    const key = buildCacheKey('doubao', 'concurrent prompt', 2840, 'zh');
    let calls = 0;

    let releaseFetcher!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFetcher = resolve;
    });

    const fetcher = async (): Promise<CollectResponse> => {
      calls += 1;
      await gate;
      return makeResponse('doubao', 'Shared Answer');
    };

    const pending = Array.from({ length: 5 }, () => cache.getOrExecute(key, fetcher));
    expect(cache.inflightCount).toBe(1);
    releaseFetcher();

    const results = await Promise.all(pending);
    expect(calls).toBe(1);
    expect(cache.inflightCount).toBe(0);
    expect(cache.size).toBe(1);
    for (const r of results) {
      expect(r.value.answerText).toBe('Shared Answer');
      expect(r.cached).toBe(false);
    }

    // Subsequent call hits LRU cache
    const cachedHit = await cache.getOrExecute(key, fetcher);
    expect(calls).toBe(1);
    expect(cachedHit.cached).toBe(true);
    expect(cachedHit.value.answerText).toBe('Shared Answer');
  });

  it('propagates failure to all concurrent waiters, does not cache errors, and allows subsequent retry', async () => {
    const cache = new ResponseCache<CollectResponse>({ ttlSeconds: 600, maxEntries: 100 });
    const key = buildCacheKey('deepseek', 'flaky prompt', 2840, 'zh');
    let calls = 0;

    const sharedError = new Error('upstream boom');
    const failingFetcher = async (): Promise<CollectResponse> => {
      calls += 1;
      await Promise.resolve();
      throw sharedError;
    };

    const settled = await Promise.allSettled([
      cache.getOrExecute(key, failingFetcher),
      cache.getOrExecute(key, failingFetcher),
      cache.getOrExecute(key, failingFetcher),
    ]);

    expect(calls).toBe(1);
    expect(cache.size).toBe(0);
    expect(cache.inflightCount).toBe(0);
    for (const s of settled) {
      expect(s.status).toBe('rejected');
      if (s.status === 'rejected') {
        expect(s.reason).toBe(sharedError);
      }
    }

    // Subsequent call executes fresh and succeeds
    const recovered = await cache.getOrExecute(key, async () => {
      calls += 1;
      return makeResponse('deepseek', 'Recovered');
    });
    expect(calls).toBe(2);
    expect(recovered.cached).toBe(false);
    expect(recovered.value.answerText).toBe('Recovered');
  });

  it('bypassCache skips LRU read, executes fetcher fresh, and updates LRU for subsequent normal reads', async () => {
    const cache = new ResponseCache<CollectResponse>({ ttlSeconds: 600, maxEntries: 100 });
    const key = buildCacheKey('tongyi', 'bypass prompt', 2840, 'zh');
    let version = 0;

    const fetchVersion = async (): Promise<CollectResponse> => {
      version += 1;
      return makeResponse('tongyi', `Answer v${version}`);
    };

    const first = await cache.getOrExecute(key, fetchVersion);
    expect(first.value.answerText).toBe('Answer v1');
    expect(first.cached).toBe(false);

    const bypassed = await cache.getOrExecute(key, fetchVersion, { bypassCache: true });
    expect(bypassed.value.answerText).toBe('Answer v2');
    expect(bypassed.cached).toBe(false);

    const afterBypass = await cache.getOrExecute(key, fetchVersion);
    expect(afterBypass.value.answerText).toBe('Answer v2');
    expect(afterBypass.cached).toBe(true);
    expect(version).toBe(2);
  });

  it('TTL=0 disables LRU cache while preserving singleflight concurrency deduplication', async () => {
    const cache = new ResponseCache<CollectResponse>({ ttlSeconds: 0, maxEntries: 100 });
    expect(cache.enabled).toBe(false);
    const key = buildCacheKey('zhipu', 'no-lru prompt', 2840, 'zh');
    let calls = 0;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const batch = Array.from({ length: 4 }, () =>
      cache.getOrExecute(key, async () => {
        calls += 1;
        await gate;
        return makeResponse('zhipu', `Call ${calls}`);
      }),
    );
    release();
    await Promise.all(batch);
    expect(calls).toBe(1);
    expect(cache.size).toBe(0);

    // Sequential call invokes fetcher again because LRU is disabled
    const second = await cache.getOrExecute(key, async () => {
      calls += 1;
      return makeResponse('zhipu', `Call ${calls}`);
    });
    expect(calls).toBe(2);
    expect(second.cached).toBe(false);
  });

  it('uses short TTL (Math.min(default, 300)s) for google_aio No-AIO responses', async () => {
    const noAio = makeResponse(
      'google_aio',
      '[NO_AI_OVERVIEW] 该查询未触发 Google AI Overview。',
      false,
    );
    const withAio = makeResponse('google_aio', 'AI Overview text', true);

    expect(computeResponseTtlMs(noAio, 600)).toBe(300_000);
    expect(computeResponseTtlMs(noAio, 120)).toBe(120_000);
    expect(computeResponseTtlMs(withAio, 600)).toBe(600_000);
    expect(computeResponseTtlMs(noAio, 0)).toBe(0);

    vi.useFakeTimers();
    const cache = new ResponseCache<CollectResponse>({ ttlSeconds: 600, maxEntries: 100 });
    const noAioKey = buildCacheKey('google_aio', 'no aio query', 2840, 'en');
    const normalKey = buildCacheKey('google_aio', 'with aio query', 2840, 'en');

    let noAioCalls = 0;
    let normalCalls = 0;

    await cache.getOrExecute(
      noAioKey,
      async () => {
        noAioCalls += 1;
        return noAio;
      },
      { getTtlMs: (res) => computeResponseTtlMs(res, 600) },
    );

    await cache.getOrExecute(
      normalKey,
      async () => {
        normalCalls += 1;
        return withAio;
      },
      { getTtlMs: (res) => computeResponseTtlMs(res, 600) },
    );

    // Advance 301s: No-AIO should expire, normal should still hit cache
    vi.advanceTimersByTime(301_000);

    const noAioAfter = await cache.getOrExecute(
      noAioKey,
      async () => {
        noAioCalls += 1;
        return noAio;
      },
      { getTtlMs: (res) => computeResponseTtlMs(res, 600) },
    );
    const normalAfter = await cache.getOrExecute(
      normalKey,
      async () => {
        normalCalls += 1;
        return withAio;
      },
      { getTtlMs: (res) => computeResponseTtlMs(res, 600) },
    );

    expect(noAioAfter.cached).toBe(false);
    expect(noAioCalls).toBe(2);
    expect(normalAfter.cached).toBe(true);
    expect(normalCalls).toBe(1);
  });
});
