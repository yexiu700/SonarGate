import { describe, expect, it } from 'vitest';
import { collectResponseSchema } from '../../src/core/contract.js';
import { GatewayError } from '../../src/core/errors.js';
import {
  MAX_ANSWER_CHARS,
  MAX_RESPONSE_BYTES,
  normalizeResponse,
  normalizeUrl,
  sliceSurrogateSafe,
  stripControlChars,
  type NormalizeInput,
} from '../../src/core/normalizer.js';
import type { AdapterResult } from '../../src/core/types.js';

function makeInput(
  overrides: Partial<AdapterResult> = {},
  prompt = 'best crm 2026',
): NormalizeInput {
  return {
    prompt,
    meta: {
      engine: 'deepseek',
      region: 'domestic',
      requestId: 'req-test-1',
      latencyMs: 120,
      attempts: 1,
      cached: false,
    },
    result: {
      answerText: 'Default answer text',
      citations: [],
      fanOutQueries: [],
      rawMeta: {
        provider: 'deepseek',
      },
      ...overrides,
    },
  };
}

describe('normalizer', () => {
  it('strips control characters while preserving newline, tab, and carriage return', () => {
    const raw = 'Hello\u0000\u0007\u0008\u000B\u000C\u001F\u007F\nLine2\tTabbed\r\nLine3';
    expect(stripControlChars(raw)).toBe('Hello\nLine2\tTabbed\r\nLine3');

    const res = normalizeResponse(makeInput({ answerText: `  ${raw}  ` }));
    expect(res.answerText).toBe('Hello\nLine2\tTabbed\r\nLine3');
  });

  it('throws 502 UPSTREAM_BAD_RESPONSE (retryable) when answerText is empty after cleaning', () => {
    for (const emptyText of ['', '   \n\t  ', '\u0000\u0007\u001F']) {
      try {
        normalizeResponse(makeInput({ answerText: emptyText }));
        expect.fail('Expected GatewayError');
      } catch (err) {
        expect(err).toBeInstanceOf(GatewayError);
        const ge = err as GatewayError;
        expect(ge.statusCode).toBe(502);
        expect(ge.code).toBe('UPSTREAM_BAD_RESPONSE');
        expect(ge.retryable).toBe(true);
        expect(ge.engine).toBe('deepseek');
      }
    }
  });

  it('caps answerText at 200,000 chars without splitting surrogate pairs', () => {
    const boundary = 'a'.repeat(MAX_ANSWER_CHARS - 1) + '🚀' + 'tail';
    const sliced = sliceSurrogateSafe(boundary, MAX_ANSWER_CHARS);
    expect(sliced.length).toBe(MAX_ANSWER_CHARS - 1);
    expect(sliced.endsWith('a')).toBe(true);

    const res = normalizeResponse(makeInput({ answerText: boundary }));
    expect(res.answerText.length).toBe(MAX_ANSWER_CHARS - 1);
    const lastCode = res.answerText.charCodeAt(res.answerText.length - 1);
    expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true);
  });

  it('normalizes citation URLs, strips tracking params, preserves business params, and drops invalid URLs', () => {
    expect(
      normalizeUrl(
        'https://example.com/article?id=42&utm_source=google&UTM_CAMPAIGN=spring&fbclid=123&gclid=456&msclkid=789&spm=a1&vd_source=b2&from_source=c3&p=2#',
      ),
    ).toBe('https://example.com/article?id=42&p=2');

    expect(normalizeUrl('https://example.com/docs?article=9#section-1')).toBe(
      'https://example.com/docs?article=9#section-1',
    );
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('ftp://files.example.com/a.zip')).toBeNull();
    expect(normalizeUrl('not-a-url')).toBeNull();
    expect(normalizeUrl(`https://example.com/${'a'.repeat(2040)}`)).toBeNull();
  });

  it('deduplicates citations, cleans title/snippet (omitting empty keys), caps at 100, and renumbers 1..N', () => {
    const rawCitations = [
      {
        url: 'https://example.com/page?id=1&utm_source=x',
        title: '  First Title\u0000  ',
        snippet: '  First Snippet  ',
        position: 99,
      },
      {
        url: 'https://example.com/page?id=1&fbclid=dup',
        title: 'Duplicate Should Be Dropped',
        snippet: 'Duplicate snippet',
      },
      {
        url: 'https://example.com/no-meta',
        title: '   \u0000  ',
        snippet: '',
      },
      {
        url: 'https://example.com/long-fields',
        title: 'T'.repeat(400),
        snippet: 'S'.repeat(1500),
      },
      ...Array.from({ length: 120 }, (_, i) => ({
        url: `https://example.com/item-${i}`,
        title: `Item ${i}`,
      })),
    ];

    const res = normalizeResponse(makeInput({ citations: rawCitations }));
    expect(res.citations).toHaveLength(100);
    expect(res.citations[0]).toEqual({
      url: 'https://example.com/page?id=1',
      title: 'First Title',
      snippet: 'First Snippet',
      position: 1,
    });
    expect(res.citations[1]).toEqual({
      url: 'https://example.com/no-meta',
      position: 2,
    });
    expect('title' in (res.citations[1] ?? {})).toBe(false);
    expect('snippet' in (res.citations[1] ?? {})).toBe(false);
    expect(res.citations[2]?.title?.length).toBe(300);
    expect(res.citations[2]?.snippet?.length).toBe(1000);
    expect(res.citations.map((c) => c.position)).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1),
    );
  });

  it('extracts markdown links and bare URLs when adapter citations are empty', () => {
    const text = [
      'Check [Example Site](https://example.com/a?utm_source=md) for details.',
      'Also see https://example.com/b., and (https://example.com/c),',
      'and Wikipedia https://en.wikipedia.org/wiki/Rust_(programming_language).',
    ].join(' ');

    const res = normalizeResponse(makeInput({ answerText: text, citations: [] }));
    expect(res.rawMeta.citationsExtractedFromText).toBe(true);
    expect(res.citations).toEqual([
      { url: 'https://example.com/a', title: 'Example Site', position: 1 },
      { url: 'https://example.com/b', position: 2 },
      { url: 'https://example.com/c', position: 3 },
      { url: 'https://en.wikipedia.org/wiki/Rust_(programming_language)', position: 4 },
    ]);
  });

  it('does not run fallback extraction when adapter already provides citations', () => {
    const res = normalizeResponse(
      makeInput({
        answerText: 'Visit https://fallback.example.com for more.',
        citations: [{ url: 'https://official.example.com/doc', title: 'Official' }],
      }),
    );
    expect(res.rawMeta.citationsExtractedFromText).toBeUndefined();
    expect(res.citations).toHaveLength(1);
    expect(res.citations[0]?.url).toBe('https://official.example.com/doc');
  });

  it('cleans fanOutQueries: trims, drops empty and original prompt, dedupes case-insensitively, truncates to 300, caps at 50', () => {
    const queries = [
      '  ',
      'best crm 2026',
      'BEST CRM 2026',
      'CRM Pricing Comparison',
      'crm pricing comparison',
      'Q'.repeat(350),
      ...Array.from({ length: 60 }, (_, i) => `Follow-up query ${i}`),
    ];

    const res = normalizeResponse(makeInput({ fanOutQueries: queries }, '  Best CRM 2026 '));
    expect(res.fanOutQueries).toHaveLength(50);
    expect(res.fanOutQueries[0]).toBe('CRM Pricing Comparison');
    expect(res.fanOutQueries[1]?.length).toBe(300);
    expect(res.fanOutQueries.some((q) => q.toLowerCase() === 'best crm 2026')).toBe(false);
  });

  it('enforces 3-tier 1_900_000-byte guard (Tier 1 snippets, Tier 2 citations, Tier 3 answerText with multibyte UTF-8)', () => {
    // Tier 1 + Tier 2 trigger: huge citations + large CJK/emoji answer
    const hugeCitations = Array.from({ length: 80 }, (_, i) => ({
      url: `https://example.com/big/${i}`,
      title: `Title ${i}`,
      snippet: '中'.repeat(900), // 2700 UTF-8 bytes each
    }));

    const hugeAnswer = '测'.repeat(190_000) + '🚀'.repeat(4_000); // > 586k UTF-8 bytes
    const res1 = normalizeResponse(
      makeInput({
        answerText: hugeAnswer,
        citations: hugeCitations,
      }),
    );
    expect(Buffer.byteLength(JSON.stringify(res1), 'utf8')).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(collectResponseSchema.safeParse(res1).success).toBe(true);

    // Explicitly exceed 1_900_000 bytes to force all 3 tiers:
    // Use 100 citations with 1000-char CJK snippets (300k bytes) + massive rawMeta padding (1.7MB)
    const padMeta = 'x'.repeat(1_500_000);
    const tier3Answer = ('中'.repeat(100) + '🚀').repeat(1_500);
    const res3 = normalizeResponse(
      makeInput({
        answerText: tier3Answer,
        citations: hugeCitations,
        rawMeta: {
          provider: 'deepseek',
          largeDebugField: padMeta,
        },
      }),
    );

    const finalBytes = Buffer.byteLength(JSON.stringify(res3), 'utf8');
    expect(finalBytes).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(res3.rawMeta.truncatedForByteLimit).toBe(true);
    expect(res3.citations.length).toBeLessThanOrEqual(50);
    for (const c of res3.citations) {
      if (c.snippet !== undefined) {
        expect(c.snippet.length).toBeLessThanOrEqual(200);
      }
    }
    const lastCode = res3.answerText.charCodeAt(res3.answerText.length - 1);
    expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true);
    expect(collectResponseSchema.safeParse(res3).success).toBe(true);
  });

  it('strips massive non-core rawMeta passthrough fields to enforce the 1_900_000-byte guard', () => {
    const res = normalizeResponse(
      makeInput({
        answerText: 'Short valid answer',
        citations: [],
        fanOutQueries: [],
        rawMeta: {
          provider: 'volcengine',
          hugeBlob: '中'.repeat(700_000),
        },
      }),
    );

    expect(Buffer.byteLength(JSON.stringify(res), 'utf8')).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(res.rawMeta.truncatedForByteLimit).toBe(true);
    expect('hugeBlob' in res.rawMeta).toBe(false);
    expect(res.rawMeta.provider).toBe('volcengine');
    expect(res.rawMeta.engine).toBe('deepseek');
    expect(res.answerText).toBe('Short valid answer');
    expect(collectResponseSchema.safeParse(res).success).toBe(true);
  });

  it('extracts markdown links with balanced parentheses intact without truncation', () => {
    const text = [
      'Read [Rust](https://en.wikipedia.org/wiki/Rust_(programming_language)) for details.',
      'Nested [Spec](https://example.com/a_(b_(c))) and multi [Docs](https://example.com/x_(1)_y_(2)).',
    ].join(' ');

    const res = normalizeResponse(makeInput({ answerText: text, citations: [] }));
    expect(res.rawMeta.citationsExtractedFromText).toBe(true);
    expect(res.citations).toEqual([
      {
        url: 'https://en.wikipedia.org/wiki/Rust_(programming_language)',
        title: 'Rust',
        position: 1,
      },
      {
        url: 'https://example.com/a_(b_(c))',
        title: 'Spec',
        position: 2,
      },
      {
        url: 'https://example.com/x_(1)_y_(2)',
        title: 'Docs',
        position: 3,
      },
    ]);
  });

  it('drops fanOutQueries matching originalPrompt even when originalPrompt exceeds 300 chars', () => {
    const longPrompt = `${'Compare enterprise CRM platforms '.repeat(12)}2026`;
    expect(longPrompt.length).toBeGreaterThan(300);

    const res = normalizeResponse(
      makeInput(
        {
          fanOutQueries: [longPrompt.toUpperCase(), 'Short follow-up query'],
        },
        longPrompt,
      ),
    );
    expect(res.fanOutQueries).toEqual(['Short follow-up query']);
  });

  it('caps oversized core rawMeta strings (upstreamRequestId/model) and enforces <= 1_900_000 bytes', () => {
    const res = normalizeResponse(
      makeInput({
        answerText: 'Valid answer text.',
        rawMeta: {
          provider: 'deepseek',
          upstreamRequestId: 'x'.repeat(2_000_000),
          model: 'm'.repeat(2_000_000),
        },
      }),
    );

    expect(Buffer.byteLength(JSON.stringify(res), 'utf8')).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(typeof res.rawMeta.upstreamRequestId).toBe('string');
    expect((res.rawMeta.upstreamRequestId as string).length).toBeLessThanOrEqual(256);
    expect(typeof res.rawMeta.model).toBe('string');
    expect((res.rawMeta.model as string).length).toBeLessThanOrEqual(256);
    expect(collectResponseSchema.safeParse(res).success).toBe(true);
  });

  it('strips non-core rawMeta before truncating answerText so full answerText is preserved', () => {
    const answerText = 'A'.repeat(10_000);
    const res = normalizeResponse(
      makeInput({
        answerText,
        citations: [],
        fanOutQueries: [],
        rawMeta: {
          provider: 'deepseek',
          hugeDebug: 'x'.repeat(1_899_500),
        },
      }),
    );

    expect(Buffer.byteLength(JSON.stringify(res), 'utf8')).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(res.rawMeta.truncatedForByteLimit).toBe(true);
    expect('hugeDebug' in res.rawMeta).toBe(false);
    expect(res.answerText).toBe(answerText);
    expect(collectResponseSchema.safeParse(res).success).toBe(true);
  });

  it('extracts URLs wrapped in Chinese curly quotes and uppercase HTTP(S) schemes cleanly', () => {
    const text =
      '详见“https://example.com/page”和‘https://example.com/other’以及HTTPS://EXAMPLE.COM/UPPER和[大写](HTTP://EXAMPLE.ORG/MD)';
    const res = normalizeResponse(makeInput({ answerText: text, citations: [] }));

    expect(res.rawMeta.citationsExtractedFromText).toBe(true);
    expect(res.citations.map((c) => c.url)).toEqual([
      'http://example.org/MD',
      'https://example.com/page',
      'https://example.com/other',
      'https://example.com/UPPER',
    ]);
  });

  it('falls back to inline text extraction when all adapter-provided citations are invalid', () => {
    const res = normalizeResponse(
      makeInput({
        answerText: 'See https://valid.example.com/doc for details.',
        citations: [
          { url: 'javascript:alert(1)', title: 'XSS' },
          { url: '/relative/path', title: 'Relative' },
        ],
      }),
    );

    expect(res.rawMeta.citationsExtractedFromText).toBe(true);
    expect(res.citations).toEqual([
      {
        url: 'https://valid.example.com/doc',
        position: 1,
      },
    ]);
  });
});
