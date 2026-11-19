import { afterEach, describe, expect, it } from 'vitest';
import { createE2EHarness } from '../helpers/e2e-harness.js';
import type { E2EHarness } from '../helpers/e2e-harness.js';
import {
  UUID_V4_REGEX,
  assertValidGeoMixResponse,
  errorEnvelopeSchema,
} from '../helpers/geomix-schema.js';

describe('Tier 2 — Input & Header Validation Boundaries', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.close();
      harness = undefined;
    }
  });

  describe('Prompt length and whitespace boundaries', () => {
    const invalidPrompts: Array<{ label: string; prompt: string }> = [
      { label: 'empty string', prompt: '' },
      { label: 'whitespace-only string', prompt: '  \t\n  ' },
      { label: '2001 characters', prompt: 'a'.repeat(2001) },
    ];

    for (const testCase of invalidPrompts) {
      it(`rejects prompt (${testCase.label}) with 400 INVALID_REQUEST`, async () => {
        harness = createE2EHarness();

        const res = await harness.collect({
          engine: 'deepseek',
          prompt: testCase.prompt,
        });

        expect(res.statusCode).toBe(400);
        const envelope = errorEnvelopeSchema.parse(res.json());
        expect(envelope.error.code).toBe('INVALID_REQUEST');
        expect(envelope.error.retryable).toBe(false);
        expect(harness.upstreams.getTotalHits()).toBe(0);
      });
    }

    it('accepts exact 2000-character prompt and 2000-character prompt with surrounding whitespace', async () => {
      harness = createE2EHarness();
      harness.upstreams.mockEngineSuccess('deepseek', undefined, { times: 2 });

      const exactRes = await harness.collect({
        engine: 'deepseek',
        prompt: 'a'.repeat(2000),
      });
      expect(exactRes.statusCode).toBe(200);
      assertValidGeoMixResponse(exactRes.body, exactRes.json());

      const paddedRes = await harness.collect({
        engine: 'deepseek',
        prompt: ` ${'b'.repeat(2000)} `,
      });
      expect(paddedRes.statusCode).toBe(200);
      assertValidGeoMixResponse(paddedRes.body, paddedRes.json());
    });
  });

  it('rejects request body exceeding 64 KB (70 KB payload) with 413 or 400', async () => {
    harness = createE2EHarness();
    const oversizedJson = JSON.stringify({
      engine: 'deepseek',
      prompt: 'valid prompt',
      extraPadding: 'x'.repeat(70 * 1024),
    });

    const res = await harness.collect(null, { rawBody: oversizedJson });

    expect([400, 413]).toContain(res.statusCode);
    expect(harness.upstreams.getTotalHits()).toBe(0);
  });

  it('rejects malformed JSON body with 400 INVALID_REQUEST', async () => {
    harness = createE2EHarness();

    const res = await harness.collect(null, { rawBody: '{broken' });

    expect(res.statusCode).toBe(400);
    const envelope = errorEnvelopeSchema.parse(res.json());
    expect(envelope.error.code).toBe('INVALID_REQUEST');
    expect(envelope.error.retryable).toBe(false);
    expect(harness.upstreams.getTotalHits()).toBe(0);
  });

  describe('Optional field validation boundaries', () => {
    const invalidBodies: Array<{ label: string; body: Record<string, unknown> }> = [
      {
        label: 'locationCode: 0',
        body: { engine: 'chatgpt', prompt: 'valid prompt', locationCode: 0 },
      },
      {
        label: 'locationCode: negative integer',
        body: { engine: 'chatgpt', prompt: 'valid prompt', locationCode: -5 },
      },
      {
        label: 'locationCode: float',
        body: { engine: 'chatgpt', prompt: 'valid prompt', locationCode: 28.4 },
      },
      {
        label: 'languageCode: too short ("x")',
        body: { engine: 'chatgpt', prompt: 'valid prompt', languageCode: 'x' },
      },
      {
        label: 'languageCode: too long (17 chars)',
        body: { engine: 'chatgpt', prompt: 'valid prompt', languageCode: 'a'.repeat(17) },
      },
      {
        label: 'noCache: string "true" instead of boolean',
        body: { engine: 'chatgpt', prompt: 'valid prompt', noCache: 'true' },
      },
    ];

    for (const testCase of invalidBodies) {
      it(`rejects invalid optional field (${testCase.label}) with 400 INVALID_REQUEST`, async () => {
        harness = createE2EHarness();

        const res = await harness.collect(testCase.body);

        expect(res.statusCode).toBe(400);
        const envelope = errorEnvelopeSchema.parse(res.json());
        expect(envelope.error.code).toBe('INVALID_REQUEST');
        expect(envelope.error.retryable).toBe(false);
        expect(harness.upstreams.getTotalHits()).toBe(0);
      });
    }
  });

  describe('Malformed X-Request-Id header sanitization', () => {
    const malformedIds: Array<{ label: string; value: string }> = [
      { label: 'contains spaces', value: 'bad request id' },
      { label: 'contains slashes', value: 'req/with/slash' },
      { label: 'exceeds 64 characters', value: 'r'.repeat(65) },
      { label: 'empty string', value: '' },
    ];

    for (const testCase of malformedIds) {
      it(`replaces malformed X-Request-Id (${testCase.label}) with a generated UUIDv4`, async () => {
        harness = createE2EHarness();
        harness.upstreams.mockEngineSuccess('deepseek');

        const res = await harness.collect(
          { engine: 'deepseek', prompt: `malformed req id test: ${testCase.label}` },
          { headers: { 'x-request-id': testCase.value } },
        );

        expect(res.statusCode).toBe(200);
        const echoed = res.headers['x-request-id'];
        expect(typeof echoed).toBe('string');
        expect(echoed).not.toBe(testCase.value);
        expect(echoed).toMatch(UUID_V4_REGEX);

        const parsed = assertValidGeoMixResponse(res.body, res.json());
        expect(parsed.rawMeta?.['requestId']).toBe(echoed);
      });
    }
  });
});
