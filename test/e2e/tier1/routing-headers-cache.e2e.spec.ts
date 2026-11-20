import { afterEach, describe, expect, it } from 'vitest';
import { createE2EHarness } from '../helpers/e2e-harness.js';
import type { E2EHarness } from '../helpers/e2e-harness.js';
import {
  UUID_V4_REGEX,
  assertValidGeoMixResponse,
  errorEnvelopeSchema,
} from '../helpers/geomix-schema.js';
import { buildTongyiPayload } from '../helpers/mock-upstreams.js';

describe('Tier 1 — Routing, Headers & Cache Bypass', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.close();
      harness = undefined;
    }
  });

  describe('Planned engines return 501 ENGINE_NOT_IMPLEMENTED with zero upstream calls', () => {
    for (const planned of ['yuanbao', 'nami', 'kimi']) {
      it(`rejects "${planned}" with 501 ENGINE_NOT_IMPLEMENTED`, async () => {
        harness = createE2EHarness();

        const res = await harness.collect({
          engine: planned,
          prompt: 'planned engine probe',
        });

        expect(res.statusCode).toBe(501);
        const envelope = errorEnvelopeSchema.parse(res.json());
        expect(envelope.error.code).toBe('ENGINE_NOT_IMPLEMENTED');
        expect(envelope.error.retryable).toBe(false);
        expect(envelope.error.engine).toBe(planned);
        expect(harness.upstreams.getTotalHits()).toBe(0);
      });
    }
  });

  describe('Unknown engines return 400 UNSUPPORTED_ENGINE with zero upstream calls', () => {
    for (const unknown of ['unknown_foo', 'not_an_engine']) {
      it(`rejects "${unknown}" with 400 UNSUPPORTED_ENGINE`, async () => {
        harness = createE2EHarness();

        const res = await harness.collect({
          engine: unknown,
          prompt: 'unknown engine probe',
        });

        expect(res.statusCode).toBe(400);
        const envelope = errorEnvelopeSchema.parse(res.json());
        expect(envelope.error.code).toBe('UNSUPPORTED_ENGINE');
        expect(envelope.error.retryable).toBe(false);
        expect(envelope.error.engine).toBe(unknown);
        expect(harness.upstreams.getTotalHits()).toBe(0);
      });
    }
  });

  describe('Unconfigured supported engines return 501 ENGINE_NOT_CONFIGURED', () => {
    it('returns 501 when DOUBAO_API_KEY is empty', async () => {
      harness = createE2EHarness({ DOUBAO_API_KEY: '' });

      const res = await harness.collect({
        engine: 'doubao',
        prompt: 'unconfigured doubao key test',
      });

      expect(res.statusCode).toBe(501);
      const envelope = errorEnvelopeSchema.parse(res.json());
      expect(envelope.error.code).toBe('ENGINE_NOT_CONFIGURED');
      expect(envelope.error.retryable).toBe(false);
      expect(envelope.error.engine).toBe('doubao');
      expect(harness.upstreams.getTotalHits()).toBe(0);
    });

    it('returns 501 when DOUBAO_MODEL is empty even if DOUBAO_API_KEY is set', async () => {
      harness = createE2EHarness({ DOUBAO_MODEL: '' });

      const res = await harness.collect({
        engine: 'doubao',
        prompt: 'unconfigured doubao model test',
      });

      expect(res.statusCode).toBe(501);
      const envelope = errorEnvelopeSchema.parse(res.json());
      expect(envelope.error.code).toBe('ENGINE_NOT_CONFIGURED');
      expect(envelope.error.retryable).toBe(false);
      expect(envelope.error.engine).toBe('doubao');
      expect(harness.upstreams.getTotalHits()).toBe(0);
    });

    it('returns 501 for overseas engine when DATAFORSEO_LOGIN is empty', async () => {
      harness = createE2EHarness({ DATAFORSEO_LOGIN: '' });

      const res = await harness.collect({
        engine: 'chatgpt',
        prompt: 'unconfigured dataforseo test',
      });

      expect(res.statusCode).toBe(501);
      const envelope = errorEnvelopeSchema.parse(res.json());
      expect(envelope.error.code).toBe('ENGINE_NOT_CONFIGURED');
      expect(envelope.error.retryable).toBe(false);
      expect(envelope.error.engine).toBe('chatgpt');
      expect(harness.upstreams.getTotalHits()).toBe(0);
    });
  });

  describe('X-Request-Id propagation and UUIDv4 generation', () => {
    it('echoes valid X-Request-Id in response header, rawMeta.requestId, and error.requestId', async () => {
      harness = createE2EHarness();
      harness.upstreams.mockEngineSuccess('tongyi');
      const customRequestId = 'req_test-01.a';

      const okRes = await harness.collect(
        { engine: 'tongyi', prompt: 'request id echo success' },
        { requestId: customRequestId },
      );

      expect(okRes.statusCode).toBe(200);
      expect(okRes.headers['x-request-id']).toBe(customRequestId);
      const parsed = assertValidGeoMixResponse(okRes.body, okRes.json());
      expect(parsed.rawMeta?.['requestId']).toBe(customRequestId);

      const errRes = await harness.collect(
        { engine: 'yuanbao', prompt: 'request id echo error' },
        { requestId: customRequestId },
      );

      expect(errRes.statusCode).toBe(501);
      expect(errRes.headers['x-request-id']).toBe(customRequestId);
      const envelope = errorEnvelopeSchema.parse(errRes.json());
      expect(envelope.error.requestId).toBe(customRequestId);
    });

    it('generates a consistent UUIDv4 when X-Request-Id is omitted', async () => {
      harness = createE2EHarness();
      harness.upstreams.mockEngineSuccess('tongyi');

      const res = await harness.collect({
        engine: 'tongyi',
        prompt: 'request id generation test',
      });

      expect(res.statusCode).toBe(200);
      const headerReqId = res.headers['x-request-id'];
      expect(typeof headerReqId).toBe('string');
      expect(headerReqId).toMatch(UUID_V4_REGEX);

      const parsed = assertValidGeoMixResponse(res.body, res.json());
      expect(parsed.rawMeta?.['requestId']).toBe(headerReqId);
    });
  });

  describe('Cache hit & bypass controls', () => {
    it('serves cached response on second identical (engine, prompt) without calling upstream again', async () => {
      harness = createE2EHarness();
      harness.upstreams.mockEngineSuccess(
        'tongyi',
        buildTongyiPayload({ answerText: '首次缓存写入内容' }),
        { times: 1 },
      );

      const first = await harness.collect({
        engine: 'tongyi',
        prompt: 'cache hit verification prompt',
      });
      expect(first.statusCode).toBe(200);
      const firstParsed = assertValidGeoMixResponse(first.body, first.json());
      expect(firstParsed.rawMeta?.['cached']).toBe(false);

      const second = await harness.collect({
        engine: 'tongyi',
        prompt: 'cache hit verification prompt',
      });
      expect(second.statusCode).toBe(200);
      const secondParsed = assertValidGeoMixResponse(second.body, second.json());
      expect(secondParsed.rawMeta?.['cached']).toBe(true);
      expect(secondParsed.answerText).toBe(firstParsed.answerText);
      expect(harness.upstreams.getHitCount('tongyi')).toBe(1);
    });

    it('X-Bypass-Cache: true forces a fresh upstream call and refreshes the cache', async () => {
      harness = createE2EHarness();
      harness.upstreams.mockEngineSuccess(
        'tongyi',
        buildTongyiPayload({ answerText: '第一次上游结果' }),
        { times: 1 },
      );
      harness.upstreams.mockEngineSuccess(
        'tongyi',
        buildTongyiPayload({ answerText: '第二次刷新结果' }),
        { times: 1 },
      );

      const first = await harness.collect({
        engine: 'tongyi',
        prompt: 'bypass header prompt',
      });
      expect(first.statusCode).toBe(200);
      const firstParsed = assertValidGeoMixResponse(first.body, first.json());
      expect(firstParsed.answerText).toContain('第一次上游结果');
      expect(firstParsed.rawMeta?.['cached']).toBe(false);

      const bypassed = await harness.collect(
        { engine: 'tongyi', prompt: 'bypass header prompt' },
        { bypassCache: true },
      );
      expect(bypassed.statusCode).toBe(200);
      const bypassedParsed = assertValidGeoMixResponse(bypassed.body, bypassed.json());
      expect(bypassedParsed.answerText).toContain('第二次刷新结果');
      expect(bypassedParsed.rawMeta?.['cached']).toBe(false);
      expect(harness.upstreams.getHitCount('tongyi')).toBe(2);

      const afterRefresh = await harness.collect({
        engine: 'tongyi',
        prompt: 'bypass header prompt',
      });
      expect(afterRefresh.statusCode).toBe(200);
      const refreshedParsed = assertValidGeoMixResponse(afterRefresh.body, afterRefresh.json());
      expect(refreshedParsed.answerText).toContain('第二次刷新结果');
      expect(refreshedParsed.rawMeta?.['cached']).toBe(true);
      expect(harness.upstreams.getHitCount('tongyi')).toBe(2);
    });

    it('body.noCache: true forces a fresh upstream call and refreshes the cache', async () => {
      harness = createE2EHarness();
      harness.upstreams.mockEngineSuccess(
        'tongyi',
        buildTongyiPayload({ answerText: 'noCache 初始版本' }),
        { times: 1 },
      );
      harness.upstreams.mockEngineSuccess(
        'tongyi',
        buildTongyiPayload({ answerText: 'noCache 刷新版本' }),
        { times: 1 },
      );

      const first = await harness.collect({
        engine: 'tongyi',
        prompt: 'noCache body prompt',
      });
      expect(first.statusCode).toBe(200);
      assertValidGeoMixResponse(first.body, first.json());

      const bypassed = await harness.collect({
        engine: 'tongyi',
        prompt: 'noCache body prompt',
        noCache: true,
      });
      expect(bypassed.statusCode).toBe(200);
      const bypassedParsed = assertValidGeoMixResponse(bypassed.body, bypassed.json());
      expect(bypassedParsed.answerText).toContain('noCache 刷新版本');
      expect(bypassedParsed.rawMeta?.['cached']).toBe(false);
      expect(harness.upstreams.getHitCount('tongyi')).toBe(2);

      const cachedAfter = await harness.collect({
        engine: 'tongyi',
        prompt: 'noCache body prompt',
      });
      expect(cachedAfter.statusCode).toBe(200);
      const cachedParsed = assertValidGeoMixResponse(cachedAfter.body, cachedAfter.json());
      expect(cachedParsed.answerText).toContain('noCache 刷新版本');
      expect(cachedParsed.rawMeta?.['cached']).toBe(true);
      expect(harness.upstreams.getHitCount('tongyi')).toBe(2);
    });
  });
});
