import { afterEach, describe, expect, it } from 'vitest';
import { assertValidGeoMixResponse } from '../helpers/geomix-schema.js';
import { createE2EHarness } from '../helpers/e2e-harness.js';
import type { E2EHarness } from '../helpers/e2e-harness.js';
import {
  UPSTREAM_ROUTES,
  buildChatGptPayload,
  buildGeminiResponsesPayload,
  buildGeminiScraperPayload,
  buildGoogleAioPayload,
} from '../helpers/mock-upstreams.js';

function extractFirstTaskObject(jsonBody: unknown): Record<string, unknown> {
  if (
    Array.isArray(jsonBody) &&
    jsonBody.length > 0 &&
    typeof jsonBody[0] === 'object' &&
    jsonBody[0] !== null
  ) {
    return jsonBody[0] as Record<string, unknown>;
  }
  if (typeof jsonBody === 'object' && jsonBody !== null) {
    return jsonBody as Record<string, unknown>;
  }
  throw new Error(`Unexpected DataForSEO request body: ${JSON.stringify(jsonBody)}`);
}

describe('Tier 4 Scenario 6: International Multi-Locale Batch & Gemini Scraper vs Responses Modes', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await harness.close();
      harness = undefined;
    }
  });

  it('forwards locationCode/languageCode to DataForSEO, isolates cache by locale, and uses scraper endpoint for Gemini by default', async () => {
    harness = createE2EHarness({
      DATAFORSEO_GEMINI_MODE: 'scraper',
      CACHE_TTL_SECONDS: '600',
    });

    const locales = [
      { label: 'US', locationCode: 2840, languageCode: 'en', cost: 0.02 },
      { label: 'UK', locationCode: 2826, languageCode: 'en', cost: 0.021 },
      { label: 'JP', locationCode: 2392, languageCode: 'ja', cost: 0.022 },
    ] as const;

    for (const loc of locales) {
      harness.upstreams.mockEngineSuccess(
        'chatgpt',
        buildChatGptPayload({ answerText: `ChatGPT ${loc.label} response`, costUsd: loc.cost }),
        { times: 1 },
      );
      harness.upstreams.mockEngineSuccess(
        'google_aio',
        buildGoogleAioPayload({ answerText: `Google AIO ${loc.label} overview`, costUsd: 0.01 }),
        { times: 1 },
      );
      harness.upstreams.mockEngineSuccess(
        'gemini',
        buildGeminiScraperPayload({
          answerText: `Gemini scraper ${loc.label} answer`,
          costUsd: 0.018,
        }),
        { times: 1, geminiMode: 'scraper' },
      );
    }

    const prompt = 'best enterprise crm software 2026';

    for (const loc of locales) {
      const chatgptRes = await harness.collect({
        engine: 'chatgpt',
        prompt,
        locationCode: loc.locationCode,
        languageCode: loc.languageCode,
      });
      expect(chatgptRes.statusCode).toBe(200);
      const chatgptParsed = assertValidGeoMixResponse(chatgptRes.body, chatgptRes.json());
      expect(chatgptParsed.answerText).toBe(`ChatGPT ${loc.label} response`);
      expect(chatgptParsed.rawMeta?.['cached']).toBe(false);
      expect(chatgptParsed.rawMeta?.['costUsd']).toBeCloseTo(loc.cost, 6);
      expect(Number(chatgptParsed.rawMeta?.['latencyMs'])).toBeGreaterThanOrEqual(0);

      const aioRes = await harness.collect({
        engine: 'google_aio',
        prompt,
        locationCode: loc.locationCode,
        languageCode: loc.languageCode,
      });
      expect(aioRes.statusCode).toBe(200);
      const aioParsed = assertValidGeoMixResponse(aioRes.body, aioRes.json());
      expect(aioParsed.answerText).toBe(`Google AIO ${loc.label} overview`);
      expect(aioParsed.rawMeta?.['aiOverviewTriggered']).toBe(true);

      const geminiRes = await harness.collect({
        engine: 'gemini',
        prompt,
        locationCode: loc.locationCode,
        languageCode: loc.languageCode,
      });
      expect(geminiRes.statusCode).toBe(200);
      const geminiParsed = assertValidGeoMixResponse(geminiRes.body, geminiRes.json());
      expect(geminiParsed.answerText).toBe(`Gemini scraper ${loc.label} answer`);
      expect(geminiParsed.rawMeta?.['costUsd']).toBeCloseTo(0.018, 6);
    }

    // Verify all 3 locales missed cache independently (3 upstream calls per engine)
    expect(harness.upstreams.getHitCount('chatgpt')).toBe(3);
    expect(harness.upstreams.getHitCount('google_aio')).toBe(3);
    expect(harness.upstreams.getHitCount('gemini')).toBe(3);

    // Verify forwarded location_code & language_code in captured DataForSEO request bodies
    const chatgptCaptured = harness.upstreams.getCapturedRequests('chatgpt');
    expect(chatgptCaptured).toHaveLength(3);
    for (let i = 0; i < locales.length; i += 1) {
      const captured = chatgptCaptured[i];
      const expectedLoc = locales[i];
      expect(captured).toBeDefined();
      expect(expectedLoc).toBeDefined();
      const task = extractFirstTaskObject(captured!.jsonBody);
      expect(task['location_code']).toBe(expectedLoc!.locationCode);
      expect(task['language_code']).toBe(expectedLoc!.languageCode);
    }

    // Verify Gemini scraper route path
    const geminiCaptured = harness.upstreams.getCapturedRequests('gemini');
    expect(geminiCaptured).toHaveLength(3);
    for (const req of geminiCaptured) {
      expect(req.path).toBe(UPSTREAM_ROUTES.gemini.path);
    }

    // Repeat UK chatgpt request -> hits locale-specific cache entry
    const ukCachedRes = await harness.collect({
      engine: 'chatgpt',
      prompt,
      locationCode: 2826,
      languageCode: 'en',
    });
    expect(ukCachedRes.statusCode).toBe(200);
    const ukCachedParsed = assertValidGeoMixResponse(ukCachedRes.body, ukCachedRes.json());
    expect(ukCachedParsed.answerText).toBe('ChatGPT UK response');
    expect(ukCachedParsed.rawMeta?.['cached']).toBe(true);
    expect(harness.upstreams.getHitCount('chatgpt')).toBe(3);
  });

  it('routes Gemini to llm_responses/live when DATAFORSEO_GEMINI_MODE=responses and returns valid GeoMix telemetry', async () => {
    harness = createE2EHarness({
      DATAFORSEO_GEMINI_MODE: 'responses',
      DATAFORSEO_GEMINI_MODEL: 'gemini-2.5-flash',
    });

    harness.upstreams.mockEngineSuccess(
      'gemini',
      buildGeminiResponsesPayload({
        answerText: 'Gemini responses mode answer for international CRM evaluation.',
        model: 'gemini-2.5-flash',
        costUsd: 0.016,
      }),
      { times: 1, geminiMode: 'responses' },
    );

    const res = await harness.collect(
      {
        engine: 'gemini',
        prompt: 'Compare enterprise CRM tools for APAC markets',
        locationCode: 2392,
        languageCode: 'ja',
      },
      { requestId: 'gemini-responses-mode-001' },
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('gemini-responses-mode-001');
    const parsed = assertValidGeoMixResponse(res.body, res.json());
    expect(parsed.answerText).toBe(
      'Gemini responses mode answer for international CRM evaluation.',
    );
    expect(parsed.rawMeta?.['costUsd']).toBeCloseTo(0.016, 6);
    expect(typeof parsed.rawMeta?.['latencyMs']).toBe('number');
    expect(Number(parsed.rawMeta?.['latencyMs'])).toBeGreaterThanOrEqual(0);

    const captured = harness.upstreams.getCapturedRequests('gemini');
    expect(captured).toHaveLength(1);
    const firstCaptured = captured[0];
    expect(firstCaptured).toBeDefined();
    expect(firstCaptured?.path).toBe(UPSTREAM_ROUTES.gemini_responses.path);
  });
});
