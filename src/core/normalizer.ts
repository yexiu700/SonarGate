import {
  collectResponseSchema,
  type CollectResponse,
  type NormalizedCitation,
} from './contract.js';
import { GatewayError } from './errors.js';
import type { AdapterResult, EngineRegion, RawCitation } from './types.js';

export const MAX_ANSWER_CHARS = 200_000;
export const MAX_CITATIONS = 100;
export const MAX_URL_LENGTH = 2048;
export const MAX_TITLE_LENGTH = 300;
export const MAX_SNIPPET_LENGTH = 1000;
export const DEGRADED_SNIPPET_LENGTH = 200;
export const DEGRADED_MAX_CITATIONS = 50;
export const MAX_FAN_OUT_QUERIES = 50;
export const MAX_FAN_OUT_QUERY_LENGTH = 300;
export const MAX_RESPONSE_BYTES = 1_900_000;
const MAX_RAW_META_STRING_LENGTH = 256;

const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'msclkid',
  'spm',
  'vd_source',
  'from_source',
  'srsltid',
  'mc_cid',
  'mc_eid',
  'yclid',
  '_hsenc',
  '_hsmi',
  'igshid',
  'ref_src',
]);

const CORE_RAW_META_KEYS = new Set([
  'engine',
  'region',
  'provider',
  'model',
  'requestId',
  'latencyMs',
  'attempts',
  'cached',
  'costUsd',
  'tokensIn',
  'tokensOut',
  'aiOverviewTriggered',
  'citationsExtractedFromText',
  'truncatedForByteLimit',
  'upstreamRequestId',
  'market',
  'locale',
  'countryCode',
  'requestedEngine',
]);

const GOOGLE_HOST_RE = /^(?:www\.)?google\.[a-z.]+$/i;
const BING_HOST_RE = /^(?:www\.)?bing\.com$/i;
const MAX_REDIRECT_UNWRAP_DEPTH = 3;

const KNOWN_REDIRECT_HOST_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'link.zhihu.com': ['target'],
  'link.juejin.cn': ['target'],
  'link.csdn.net': ['target'],
  'link.jianshu.com': ['t'],
  'l.facebook.com': ['u'],
  'lm.facebook.com': ['u'],
  'out.reddit.com': ['url'],
  'duckduckgo.com': ['uddg'],
  't.umblr.com': ['z'],
  'c.pc.qq.com': ['url', 'pfurl'],
  'weixin110.qq.com': ['url'],
  'weibo.cn': ['u', 'toasturl'],
};

const MARKDOWN_LINK_START_RE = /\[([^\]]*)\]\((https?:\/\/)/gi;
const BARE_URL_RE =
  /https?:\/\/[^\s<>"'`\u2018\u2019\u201c\u201d\u3000\u4e00-\u9fff\u3001-\u303f\uff01-\uff5e]+/gi;
const TRAILING_PUNCT_RE = /[.,;:!?'"\u2018\u2019\u201c\u201d\]}>]+$/;
const FAN_OUT_SPLIT_RE = /[;；\r\n]+/;

export interface NormalizeMeta {
  engine: string;
  region: EngineRegion;
  requestId: string;
  latencyMs: number;
  attempts: number;
  cached: boolean;
}

export interface NormalizeInput {
  result: AdapterResult;
  prompt: string;
  meta: NormalizeMeta;
}

export function sliceSurrogateSafe(str: string, maxUnits: number): string {
  if (maxUnits <= 0) {
    return '';
  }
  if (str.length <= maxUnits) {
    return str;
  }
  const lastCode = str.charCodeAt(maxUnits - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    return str.slice(0, maxUnits - 1);
  }
  return str.slice(0, maxUnits);
}

export function stripControlChars(text: string): string {
  let out = '';
  let chunkStart = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isControl =
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f;
    if (isControl) {
      if (i > chunkStart) {
        out += text.slice(chunkStart, i);
      }
      chunkStart = i + 1;
    }
  }
  if (chunkStart === 0) {
    return text;
  }
  if (chunkStart < text.length) {
    out += text.slice(chunkStart);
  }
  return out;
}

function tryParseHttpUrl(candidate: string): URL | null {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function decodeBingClickTarget(rawParam: string): URL | null {
  const trimmed = rawParam.trim();
  if (!trimmed.startsWith('a1') || trimmed.length <= 2) {
    return null;
  }
  try {
    const decoded = Buffer.from(trimmed.slice(2), 'base64url').toString('utf8');
    return tryParseHttpUrl(decoded);
  } catch {
    return null;
  }
}

function unwrapSingleRedirectHop(parsed: URL): URL | null {
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname;

  // Google Search / AIO redirect: https://www.google.*/url?q=... or ?url=...
  if (GOOGLE_HOST_RE.test(host)) {
    if (pathname === '/url') {
      const target = parsed.searchParams.get('q') ?? parsed.searchParams.get('url');
      return target !== null ? tryParseHttpUrl(target) : null;
    }
    if (pathname.startsWith('/amp/s/') && pathname.length > '/amp/s/'.length) {
      return tryParseHttpUrl(
        `https://${pathname.slice('/amp/s/'.length)}${parsed.search}${parsed.hash}`,
      );
    }
    if (pathname.startsWith('/amp/') && pathname.length > '/amp/'.length) {
      return tryParseHttpUrl(
        `http://${pathname.slice('/amp/'.length)}${parsed.search}${parsed.hash}`,
      );
    }
  }

  // Bing click redirect: https://www.bing.com/ck/a?...&u=a1<base64url>
  if (BING_HOST_RE.test(host) && pathname.startsWith('/ck/a')) {
    const encoded = parsed.searchParams.get('u');
    return encoded !== null ? decodeBingClickTarget(encoded) : null;
  }

  // YouTube outbound redirect: https://www.youtube.com/redirect?q=...
  if ((host === 'www.youtube.com' || host === 'youtube.com') && pathname === '/redirect') {
    const target = parsed.searchParams.get('q');
    return target !== null ? tryParseHttpUrl(target) : null;
  }

  // Known redirector hosts (Zhihu, Juejin, CSDN, Jianshu, Facebook, Reddit, DuckDuckGo, QQ, Weibo, Tumblr)
  const paramNames = KNOWN_REDIRECT_HOST_PARAMS[host];
  if (paramNames !== undefined) {
    if ((host === 'l.facebook.com' || host === 'lm.facebook.com') && pathname !== '/l.php') {
      return null;
    }
    if (host === 'duckduckgo.com' && pathname !== '/l' && pathname !== '/l/') {
      return null;
    }
    if (host === 'weibo.cn' && pathname !== '/sinaurl') {
      return null;
    }
    for (const paramName of paramNames) {
      const target = parsed.searchParams.get(paramName);
      if (target !== null) {
        const unwrapped = tryParseHttpUrl(target);
        if (unwrapped !== null) {
          return unwrapped;
        }
      }
    }
  }

  return null;
}

export function normalizeUrl(rawUrl: string): string | null {
  const initial = tryParseHttpUrl(rawUrl);
  if (initial === null) {
    return null;
  }

  let parsed = initial;
  for (let hop = 0; hop < MAX_REDIRECT_UNWRAP_DEPTH; hop += 1) {
    const unwrapped = unwrapSingleRedirectHop(parsed);
    if (unwrapped === null || unwrapped.toString() === parsed.toString()) {
      break;
    }
    parsed = unwrapped;
  }

  const keysToDelete: string[] = [];
  for (const key of parsed.searchParams.keys()) {
    const lower = key.toLowerCase();
    if (lower.startsWith('utm_') || TRACKING_PARAMS.has(lower)) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    parsed.searchParams.delete(key);
  }

  if (parsed.hash === '' || parsed.hash === '#') {
    parsed.hash = '';
  }

  let href = parsed.toString();
  if (href.endsWith('#')) {
    href = href.slice(0, -1);
  }

  if (href.length > MAX_URL_LENGTH) {
    return null;
  }

  return href;
}

function cleanBareUrl(raw: string): string {
  let url = raw.replace(TRAILING_PUNCT_RE, '');
  while (url.endsWith(')')) {
    let openCount = 0;
    let closeCount = 0;
    for (let i = 0; i < url.length; i++) {
      const ch = url[i];
      if (ch === '(') openCount++;
      else if (ch === ')') closeCount++;
    }
    if (closeCount > openCount) {
      url = url.slice(0, -1).replace(TRAILING_PUNCT_RE, '');
    } else {
      break;
    }
  }
  return url;
}

export function extractCitationsFromText(text: string): RawCitation[] {
  const extracted: RawCitation[] = [];
  const scratchParts: string[] = [];
  let cursor = 0;

  MARKDOWN_LINK_START_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_LINK_START_RE.exec(text)) !== null) {
    const matchStart = match.index;
    const rawTitle = match[1];
    const scheme = match[2];
    if (scheme === undefined) {
      continue;
    }

    const urlStart = matchStart + match[0].length - scheme.length;
    let i = matchStart + match[0].length;
    let parenDepth = 0;
    let closingIndex = -1;

    while (i < text.length) {
      const ch = text[i];
      if (ch === undefined || /\s/.test(ch)) {
        break;
      }
      if (ch === '(') {
        parenDepth += 1;
      } else if (ch === ')') {
        if (parenDepth === 0) {
          closingIndex = i;
          break;
        }
        parenDepth -= 1;
      }
      i += 1;
    }

    if (closingIndex !== -1) {
      const rawUrl = text.slice(urlStart, closingIndex);
      const matchEnd = closingIndex + 1;
      const cleanedTitle = rawTitle?.trim();
      extracted.push({
        url: rawUrl,
        ...(cleanedTitle !== undefined && cleanedTitle.length > 0 ? { title: cleanedTitle } : {}),
      });
      if (matchStart > cursor) {
        scratchParts.push(text.slice(cursor, matchStart));
      }
      scratchParts.push(' '.repeat(matchEnd - matchStart));
      cursor = matchEnd;
      MARKDOWN_LINK_START_RE.lastIndex = matchEnd;
    }
  }

  if (cursor < text.length) {
    scratchParts.push(text.slice(cursor));
  }
  const scratch = scratchParts.join('');

  for (const bareMatch of scratch.matchAll(BARE_URL_RE)) {
    const candidate = bareMatch[0];
    if (candidate !== undefined) {
      const cleaned = cleanBareUrl(candidate);
      if (cleaned.length > 0) {
        extracted.push({ url: cleaned });
      }
    }
  }

  return extracted;
}

export function normalizeCitations(rawCitations: RawCitation[]): NormalizedCitation[] {
  const byUrl = new Map<string, NormalizedCitation>();
  const normalized: NormalizedCitation[] = [];

  for (const raw of rawCitations) {
    if (typeof raw.url !== 'string') {
      continue;
    }
    const url = normalizeUrl(raw.url);
    if (url === null) {
      continue;
    }

    const cleanedTitle =
      typeof raw.title === 'string'
        ? sliceSurrogateSafe(stripControlChars(raw.title).trim(), MAX_TITLE_LENGTH).trim()
        : '';
    const cleanedSnippet =
      typeof raw.snippet === 'string'
        ? sliceSurrogateSafe(stripControlChars(raw.snippet).trim(), MAX_SNIPPET_LENGTH).trim()
        : '';

    const existing = byUrl.get(url);
    if (existing !== undefined) {
      if (existing.title === undefined && cleanedTitle.length > 0) {
        existing.title = cleanedTitle;
      }
      if (existing.snippet === undefined && cleanedSnippet.length > 0) {
        existing.snippet = cleanedSnippet;
      }
      continue;
    }

    if (normalized.length >= MAX_CITATIONS) {
      break;
    }

    const entry: NormalizedCitation = {
      url,
      ...(cleanedTitle.length > 0 ? { title: cleanedTitle } : {}),
      ...(cleanedSnippet.length > 0 ? { snippet: cleanedSnippet } : {}),
      position: normalized.length + 1,
    };

    byUrl.set(url, entry);
    normalized.push(entry);
  }

  return normalized;
}

/**
 * Splits a single raw query string on ASCII/full-width semicolons and line breaks
 * (`;`, `；`, `\r`, `\n`), strips control chars, collapses horizontal spaces,
 * and drops empty segments so every returned entry is one clean standalone query.
 */
export function splitFanOutQueryString(raw: string): string[] {
  const stripped = stripControlChars(raw);
  if (stripped.length === 0) {
    return [];
  }

  const segments: string[] = [];
  for (const part of stripped.split(FAN_OUT_SPLIT_RE)) {
    const cleaned = part.replace(/[ \t]+/g, ' ').trim();
    if (cleaned.length > 0) {
      segments.push(cleaned);
    }
  }
  return segments;
}

export function normalizeFanOutQueries(rawQueries: string[], originalPrompt: string): string[] {
  const promptLower = originalPrompt
    .trim()
    .replace(/[ \t]+/g, ' ')
    .toLowerCase();
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of rawQueries) {
    if (result.length >= MAX_FAN_OUT_QUERIES) {
      break;
    }
    if (typeof raw !== 'string') {
      continue;
    }
    for (const part of splitFanOutQueryString(raw)) {
      if (result.length >= MAX_FAN_OUT_QUERIES) {
        break;
      }
      if (part.toLowerCase() === promptLower) {
        continue;
      }
      const cleaned = sliceSurrogateSafe(part, MAX_FAN_OUT_QUERY_LENGTH).trim();
      if (cleaned.length === 0) {
        continue;
      }
      const lower = cleaned.toLowerCase();
      if (lower === promptLower || seen.has(lower)) {
        continue;
      }
      seen.add(lower);
      result.push(cleaned);
    }
  }

  return result;
}

function serializedByteLength(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

function stripNonCoreRawMeta(rawMeta: CollectResponse['rawMeta']): CollectResponse['rawMeta'] {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawMeta)) {
    if (CORE_RAW_META_KEYS.has(key) && value !== undefined) {
      if (
        (key === 'upstreamRequestId' || key === 'model' || key === 'provider') &&
        typeof value === 'string'
      ) {
        stripped[key] = sliceSurrogateSafe(value, MAX_RAW_META_STRING_LENGTH);
      } else {
        stripped[key] = value;
      }
    }
  }
  return stripped as CollectResponse['rawMeta'];
}

function binarySearchAnswerText(payload: CollectResponse): string {
  const full = payload.answerText;
  let lo = 1;
  let hi = full.length;
  let best = '';

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = sliceSurrogateSafe(full, mid);
    if (candidate.length === 0) {
      lo = mid + 1;
      continue;
    }
    const bytes = serializedByteLength({ ...payload, answerText: candidate });
    if (bytes <= MAX_RESPONSE_BYTES) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return best;
}

export function normalizeResponse(input: NormalizeInput): CollectResponse {
  // Step 1: Control-char strip & answerText clean
  const cleanedAnswer = stripControlChars(input.result.answerText).trim();
  if (cleanedAnswer.length === 0) {
    throw new GatewayError(502, 'UPSTREAM_BAD_RESPONSE', '上游返回了空回答', {
      retryable: true,
      engine: input.meta.engine,
    });
  }
  const answerText = sliceSurrogateSafe(cleanedAnswer, MAX_ANSWER_CHARS);

  // Step 2 & 3: URL normalization & cleaning + citation fallback extraction
  let citationsExtractedFromText = false;
  let citations = normalizeCitations(input.result.citations);

  if (citations.length === 0) {
    const extracted = extractCitationsFromText(answerText);
    citations = normalizeCitations(extracted);
    if (citations.length > 0) {
      citationsExtractedFromText = true;
    }
  }

  // Step 4: fanOutQueries cleaning
  const fanOutQueries = normalizeFanOutQueries(input.result.fanOutQueries, input.prompt);

  // Build rawMeta omitting undefined values
  const cleanedAdapterMeta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.result.rawMeta)) {
    if (value !== undefined) {
      cleanedAdapterMeta[key] = value;
    }
  }

  const rawMeta: CollectResponse['rawMeta'] = {
    ...cleanedAdapterMeta,
    provider: input.result.rawMeta.provider,
    engine: input.meta.engine,
    region: input.meta.region,
    requestId: input.meta.requestId,
    latencyMs: Math.max(0, Math.round(input.meta.latencyMs)),
    attempts: Math.max(1, Math.round(input.meta.attempts)),
    cached: input.meta.cached,
    ...(citationsExtractedFromText ? { citationsExtractedFromText: true } : {}),
  };

  const payload: CollectResponse = {
    answerText,
    citations,
    fanOutQueries,
    rawMeta,
  };

  // Step 5: 3-tier 1_900_000-byte guard
  if (serializedByteLength(payload) > MAX_RESPONSE_BYTES) {
    payload.rawMeta.truncatedForByteLimit = true;

    // Tier 1: Truncate all citation snippets to <= 200 chars
    payload.citations = payload.citations.map((c) => {
      if (c.snippet === undefined) {
        return c;
      }
      const truncated = sliceSurrogateSafe(c.snippet, DEGRADED_SNIPPET_LENGTH).trim();
      if (truncated.length === 0) {
        const { snippet: _removed, ...rest } = c;
        return rest;
      }
      return {
        ...c,
        snippet: truncated,
      };
    });

    // Tier 2: Cap citations to 50
    if (serializedByteLength(payload) > MAX_RESPONSE_BYTES) {
      payload.citations = payload.citations.slice(0, DEGRADED_MAX_CITATIONS);
    }

    // Tier 3: Strip non-core rawMeta first, then binary-search answerText length to fit <= 1_900_000 UTF-8 bytes
    if (serializedByteLength(payload) > MAX_RESPONSE_BYTES) {
      payload.rawMeta = stripNonCoreRawMeta(payload.rawMeta);

      if (serializedByteLength(payload) > MAX_RESPONSE_BYTES) {
        let fitted = binarySearchAnswerText(payload);
        if (fitted.length === 0) {
          // Safety valve: drop citations and fanOutQueries if lists + metadata still overflow
          payload.citations = [];
          payload.fanOutQueries = [];
          if (serializedByteLength(payload) <= MAX_RESPONSE_BYTES) {
            fitted = payload.answerText;
          } else {
            fitted = binarySearchAnswerText(payload);
          }
        }
        if (fitted.length > 0) {
          payload.answerText = fitted;
        }
      }
    }
  }

  // Final post-condition guard: never emit > MAX_RESPONSE_BYTES
  if (serializedByteLength(payload) > MAX_RESPONSE_BYTES) {
    throw new GatewayError(
      502,
      'UPSTREAM_BAD_RESPONSE',
      `Normalized response exceeded ${MAX_RESPONSE_BYTES} bytes limit`,
      {
        retryable: false,
        engine: input.meta.engine,
      },
    );
  }

  // Step 6: Final contract assertion
  return collectResponseSchema.parse(payload);
}
