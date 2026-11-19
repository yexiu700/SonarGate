import { afterEach, describe, expect, it } from 'vitest';
import { createE2EHarness } from '../helpers/e2e-harness.js';
import type { E2EHarness } from '../helpers/e2e-harness.js';
import { assertValidGeoMixResponse } from '../helpers/geomix-schema.js';
import { buildDoubaoPayload } from '../helpers/mock-upstreams.js';

describe('Tier 1 — Normalization Feature Coverage', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.close();
      harness = undefined;
    }
  });

  it('extracts markdown and bare URL citations from answerText when upstream returns zero structured citations', async () => {
    harness = createE2EHarness();
    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({
        answerText:
          '可以参考 [官方选型白皮书](https://docs.example.com/crm-whitepaper) 以及 https://blog.example.com/crm-benchmark 获取详细数据。',
        citations: [],
      }),
    );

    const res = await harness.collect({
      engine: 'doubao',
      prompt: 'CRM 选型参考资料',
    });

    expect(res.statusCode).toBe(200);
    const parsed = assertValidGeoMixResponse(res.body, res.json());
    expect(parsed.rawMeta?.['citationsExtractedFromText']).toBe(true);
    expect(parsed.citations).toHaveLength(2);
    expect(parsed.citations[0]?.url).toBe('https://docs.example.com/crm-whitepaper');
    expect(parsed.citations[0]?.title).toBe('官方选型白皮书');
    expect(parsed.citations[0]?.position).toBe(1);
    expect(parsed.citations[1]?.url).toBe('https://blog.example.com/crm-benchmark');
    expect(parsed.citations[1]?.position).toBe(2);
  });

  it('deduplicates fanOutQueries case-insensitively and excludes the original prompt', async () => {
    harness = createE2EHarness();
    const originalPrompt = 'Best CRM Software 2026';

    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({
        answerText: 'Here is a summary of leading CRM software options in 2026.',
        fanOutQueries: [
          'best crm software 2026',
          '  BEST CRM SOFTWARE 2026  ',
          'SMB CRM Pricing',
          'smb crm pricing',
          'Cloud CRM Comparison',
          'CLOUD CRM COMPARISON',
        ],
      }),
    );

    const res = await harness.collect({
      engine: 'doubao',
      prompt: originalPrompt,
    });

    expect(res.statusCode).toBe(200);
    const parsed = assertValidGeoMixResponse(res.body, res.json());
    expect(parsed.fanOutQueries).toEqual(['SMB CRM Pricing', 'Cloud CRM Comparison']);
  });
});
