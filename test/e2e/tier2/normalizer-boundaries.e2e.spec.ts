import { afterEach, describe, expect, it } from 'vitest';
import { createE2EHarness } from '../helpers/e2e-harness.js';
import type { E2EHarness } from '../helpers/e2e-harness.js';
import {
  GATEWAY_BYTE_GUARD_LIMIT,
  assertValidGeoMixResponse,
  hasBrokenSurrogatePair,
} from '../helpers/geomix-schema.js';
import { buildDoubaoPayload } from '../helpers/mock-upstreams.js';
import type { MockCitationInput } from '../helpers/mock-upstreams.js';

describe('Tier 2 — Normalizer Boundaries & 1.9 MB 3-Tier Truncation Guard', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.close();
      harness = undefined;
    }
  });

  it('strips illegal control characters while preserving newlines and tabs', async () => {
    harness = createE2EHarness();
    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({
        answerText: 'Line1\u0000\u0001\u0008\u000b\u000c\u000e\u001f\n\tLine2',
        citations: [
          {
            url: 'https://clean.example.com/page',
            title: 'Title\u0000\u0007Clean',
            snippet: 'Snippet\u0002\u001eClean',
          },
        ],
      }),
    );

    const res = await harness.collect({
      engine: 'doubao',
      prompt: 'control char strip test',
    });

    expect(res.statusCode).toBe(200);
    const parsed = assertValidGeoMixResponse(res.body, res.json());
    expect(parsed.answerText).toBe('Line1\n\tLine2');
    expect(parsed.citations[0]?.title).toBe('TitleClean');
    expect(parsed.citations[0]?.snippet).toBe('SnippetClean');
  });

  it('strips tracking params, preserves business params, strips trailing empty hash, deduplicates, and drops invalid/oversized URLs', async () => {
    harness = createE2EHarness();
    const oversizedUrl = `https://oversized.example.com/${'a'.repeat(2050)}`;

    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({
        answerText: 'URL normalization verification response.',
        citations: [
          {
            url: 'https://biz.example.com/item?id=42&utm_source=google&utm_medium=cpc&utm_campaign=q1&utm_term=crm&utm_content=ad1&fbclid=fb1&gclid=gc1&msclkid=ms1&spm=a1&vd_source=vd1&from_source=fs1&p=2&article=crm#',
            title: 'First Canonical Title',
            snippet: 'First snippet wins on duplicate',
          },
          {
            url: 'https://biz.example.com/item?id=42&p=2&article=crm&utm_source=bing#',
            title: 'Duplicate Should Be Dropped',
            snippet: 'Duplicate snippet',
          },
          {
            url: 'javascript:alert(1)',
            title: 'XSS Scheme',
          },
          {
            url: 'ftp://files.example.com/archive.zip',
            title: 'FTP Scheme',
          },
          {
            url: oversizedUrl,
            title: 'Over 2048 URL',
          },
        ],
      }),
    );

    const res = await harness.collect({
      engine: 'doubao',
      prompt: 'url tracking param strip test',
    });

    expect(res.statusCode).toBe(200);
    const parsed = assertValidGeoMixResponse(res.body, res.json());
    expect(parsed.citations).toHaveLength(1);
    const firstCitation = parsed.citations[0]!;
    expect(firstCitation.url.endsWith('#')).toBe(false);

    const normalizedUrl = new URL(firstCitation.url);
    expect(normalizedUrl.origin + normalizedUrl.pathname).toBe('https://biz.example.com/item');
    expect(normalizedUrl.hash).toBe('');
    expect(normalizedUrl.searchParams.get('id')).toBe('42');
    expect(normalizedUrl.searchParams.get('p')).toBe('2');
    expect(normalizedUrl.searchParams.get('article')).toBe('crm');
    for (const trackingKey of [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid',
      'msclkid',
      'spm',
      'vd_source',
      'from_source',
    ]) {
      expect(normalizedUrl.searchParams.has(trackingKey)).toBe(false);
    }

    expect(parsed.citations[0]?.title).toBe('First Canonical Title');
    expect(parsed.citations[0]?.position).toBe(1);
  });

  it('caps citations at 100 with sequential positions 1..100 and truncates long titles (>300) and snippets (>1000)', async () => {
    harness = createE2EHarness();
    const citations: MockCitationInput[] = Array.from({ length: 130 }, (_, i) => ({
      url: `https://cap.example.com/doc-${i + 1}`,
      title: i === 0 ? 'T'.repeat(450) : `Title ${i + 1}`,
      snippet: i === 0 ? 'S'.repeat(1400) : `Snippet ${i + 1}`,
    }));

    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({
        answerText: 'Citation cap and field length truncation test.',
        citations,
      }),
    );

    const res = await harness.collect({
      engine: 'doubao',
      prompt: 'citation cap 100 test',
    });

    expect(res.statusCode).toBe(200);
    const parsed = assertValidGeoMixResponse(res.body, res.json());
    expect(parsed.citations).toHaveLength(100);
    expect(parsed.citations[0]?.position).toBe(1);
    expect(parsed.citations[99]?.position).toBe(100);
    expect(parsed.citations[0]?.title?.length).toBeLessThanOrEqual(300);
    expect(parsed.citations[0]?.snippet?.length).toBeLessThanOrEqual(1000);
  });

  it('caps fanOutQueries at 50 and truncates entries exceeding 300 characters', async () => {
    harness = createE2EHarness();
    const queries = Array.from({ length: 70 }, (_, i) =>
      i === 0 ? `Q${'x'.repeat(400)}` : `fan out query ${i + 1}`,
    );

    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({
        answerText: 'Fan-out queries cap and truncation test.',
        fanOutQueries: queries,
      }),
    );

    const res = await harness.collect({
      engine: 'doubao',
      prompt: 'fanOutQueries cap 50 test',
    });

    expect(res.statusCode).toBe(200);
    const parsed = assertValidGeoMixResponse(res.body, res.json());
    expect(parsed.fanOutQueries).toHaveLength(50);
    for (const q of parsed.fanOutQueries) {
      expect(q.length).toBeGreaterThan(0);
      expect(q.length).toBeLessThanOrEqual(300);
    }
  });

  it('enforces the 1_900_000-byte 3-tier truncation guard without breaking UTF-16 surrogate pairs', async () => {
    harness = createE2EHarness();

    // Math:
    // - upstreamRequestId: 1,550,000 ASCII bytes (passthrough in rawMeta)
    // - 100 citations * 1000-char CJK snippet (~300,000 bytes) + titles/URLs (~40,000 bytes)
    // - answerText: 50,000 repeats of '测🚀' (150,000 UTF-16 code units, 350,000 UTF-8 bytes)
    // Total pre-guard JSON > 2,200,000 bytes -> exercises Tiers 1, 2, and 3 while leaving
    // ample room (~300 KB) for non-empty answerText under 1,900,000 bytes.
    const citations: MockCitationInput[] = Array.from({ length: 100 }, (_, i) => ({
      url: `https://byte-guard.example.com/article/${i + 1}`,
      title: `中文来源标题-${i + 1}-${'标'.repeat(40)}`,
      snippet: '摘'.repeat(1000),
    }));

    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({
        upstreamRequestId: 'r'.repeat(1_550_000),
        answerText: '测🚀'.repeat(50_000),
        citations,
      }),
    );

    const res = await harness.collect({
      engine: 'doubao',
      prompt: '1.9MB 3-tier byte guard test',
    });

    expect(res.statusCode).toBe(200);
    const byteLength = Buffer.byteLength(res.body, 'utf8');
    expect(byteLength).toBeLessThanOrEqual(GATEWAY_BYTE_GUARD_LIMIT);

    const parsed = assertValidGeoMixResponse(res.body, res.json());
    expect(parsed.rawMeta?.['truncatedForByteLimit']).toBe(true);
    expect(parsed.citations.length).toBeLessThanOrEqual(50);
    for (const citation of parsed.citations) {
      if (citation.snippet !== undefined) {
        expect(citation.snippet.length).toBeLessThanOrEqual(200);
      }
    }
    expect(parsed.answerText.length).toBeGreaterThan(0);
    expect(hasBrokenSurrogatePair(parsed.answerText)).toBe(false);
  });
});
