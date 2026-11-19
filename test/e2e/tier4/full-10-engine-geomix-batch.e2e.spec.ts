import { afterEach, describe, expect, it } from 'vitest';
import {
  DOMESTIC_ENGINES,
  GEOMIX_MAX_RESPONSE_BYTES,
  SUPPORTED_ENGINES,
  assertValidGeoMixResponse,
} from '../helpers/geomix-schema.js';
import type { DomesticEngine, OverseasEngine } from '../helpers/geomix-schema.js';
import { createE2EHarness } from '../helpers/e2e-harness.js';
import type { E2EHarness } from '../helpers/e2e-harness.js';
import {
  buildChatGptPayload,
  buildClaudePayload,
  buildDeepseekPayload,
  buildDoubaoPayload,
  buildGeminiScraperPayload,
  buildGoogleAioPayload,
  buildPerplexityPayload,
  buildTongyiPayload,
  buildWenxinPayload,
  buildZhipuPayload,
} from '../helpers/mock-upstreams.js';

describe('Tier 4 Scenario 1: Full 10-Engine GeoMix Brand Visibility Sweep', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await harness.close();
      harness = undefined;
    }
  });

  it('dispatches a concurrent 10-engine GeoMix batch and validates 100% schema, telemetry, cost, and reasoning isolation', async () => {
    harness = createE2EHarness();

    const secretReasoningText = 'INTERNAL_CHAIN_OF_THOUGHT_MUST_NOT_LEAK_INTO_ANSWER';
    const overseasExpectedCosts: Record<OverseasEngine, number> = {
      chatgpt: 0.021,
      perplexity: 0.013,
      gemini: 0.019,
      claude: 0.026,
      google_aio: 0.011,
    };

    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({ tokensIn: 120, tokensOut: 280, upstreamRequestId: 'req-doubao-batch' }),
    );
    harness.upstreams.mockEngineSuccess(
      'deepseek',
      buildDeepseekPayload({
        tokensIn: 90,
        tokensOut: 210,
        upstreamRequestId: 'req-deepseek-batch',
        reasoningContent: secretReasoningText,
      }),
    );
    harness.upstreams.mockEngineSuccess(
      'tongyi',
      buildTongyiPayload({ tokensIn: 80, tokensOut: 190, upstreamRequestId: 'req-tongyi-batch' }),
    );
    harness.upstreams.mockEngineSuccess(
      'zhipu',
      buildZhipuPayload({ tokensIn: 95, tokensOut: 185, upstreamRequestId: 'req-zhipu-batch' }),
    );
    harness.upstreams.mockEngineSuccess(
      'wenxin',
      buildWenxinPayload({ tokensIn: 70, tokensOut: 165, upstreamRequestId: 'req-wenxin-batch' }),
    );
    harness.upstreams.mockEngineSuccess(
      'chatgpt',
      buildChatGptPayload({ costUsd: overseasExpectedCosts.chatgpt }),
    );
    harness.upstreams.mockEngineSuccess(
      'perplexity',
      buildPerplexityPayload({ costUsd: overseasExpectedCosts.perplexity }),
    );
    harness.upstreams.mockEngineSuccess(
      'gemini',
      buildGeminiScraperPayload({ costUsd: overseasExpectedCosts.gemini }),
    );
    harness.upstreams.mockEngineSuccess(
      'claude',
      buildClaudePayload({ costUsd: overseasExpectedCosts.claude }),
    );
    harness.upstreams.mockEngineSuccess(
      'google_aio',
      buildGoogleAioPayload({ costUsd: overseasExpectedCosts.google_aio }),
    );

    const domesticPrompt = '2026 年适合中国中小企业的云端 CRM 品牌推荐有哪些？';
    const overseasPrompt = 'What are the top cloud CRM platforms for SMBs in 2026?';
    const domesticSet = new Set<string>(DOMESTIC_ENGINES);

    const batchResults = await Promise.all(
      SUPPORTED_ENGINES.map(async (engine) => {
        const isDomestic = domesticSet.has(engine);
        const requestId = `geomix-sweep-${engine}-001`;
        const res = await harness!.collect(
          {
            engine,
            prompt: isDomestic ? domesticPrompt : overseasPrompt,
          },
          { requestId },
        );
        return { engine, isDomestic, requestId, res };
      }),
    );

    expect(batchResults).toHaveLength(10);
    expect(harness.upstreams.getTotalHits()).toBe(10);

    for (const { engine, isDomestic, requestId, res } of batchResults) {
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-request-id']).toBe(requestId);
      expect(Buffer.byteLength(res.body, 'utf8')).toBeLessThan(GEOMIX_MAX_RESPONSE_BYTES);

      const parsed = assertValidGeoMixResponse(res.body, res.json());
      const meta = parsed.rawMeta;
      expect(meta).toBeDefined();
      expect(meta?.['engine']).toBe(engine);
      expect(meta?.['region']).toBe(isDomestic ? 'domestic' : 'overseas');
      expect(typeof meta?.['provider']).toBe('string');
      expect(meta?.['requestId']).toBe(requestId);
      expect(typeof meta?.['latencyMs']).toBe('number');
      expect(Number(meta?.['latencyMs'])).toBeGreaterThanOrEqual(0);
      expect(meta?.['attempts']).toBe(1);
      expect(meta?.['cached']).toBe(false);

      if (isDomestic) {
        const domEngine = engine as DomesticEngine;
        expect(typeof meta?.['tokensIn']).toBe('number');
        expect(typeof meta?.['tokensOut']).toBe('number');
        expect(meta?.['upstreamRequestId']).toBe(`req-${domEngine}-batch`);

        if (domEngine === 'deepseek') {
          expect(meta?.['hasReasoning']).toBe(true);
          expect(parsed.answerText).not.toContain(secretReasoningText);
        }
      } else {
        const ovEngine = engine as OverseasEngine;
        expect(meta?.['costUsd']).toBeCloseTo(overseasExpectedCosts[ovEngine], 6);

        if (ovEngine === 'google_aio') {
          expect(meta?.['aiOverviewTriggered']).toBe(true);
        }
      }
    }
  });
});
