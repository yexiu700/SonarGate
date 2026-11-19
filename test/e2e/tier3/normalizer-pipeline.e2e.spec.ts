import { afterEach, describe, expect, it } from 'vitest';
import {
  GATEWAY_BYTE_GUARD_LIMIT,
  assertValidGeoMixResponse,
  hasBrokenSurrogatePair,
} from '../helpers/geomix-schema.js';
import { createE2EHarness } from '../helpers/e2e-harness.js';
import type { E2EHarness } from '../helpers/e2e-harness.js';
import { buildDeepseekPayload, buildDoubaoPayload } from '../helpers/mock-upstreams.js';
import type { MockCitationInput } from '../helpers/mock-upstreams.js';

describe('Tier 3: Normalizer Full 6-Step Pipeline & 1.9MB Byte Guard', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await harness.close();
      harness = undefined;
    }
  });

  it('strips control chars, extracts fallback URLs, strips tracking params, deduplicates, filters invalid/overlong URLs, and renumbers', async () => {
    harness = createE2EHarness();

    const overlongUrl = `https://example.com/long?x=${'a'.repeat(2100)}`;
    const rawAnswer = [
      '第一行回答\u0000包含控制字符\u0007与\u001F但保留换行和制表符。\t缩进内容',
      '参考文档：[CRM Doc](https://example.com/p?id=7&utm_source=ai&fbclid=1&gclid=2&msclkid=3&spm=4&vd_source=5&from_source=6#)',
      '重复链接（仅追踪参数不同）：https://example.com/p?id=7&utm_medium=cpc',
      '裸链接：https://example.com/b?article=99&utm_campaign=spring',
      '非法协议：[Bad](javascript:alert(1))',
      `超长链接：${overlongUrl}`,
    ].join('\n');

    harness.upstreams.mockEngineSuccess(
      'deepseek',
      buildDeepseekPayload({
        answerText: rawAnswer,
        citations: [],
      }),
    );

    const res = await harness.collect({ engine: 'deepseek', prompt: 'normalizer pipeline test' });
    expect(res.statusCode).toBe(200);
    const parsed = assertValidGeoMixResponse(res.body, res.json());

    // Control chars stripped, \n and \t preserved
    expect(parsed.answerText).not.toContain('\u0000');
    expect(parsed.answerText).not.toContain('\u0007');
    expect(parsed.answerText).not.toContain('\u001F');
    expect(parsed.answerText).toContain('\n');
    expect(parsed.answerText).toContain('\t');

    // Fallback extraction metadata
    expect(parsed.rawMeta?.['citationsExtractedFromText']).toBe(true);

    // Cleaned, deduplicated, renumbered citations
    expect(parsed.citations).toHaveLength(2);
    const firstCitation = parsed.citations[0];
    const secondCitation = parsed.citations[1];
    expect(firstCitation).toBeDefined();
    expect(secondCitation).toBeDefined();
    expect(firstCitation?.url).toBe('https://example.com/p?id=7');
    expect(firstCitation?.position).toBe(1);
    expect(secondCitation?.url).toBe('https://example.com/b?article=99');
    expect(secondCitation?.position).toBe(2);

    // No tracking params, trailing #, javascript:, or >2048 URLs leaked
    for (const c of parsed.citations) {
      expect(c.url).not.toContain('utm_');
      expect(c.url).not.toContain('fbclid');
      expect(c.url).not.toContain('gclid');
      expect(c.url).not.toContain('msclkid');
      expect(c.url).not.toContain('spm=');
      expect(c.url).not.toContain('vd_source');
      expect(c.url).not.toContain('from_source');
      expect(c.url.endsWith('#')).toBe(false);
      expect(c.url.startsWith('http://') || c.url.startsWith('https://')).toBe(true);
      expect(c.url.length).toBeLessThanOrEqual(2048);
    }
  });

  it('cleans, deduplicates case-insensitively, removes original prompt, truncates to 300 chars, and caps fanOutQueries at 50', async () => {
    harness = createE2EHarness();

    const originalPrompt = 'Best SMB CRM Software 2026';
    const fanOutQueries: string[] = [
      '   best smb crm software 2026  ', // matches original prompt (case-insensitive) -> must be removed
      '',
      '   ',
      '  Cloud CRM Pricing  ',
      'cloud crm pricing', // case-insensitive duplicate -> must be collapsed
      `Long query prefix ${'q'.repeat(350)}`, // >300 chars -> must be truncated to <=300
    ];
    for (let i = 1; i <= 60; i += 1) {
      fanOutQueries.push(`distinct fan out query ${i}`);
    }

    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({
        answerText: '豆包 fanOutQueries 清洗与上限测试回答。',
        fanOutQueries,
      }),
    );

    const res = await harness.collect({ engine: 'doubao', prompt: originalPrompt });
    expect(res.statusCode).toBe(200);
    const parsed = assertValidGeoMixResponse(res.body, res.json());

    expect(parsed.fanOutQueries.length).toBe(50);
    const lowered = parsed.fanOutQueries.map((q) => q.toLowerCase());
    expect(lowered).not.toContain(originalPrompt.toLowerCase());
    expect(new Set(lowered).size).toBe(parsed.fanOutQueries.length);
    for (const q of parsed.fanOutQueries) {
      expect(q).toBe(q.trim());
      expect(q.length).toBeGreaterThan(0);
      expect(q.length).toBeLessThanOrEqual(300);
    }
  });

  it('enforces the 3-tier 1_900_000-byte guard without breaking UTF-16 surrogate pairs', async () => {
    harness = createE2EHarness();

    const richCitations: MockCitationInput[] = Array.from({ length: 100 }, (_, idx) => ({
      url: `https://citations.example.com/item-${idx + 1}`,
      title: `中文引用标题 ${idx + 1}`,
      snippet: '中'.repeat(1000),
    }));

    // '测试🚀' is 4 UTF-16 code units (1 + 1 + 2), so 37_500 repeats = 150_000 chars (~375 KB UTF-8)
    const hugeCjkEmojiAnswer = '测试🚀'.repeat(37_500);

    harness.upstreams.mockEngineSuccess(
      'doubao',
      buildDoubaoPayload({
        upstreamRequestId: 'r'.repeat(1_550_000),
        answerText: hugeCjkEmojiAnswer,
        citations: richCitations,
      }),
    );

    const res = await harness.collect({
      engine: 'doubao',
      prompt: 'byte guard 3-tier stress test',
    });
    expect(res.statusCode).toBe(200);

    const rawByteLength = Buffer.byteLength(res.body, 'utf8');
    expect(rawByteLength).toBeLessThanOrEqual(GATEWAY_BYTE_GUARD_LIMIT);

    const parsed = assertValidGeoMixResponse(res.body, res.json());
    expect(parsed.rawMeta?.['truncatedForByteLimit']).toBe(true);
    expect(parsed.citations.length).toBeLessThanOrEqual(50);
    expect(hasBrokenSurrogatePair(parsed.answerText)).toBe(false);
    expect(parsed.answerText.length).toBeGreaterThan(0);
  });
});
