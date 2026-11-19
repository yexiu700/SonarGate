import { afterEach, describe, expect, it } from 'vitest';
import { createE2EHarness } from '../helpers/e2e-harness.js';
import type { E2EHarness } from '../helpers/e2e-harness.js';
import {
  DOMESTIC_ENGINES,
  OVERSEAS_ENGINES,
  assertPassesGeoMixTopicRelevanceFallback,
  assertValidGeoMixResponse,
} from '../helpers/geomix-schema.js';
import {
  buildDeepseekPayload,
  buildGoogleAioNoAioPayload,
  buildGoogleAioPayload,
} from '../helpers/mock-upstreams.js';

describe('Tier 1 — POST /v1/collect across all 10 engines', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.close();
      harness = undefined;
    }
  });

  for (const engine of DOMESTIC_ENGINES) {
    it(`collects and normalizes domestic engine "${engine}" against GeoMix schema`, async () => {
      harness = createE2EHarness();
      harness.upstreams.mockEngineSuccess(engine);

      const res = await harness.collect({
        engine,
        prompt: `2026 中小企业 CRM 选型建议 (${engine})`,
      });

      expect(res.statusCode).toBe(200);
      const parsed = assertValidGeoMixResponse(res.body, res.json());
      expect(parsed.answerText.length).toBeGreaterThan(0);
      expect(parsed.citations.length).toBeGreaterThanOrEqual(1);
      expect(parsed.rawMeta?.['engine']).toBe(engine);
      expect(parsed.rawMeta?.['region']).toBe('domestic');
      expect(parsed.rawMeta?.['cached']).toBe(false);
      expect(parsed.rawMeta?.['attempts']).toBe(1);
      expect(typeof parsed.rawMeta?.['latencyMs']).toBe('number');
      expect(typeof parsed.rawMeta?.['tokensIn']).toBe('number');
      expect(typeof parsed.rawMeta?.['tokensOut']).toBe('number');
      expect(harness.upstreams.getHitCount(engine)).toBe(1);
    });
  }

  for (const engine of OVERSEAS_ENGINES) {
    it(`collects and normalizes overseas engine "${engine}" against GeoMix schema`, async () => {
      harness = createE2EHarness();
      harness.upstreams.mockEngineSuccess(engine);

      const res = await harness.collect({
        engine,
        prompt: `Best SMB CRM platforms in 2026 (${engine})`,
      });

      expect(res.statusCode).toBe(200);
      const parsed = assertValidGeoMixResponse(res.body, res.json());
      expect(parsed.answerText.length).toBeGreaterThan(0);
      expect(parsed.citations.length).toBeGreaterThanOrEqual(1);
      expect(parsed.rawMeta?.['engine']).toBe(engine);
      expect(parsed.rawMeta?.['region']).toBe('overseas');
      expect(parsed.rawMeta?.['cached']).toBe(false);
      expect(parsed.rawMeta?.['attempts']).toBe(1);
      expect(typeof parsed.rawMeta?.['latencyMs']).toBe('number');
      expect(typeof parsed.rawMeta?.['costUsd']).toBe('number');
      expect(parsed.rawMeta?.['costUsd'] as number).toBeGreaterThan(0);
      expect(harness.upstreams.getHitCount(engine)).toBe(1);
    });
  }

  it('deepseek excludes reasoning_content from answerText and sets rawMeta.hasReasoning=true', async () => {
    harness = createE2EHarness();
    const secretChainOfThought = 'HIDDEN_COT_MARKER_MUST_NEVER_APPEAR_IN_ANSWER';
    harness.upstreams.mockEngineSuccess(
      'deepseek',
      buildDeepseekPayload({
        answerText: 'DeepSeek 最终回答内容。',
        reasoningContent: secretChainOfThought,
      }),
    );

    const res = await harness.collect({
      engine: 'deepseek',
      prompt: '比较主流云端 CRM',
    });

    expect(res.statusCode).toBe(200);
    const parsed = assertValidGeoMixResponse(res.body, res.json());
    expect(parsed.answerText).toContain('DeepSeek 最终回答内容');
    expect(parsed.answerText).not.toContain(secretChainOfThought);
    expect(parsed.rawMeta?.['hasReasoning']).toBe(true);
  });

  it('google_aio sets rawMeta.aiOverviewTriggered=true when AI Overview is present', async () => {
    harness = createE2EHarness();
    harness.upstreams.mockEngineSuccess('google_aio', buildGoogleAioPayload());

    const res = await harness.collect({
      engine: 'google_aio',
      prompt: 'what is cloud crm software',
    });

    expect(res.statusCode).toBe(200);
    const parsed = assertValidGeoMixResponse(res.body, res.json());
    expect(parsed.rawMeta?.['aiOverviewTriggered']).toBe(true);
    expect(parsed.citations.length).toBeGreaterThanOrEqual(1);
  });

  it('google_aio returns valid No-AIO fallback when SERP has no AI Overview', async () => {
    harness = createE2EHarness();
    harness.upstreams.mockEngineSuccess('google_aio', buildGoogleAioNoAioPayload());

    const res = await harness.collect({
      engine: 'google_aio',
      prompt: 'very specific query without ai overview',
    });

    expect(res.statusCode).toBe(200);
    const parsed = assertValidGeoMixResponse(res.body, res.json());
    assertPassesGeoMixTopicRelevanceFallback(parsed.answerText);
    expect(parsed.rawMeta?.['aiOverviewTriggered']).toBe(false);
    expect(parsed.citations).toEqual([]);
    expect(parsed.fanOutQueries).toEqual([]);
  });

  it('accepts case-insensitive engine names with surrounding whitespace', async () => {
    harness = createE2EHarness();
    harness.upstreams.mockEngineSuccess('doubao');

    const res = await harness.collect({
      engine: '  DOUBAO  ',
      prompt: '大小写引擎名兼容测试',
    });

    expect(res.statusCode).toBe(200);
    const parsed = assertValidGeoMixResponse(res.body, res.json());
    expect(parsed.rawMeta?.['engine']).toBe('doubao');
    expect(harness.upstreams.getHitCount('doubao')).toBe(1);
  });

  it('forwards locationCode and languageCode overrides to DataForSEO payloads', async () => {
    harness = createE2EHarness();
    harness.upstreams.mockEngineSuccess('chatgpt');

    const res = await harness.collect({
      engine: 'chatgpt',
      prompt: 'best crm tools in uk',
      locationCode: 2826,
      languageCode: 'en',
    });

    expect(res.statusCode).toBe(200);
    assertValidGeoMixResponse(res.body, res.json());

    const captured = harness.upstreams.getCapturedRequests('chatgpt');
    expect(captured).toHaveLength(1);
    const reqBody = captured[0]?.jsonBody;
    expect(Array.isArray(reqBody)).toBe(true);
    const firstTask = (reqBody as Array<Record<string, unknown>>)[0];
    expect(firstTask?.['location_code']).toBe(2826);
    expect(firstTask?.['language_code']).toBe('en');
  });
});
