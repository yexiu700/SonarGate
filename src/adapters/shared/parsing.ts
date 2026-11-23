import { splitFanOutQueryString } from '../../core/normalizer.js';
import type { RawCitation, RetrievedSource } from '../../core/types.js';

const FORBIDDEN_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface ExtractCitationOptions {
  /** When true (Tongyi / Yuanbao), falls back to `site_name` if snippet/content/summary/desc are absent. */
  fallbackSnippetToSiteName?: boolean | undefined;
}

/** Narrow unknown to non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrow unknown to plain object (Object.prototype or null prototype) for safe deep merging. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Return string as-is if typeof === 'string', else undefined (preserves formatting for answerText). */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Return trimmed string if typeof === 'string' and trimmed.length > 0, else undefined. */
export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Return integer >= 0 if finite integer, else undefined (matches collectResponseSchema tokensIn/Out). */
export function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  return undefined;
}

/** Return integer > 0 if finite positive integer, else undefined (for optional citation position). */
export function asPositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  return undefined;
}

/** Strip trailing slashes from a base URL. */
export function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Splits semicolon/newline-concatenated query strings and deduplicates
 * trimmed non-empty strings preserving first occurrence (case-insensitive key).
 */
export function dedupeQueryStrings(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of items) {
    for (const part of splitFanOutQueryString(raw)) {
      const key = part.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(part);
    }
  }

  return result;
}

/** Extract trimmed non-empty strings from an unknown array (or single string), split & deduplicated preserving order. */
export function extractStringQueries(value: unknown): string[] {
  if (typeof value === 'string') {
    return dedupeQueryStrings([value]);
  }
  if (!Array.isArray(value)) {
    return [];
  }

  const collected: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      collected.push(item);
    }
  }
  return dedupeQueryStrings(collected);
}

/** Extracts text from string or OpenAI/Anthropic multipart content blocks. */
export function extractMessageText(content: unknown): string {
  const direct = asString(content);
  if (direct !== undefined) {
    return direct;
  }

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part);
      } else if (isRecord(part)) {
        const partType = asNonEmptyString(part['type']);
        if (partType === 'thinking' || partType === 'reasoning') {
          continue;
        }
        const text = asString(part['text']) ?? asString(part['content']);
        if (text !== undefined) {
          parts.push(text);
        }
      }
    }
    return parts.join('\n');
  }

  return '';
}

function firstNonEmptyFromRecords(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
): string | undefined {
  for (const rec of records) {
    for (const key of keys) {
      const val = asNonEmptyString(rec[key]);
      if (val !== undefined) {
        return val;
      }
    }
  }
  return undefined;
}

function firstPositiveIntFromRecords(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
): number | undefined {
  for (const rec of records) {
    for (const key of keys) {
      const val = asPositiveInt(rec[key]);
      if (val !== undefined) {
        return val;
      }
    }
  }
  return undefined;
}

function unwrapCitationEntry(entry: Record<string, unknown>): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [];
  for (const nestedKey of [
    'url_citation',
    'web',
    'retrievedContext',
    'retrieved_context',
    'source',
  ] as const) {
    const nested = entry[nestedKey];
    if (isRecord(nested)) {
      candidates.push(nested);
    }
  }
  candidates.push(entry);
  return candidates;
}

function upsertCitation(
  byUrl: Map<string, RawCitation>,
  citations: RawCitation[],
  incoming: RawCitation,
): void {
  const url = incoming.url.trim();
  if (url.length === 0) {
    return;
  }

  const existing = byUrl.get(url);
  if (existing !== undefined) {
    if (existing.title === undefined && incoming.title !== undefined) {
      existing.title = incoming.title;
    }
    if (existing.snippet === undefined && incoming.snippet !== undefined) {
      existing.snippet = incoming.snippet;
    }
    if (existing.position === undefined && incoming.position !== undefined) {
      existing.position = incoming.position;
    }
    return;
  }

  const entry: RawCitation = {
    url,
    ...(incoming.title !== undefined ? { title: incoming.title } : {}),
    ...(incoming.snippet !== undefined ? { snippet: incoming.snippet } : {}),
    ...(incoming.position !== undefined ? { position: incoming.position } : {}),
  };
  byUrl.set(url, entry);
  citations.push(entry);
}

/**
 * Defensive citation extractor:
 * - Unwraps nested `url_citation`, `web`, `retrievedContext`, `retrieved_context`, `source`
 * - URL:     url ?? uri ?? link ?? href ?? source_url ?? page_url ?? target_url
 * - Title:   title ?? name ?? site_name ?? source_name ?? sitename ?? domain
 * - Snippet: snippet ?? content ?? summary ?? desc ?? description ?? cited_text ?? text ?? abstract ?? quote
 *            (plus site_name if options.fallbackSnippetToSiteName)
 * - Position (optional): positive int from position ?? index ?? rank ?? rank_absolute
 * Also accepts bare string URL elements (e.g. DeepSeek/Perplexity `data.citations: ["https://..."]`).
 * Deduplicates by trimmed URL preserving first occurrence while enriching missing metadata.
 */
export function extractCitations(
  rawList: unknown,
  options?: ExtractCitationOptions,
): RawCitation[] {
  if (!Array.isArray(rawList)) {
    return [];
  }

  const byUrl = new Map<string, RawCitation>();
  const citations: RawCitation[] = [];

  for (const entry of rawList) {
    if (typeof entry === 'string') {
      const url = asNonEmptyString(entry);
      if (url !== undefined) {
        upsertCitation(byUrl, citations, { url });
      }
      continue;
    }

    if (!isRecord(entry)) {
      continue;
    }

    const records = unwrapCitationEntry(entry);
    const url = firstNonEmptyFromRecords(records, [
      'url',
      'uri',
      'link',
      'href',
      'source_url',
      'page_url',
      'target_url',
    ]);

    if (url === undefined) {
      continue;
    }

    const title = firstNonEmptyFromRecords(records, [
      'title',
      'name',
      'site_name',
      'source_name',
      'sitename',
      'domain',
    ]);

    const snippet =
      firstNonEmptyFromRecords(records, [
        'snippet',
        'content',
        'summary',
        'desc',
        'description',
        'cited_text',
        'text',
        'abstract',
        'quote',
      ]) ??
      (options?.fallbackSnippetToSiteName === true
        ? firstNonEmptyFromRecords(records, ['site_name', 'sitename', 'source_name'])
        : undefined);

    const position = firstPositiveIntFromRecords(records, [
      'position',
      'index',
      'rank',
      'rank_absolute',
    ]);

    upsertCitation(byUrl, citations, {
      url,
      ...(title !== undefined ? { title } : {}),
      ...(snippet !== undefined ? { snippet } : {}),
      ...(position !== undefined ? { position } : {}),
    });
  }

  return citations;
}

/**
 * Merge multiple raw citation sources in priority order and deduplicate by trimmed URL
 * preserving first occurrence while enriching missing title/snippet/position from later sources.
 */
export function mergeCitations(
  sources: readonly unknown[],
  options?: ExtractCitationOptions,
): RawCitation[] {
  const byUrl = new Map<string, RawCitation>();
  const merged: RawCitation[] = [];

  for (const source of sources) {
    const extracted = extractCitations(source, options);
    for (const citation of extracted) {
      upsertCitation(byUrl, merged, citation);
    }
  }

  return merged;
}

/** Deduplicate already-extracted RawCitation lists while enriching missing title/snippet/position. */
export function mergeRawCitationLists(lists: readonly (readonly RawCitation[])[]): RawCitation[] {
  const byUrl = new Map<string, RawCitation>();
  const merged: RawCitation[] = [];

  for (const list of lists) {
    for (const item of list) {
      upsertCitation(byUrl, merged, item);
    }
  }

  return merged;
}

/**
 * Extracts search queries and any embedded citations from OpenAI-style `tool_calls[]`
 * (e.g. Kimi `$web_search`, Claude/DeepSeek/relay search tool calls).
 */
export function extractToolCallSearchInfo(toolCalls: unknown): {
  queries: string[];
  citations: RawCitation[];
} {
  if (!Array.isArray(toolCalls)) {
    return { queries: [], citations: [] };
  }

  const queries: string[] = [];
  const citationSources: unknown[] = [];

  for (const tc of toolCalls) {
    if (!isRecord(tc)) {
      continue;
    }
    const fn = isRecord(tc['function']) ? tc['function'] : undefined;
    const fnName = (
      asNonEmptyString(fn?.['name']) ??
      asNonEmptyString(tc['name']) ??
      ''
    ).toLowerCase();
    if (fnName.length > 0 && !fnName.includes('search') && !fnName.includes('browse')) {
      continue;
    }

    const rawArgs = fn?.['arguments'] ?? tc['arguments'] ?? tc['input'];
    let parsedArgs: Record<string, unknown> | undefined;
    if (isRecord(rawArgs)) {
      parsedArgs = rawArgs;
    } else if (typeof rawArgs === 'string') {
      try {
        const parsed: unknown = JSON.parse(rawArgs);
        if (isRecord(parsed)) {
          parsedArgs = parsed;
        }
      } catch {
        // Ignore non-JSON arguments
      }
    }

    if (parsedArgs === undefined) {
      continue;
    }

    for (const key of [
      'query',
      'queries',
      'search_query',
      'search_queries',
      'keywords',
      'q',
    ] as const) {
      queries.push(...extractStringQueries(parsedArgs[key]));
    }

    for (const key of [
      'search_results',
      'search_result',
      'citations',
      'sources',
      'results',
      'web_pages',
      'urls',
    ] as const) {
      if (parsedArgs[key] !== undefined) {
        citationSources.push(parsedArgs[key]);
      }
    }
  }

  return {
    queries: dedupeQueryStrings(queries),
    citations: mergeCitations(citationSources),
  };
}

export interface ServerToolCallSearchInfo {
  /** Search sub-queries in round order, deduplicated (case-insensitive). */
  queries: string[];
  /** Pages recalled by `search` actions (deduplicated by URL; `opened: true` when also opened). */
  retrievedSources: RetrievedSource[];
  /** Pages the model actually opened via `open_page` actions (deduplicated by URL). */
  openedPages: RetrievedSource[];
  /** Number of `search` calls observed. */
  searchCallCount: number;
  /** Number of `open_page` calls observed. */
  openPageCallCount: number;
}

const SERVER_TOOL_SEARCH_ACTIONS = new Set(['search', 'web_search', 'search_query', 'query']);
const SERVER_TOOL_OPEN_ACTIONS = new Set([
  'open_page',
  'open',
  'open_url',
  'fetch',
  'fetch_page',
  'browse',
  'visit',
]);

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = asNonEmptyString(record[key]);
    if (value !== undefined) {
      return value.trim();
    }
  }
  return undefined;
}

function toRetrievedSource(entry: unknown): RetrievedSource | undefined {
  if (typeof entry === 'string') {
    const url = entry.trim();
    return /^https?:\/\//i.test(url) ? { url } : undefined;
  }
  if (!isRecord(entry)) {
    return undefined;
  }
  const url = firstString(entry, ['url', 'uri', 'link', 'href', 'source_url', 'page_url']);
  if (url === undefined || !/^https?:\/\//i.test(url)) {
    return undefined;
  }
  const title = firstString(entry, ['title', 'name']);
  const snippet = firstString(entry, ['snippet', 'summary', 'content', 'description', 'desc']);
  const siteName = firstString(entry, ['site_name', 'siteName', 'source_name', 'sitename']);
  const publishedAt = firstString(entry, [
    'published_at',
    'publishedAt',
    'publish_time',
    'published_time',
    'date',
  ]);
  return {
    url,
    ...(title !== undefined ? { title } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    ...(siteName !== undefined ? { siteName } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
  };
}

function upsertRetrievedSource(
  byUrl: Map<string, RetrievedSource>,
  list: RetrievedSource[],
  source: RetrievedSource,
): void {
  const existing = byUrl.get(source.url);
  if (existing === undefined) {
    const copy: RetrievedSource = { ...source };
    byUrl.set(source.url, copy);
    list.push(copy);
    return;
  }
  for (const key of ['title', 'snippet', 'siteName', 'publishedAt'] as const) {
    if (existing[key] === undefined && source[key] !== undefined) {
      existing[key] = source[key];
    }
  }
  if (source.opened === true) {
    existing.opened = true;
  }
}

/** Flattens `server_tool_calls[]` rounds (each with `calls[]`) into calls, preserving round order. */
function flattenServerToolCalls(serverToolCalls: unknown): Record<string, unknown>[] {
  if (!Array.isArray(serverToolCalls)) {
    return [];
  }
  const rounds = serverToolCalls
    .map((round, order) => ({ round, order }))
    .filter((r): r is { round: Record<string, unknown>; order: number } => isRecord(r.round));
  const indexOf = (round: Record<string, unknown>): number | undefined => {
    const idx = round['index'];
    return typeof idx === 'number' && Number.isFinite(idx) ? idx : undefined;
  };
  if (rounds.every((r) => indexOf(r.round) !== undefined)) {
    rounds.sort((a, b) => (indexOf(a.round) ?? 0) - (indexOf(b.round) ?? 0) || a.order - b.order);
  }

  const calls: Record<string, unknown>[] = [];
  for (const { round } of rounds) {
    if (Array.isArray(round['calls'])) {
      for (const call of round['calls']) {
        if (isRecord(call)) {
          calls.push(call);
        }
      }
    } else if (isRecord(round['action'])) {
      // Tolerate a flat shape where each entry is already a call.
      calls.push(round);
    }
  }
  return calls;
}

/**
 * Extracts the server-side search trace from DeepSeek-style `message.server_tool_calls[]`
 * (`tools: [{ type: "deepseek_web_search" }]`):
 * - `action.type === "search"` → `action.queries[]` / `action.query` become fan-out queries,
 *   `sources[]` become recalled (retrieved) sources;
 * - `action.type === "open_page"` → `action.url` / `page.url` become opened pages
 *   (never counted as fan-out).
 * Recalled / opened pages are deliberately kept separate from final citations.
 */
export function extractServerToolCallSearchInfo(
  serverToolCalls: unknown,
): ServerToolCallSearchInfo {
  const queries: string[] = [];
  const retrievedByUrl = new Map<string, RetrievedSource>();
  const retrievedSources: RetrievedSource[] = [];
  const openedByUrl = new Map<string, RetrievedSource>();
  const openedPages: RetrievedSource[] = [];
  let searchCallCount = 0;
  let openPageCallCount = 0;

  for (const call of flattenServerToolCalls(serverToolCalls)) {
    const action = isRecord(call['action']) ? call['action'] : {};
    let actionType = (asNonEmptyString(action['type']) ?? '').trim().toLowerCase();
    if (actionType.length === 0) {
      if (action['queries'] !== undefined || action['query'] !== undefined) {
        actionType = 'search';
      } else if (action['url'] !== undefined || isRecord(call['page'])) {
        actionType = 'open_page';
      }
    }

    if (SERVER_TOOL_SEARCH_ACTIONS.has(actionType)) {
      searchCallCount += 1;
      queries.push(
        ...extractStringQueries(action['queries']),
        ...extractStringQueries(action['query']),
        ...extractStringQueries(action['keywords']),
      );
      for (const sourceList of [call['sources'], action['sources'], call['results']]) {
        if (!Array.isArray(sourceList)) {
          continue;
        }
        for (const entry of sourceList) {
          const source = toRetrievedSource(entry);
          if (source !== undefined) {
            upsertRetrievedSource(retrievedByUrl, retrievedSources, source);
          }
        }
      }
    } else if (SERVER_TOOL_OPEN_ACTIONS.has(actionType)) {
      openPageCallCount += 1;
      const page = isRecord(call['page']) ? call['page'] : undefined;
      const fromPage = page !== undefined ? toRetrievedSource(page) : undefined;
      const fromAction = toRetrievedSource(asNonEmptyString(action['url']) ?? action);
      const merged = fromPage ?? fromAction;
      if (merged !== undefined) {
        upsertRetrievedSource(openedByUrl, openedPages, { ...merged, opened: true });
        if (fromPage !== undefined && fromAction !== undefined && fromAction.url !== fromPage.url) {
          upsertRetrievedSource(openedByUrl, openedPages, { ...fromAction, opened: true });
        }
      }
    }
  }

  for (const opened of openedPages) {
    const recalled = retrievedByUrl.get(opened.url);
    if (recalled !== undefined) {
      recalled.opened = true;
    }
  }

  return {
    queries: dedupeQueryStrings(queries),
    retrievedSources,
    openedPages,
    searchCallCount,
    openPageCallCount,
  };
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item));
  }
  if (isPlainObject(value)) {
    const cloned: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_MERGE_KEYS.has(key)) {
        continue;
      }
      const val = value[key];
      if (val !== undefined) {
        cloned[key] = cloneValue(val);
      }
    }
    return cloned;
  }
  return value;
}

/**
 * Prototype-pollution-safe shallow merge.
 * Skips __proto__, constructor, prototype and undefined values. Does not mutate inputs.
 */
export function shallowMergeRecord(
  base: Readonly<Record<string, unknown>>,
  override: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(base)) {
    if (FORBIDDEN_MERGE_KEYS.has(key)) {
      continue;
    }
    const val = base[key];
    if (val !== undefined) {
      result[key] = val;
    }
  }

  for (const key of Object.keys(override)) {
    if (FORBIDDEN_MERGE_KEYS.has(key)) {
      continue;
    }
    const val = override[key];
    if (val !== undefined) {
      result[key] = val;
    }
  }

  return result;
}

/**
 * Prototype-pollution-safe deep merge.
 * - Skips __proto__, constructor, prototype and undefined values.
 * - Recursively merges when both base[k] and override[k] are plain objects.
 * - Replaces arrays (cloned) and primitives.
 * - Does not mutate base or override.
 */
export function deepMergeRecords(
  base: Readonly<Record<string, unknown>>,
  override: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(base)) {
    if (FORBIDDEN_MERGE_KEYS.has(key)) {
      continue;
    }
    const val = base[key];
    if (val !== undefined) {
      result[key] = cloneValue(val);
    }
  }

  for (const key of Object.keys(override)) {
    if (FORBIDDEN_MERGE_KEYS.has(key)) {
      continue;
    }
    const overrideVal = override[key];
    if (overrideVal === undefined) {
      continue;
    }
    const baseVal = result[key];
    if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
      result[key] = deepMergeRecords(baseVal, overrideVal);
    } else {
      result[key] = cloneValue(overrideVal);
    }
  }

  return result;
}
