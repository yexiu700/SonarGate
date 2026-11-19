import type { AdapterResult, RawCitation } from '../../core/types.js';
import { asNonEmptyString, isRecord } from '../shared/parsing.js';

export const NO_AI_OVERVIEW_TEXT = '[NO_AI_OVERVIEW] 该查询未触发 Google AI Overview。';

export interface DataForSeoParseMeta {
  costUsd?: number | undefined;
  upstreamRequestId?: string | undefined;
  fallbackModel?: string | undefined;
}

const DEFAULT_SNIPPET_KEYS = ['snippet', 'description', 'text', 'content'] as const;
const AIO_SNIPPET_KEYS = ['text', 'snippet', 'description'] as const;

function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.trunc(value);
}

function firstStringField(
  obj: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const val = asNonEmptyString(obj[key]);
    if (val !== undefined) {
      return val;
    }
  }
  return undefined;
}

function extractCitations(
  lists: readonly unknown[],
  snippetKeys: readonly string[] = DEFAULT_SNIPPET_KEYS,
): RawCitation[] {
  const seen = new Set<string>();
  const citations: RawCitation[] = [];

  for (const list of lists) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entry of list) {
      if (!isRecord(entry)) {
        continue;
      }
      const url = firstStringField(entry, ['url', 'link', 'href', 'source_url']);
      if (url === undefined || seen.has(url)) {
        continue;
      }
      seen.add(url);

      const title = firstStringField(entry, ['title', 'name', 'source_name', 'domain']);
      const snippet = firstStringField(entry, snippetKeys);

      citations.push({
        url,
        ...(title !== undefined ? { title } : {}),
        ...(snippet !== undefined ? { snippet } : {}),
      });
    }
  }

  return citations;
}

function extractTextFromItems(items: unknown): string {
  if (!Array.isArray(items)) {
    return '';
  }

  const parts: string[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const before = parts.length;
    if (Array.isArray(item['sections'])) {
      for (const section of item['sections']) {
        if (!isRecord(section)) {
          continue;
        }
        const sectionText =
          asNonEmptyString(section['text']) ?? asNonEmptyString(section['markdown']);
        if (sectionText !== undefined) {
          parts.push(sectionText);
        }
      }
    }
    if (parts.length === before) {
      const itemText = asNonEmptyString(item['markdown']) ?? asNonEmptyString(item['text']);
      if (itemText !== undefined) {
        parts.push(itemText);
      }
    }
  }

  return parts.join('\n\n');
}

function collectAnnotationsFromItems(items: unknown): unknown[] {
  if (!Array.isArray(items)) {
    return [];
  }

  const collected: unknown[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    if (Array.isArray(item['annotations'])) {
      collected.push(...item['annotations']);
    }
    if (Array.isArray(item['sources'])) {
      collected.push(...item['sources']);
    }
    if (Array.isArray(item['sections'])) {
      for (const section of item['sections']) {
        if (!isRecord(section)) {
          continue;
        }
        if (Array.isArray(section['annotations'])) {
          collected.push(...section['annotations']);
        }
      }
    }
  }
  return collected;
}

function extractFanOutQueries(...lists: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const queries: string[] = [];

  for (const list of lists) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entry of list) {
      const query = asNonEmptyString(entry);
      if (query !== undefined && !seen.has(query)) {
        seen.add(query);
        queries.push(query);
      }
    }
  }

  return queries;
}

function buildRawMeta(
  meta: DataForSeoParseMeta,
  extra: {
    model?: string | undefined;
    tokensIn?: number | undefined;
    tokensOut?: number | undefined;
    aiOverviewTriggered?: boolean | undefined;
  } = {},
): AdapterResult['rawMeta'] {
  const model = extra.model ?? meta.fallbackModel;
  return {
    provider: 'dataforseo',
    ...(model !== undefined ? { model } : {}),
    ...(meta.upstreamRequestId !== undefined ? { upstreamRequestId: meta.upstreamRequestId } : {}),
    ...(extra.tokensIn !== undefined ? { tokensIn: extra.tokensIn } : {}),
    ...(extra.tokensOut !== undefined ? { tokensOut: extra.tokensOut } : {}),
    ...(meta.costUsd !== undefined ? { costUsd: meta.costUsd } : {}),
    ...(extra.aiOverviewTriggered !== undefined
      ? { aiOverviewTriggered: extra.aiOverviewTriggered }
      : {}),
  };
}

export function parseChatGptResult(
  result: Record<string, unknown>,
  meta: DataForSeoParseMeta = {},
): AdapterResult {
  const answerText = asNonEmptyString(result['markdown']) ?? extractTextFromItems(result['items']);

  const itemAnnotations = collectAnnotationsFromItems(result['items']);
  const citations = extractCitations([
    result['sources'],
    result['search_results'],
    itemAnnotations,
  ]);

  const fanOutQueries = extractFanOutQueries(result['fan_out_queries'], result['search_queries']);

  const model = asNonEmptyString(result['model_name']);

  return {
    answerText,
    citations,
    fanOutQueries,
    rawMeta: buildRawMeta(meta, { model }),
  };
}

export function parseLlmResponsesResult(
  result: Record<string, unknown>,
  meta: DataForSeoParseMeta = {},
): AdapterResult {
  const itemsText = extractTextFromItems(result['items']);
  const answerText =
    itemsText.length > 0 ? itemsText : (asNonEmptyString(result['markdown']) ?? '');

  const itemAnnotations = collectAnnotationsFromItems(result['items']);
  const citations = extractCitations([
    itemAnnotations,
    result['sources'],
    result['search_results'],
  ]);

  const fanOutQueries = extractFanOutQueries(result['fan_out_queries'], result['search_queries']);

  const model = asNonEmptyString(result['model_name']);
  const tokensIn = asNonNegativeInt(result['input_tokens']);
  const tokensOut = asNonNegativeInt(result['output_tokens']);

  return {
    answerText,
    citations,
    fanOutQueries,
    rawMeta: buildRawMeta(meta, { model, tokensIn, tokensOut }),
  };
}

export function parsePerplexityResult(
  result: Record<string, unknown>,
  meta: DataForSeoParseMeta = {},
): AdapterResult {
  return parseLlmResponsesResult(result, meta);
}

export function parseClaudeResult(
  result: Record<string, unknown>,
  meta: DataForSeoParseMeta = {},
): AdapterResult {
  return parseLlmResponsesResult(result, meta);
}

export function parseGeminiResult(
  result: Record<string, unknown>,
  meta: DataForSeoParseMeta = {},
): AdapterResult {
  const answerText = asNonEmptyString(result['markdown']) ?? extractTextFromItems(result['items']);

  const itemAnnotations = collectAnnotationsFromItems(result['items']);
  const citations = extractCitations([
    result['sources'],
    result['search_results'],
    itemAnnotations,
  ]);

  const fanOutQueries = extractFanOutQueries(result['fan_out_queries'], result['search_queries']);

  const model = asNonEmptyString(result['model_name']);
  const tokensIn = asNonNegativeInt(result['input_tokens']);
  const tokensOut = asNonNegativeInt(result['output_tokens']);

  return {
    answerText,
    citations,
    fanOutQueries,
    rawMeta: buildRawMeta(meta, { model, tokensIn, tokensOut }),
  };
}

function collectAioTextParts(items: unknown, parts: string[]): void {
  if (!Array.isArray(items)) {
    return;
  }

  for (const entry of items) {
    if (!isRecord(entry)) {
      continue;
    }
    const title = asNonEmptyString(entry['title']);
    const text = asNonEmptyString(entry['text']);
    const markdown = asNonEmptyString(entry['markdown']);

    if (title !== undefined) {
      parts.push(title);
    }
    if (text !== undefined) {
      parts.push(text);
    }
    if (title === undefined && text === undefined && markdown !== undefined) {
      parts.push(markdown);
    }
    if (Array.isArray(entry['items'])) {
      collectAioTextParts(entry['items'], parts);
    }
  }
}

function collectAioReferenceLists(node: Record<string, unknown>, lists: unknown[]): void {
  if (Array.isArray(node['references'])) {
    lists.push(node['references']);
  }
  if (Array.isArray(node['items'])) {
    for (const child of node['items']) {
      if (isRecord(child)) {
        collectAioReferenceLists(child, lists);
      }
    }
  }
}

export function parseGoogleAioResult(
  result: Record<string, unknown>,
  meta: DataForSeoParseMeta = {},
): AdapterResult {
  const items = Array.isArray(result['items']) ? result['items'] : [];
  let aioItem: Record<string, unknown> | undefined;

  for (const entry of items) {
    if (isRecord(entry) && entry['type'] === 'ai_overview') {
      aioItem = entry;
      break;
    }
  }

  if (aioItem === undefined) {
    return {
      answerText: NO_AI_OVERVIEW_TEXT,
      citations: [],
      fanOutQueries: [],
      rawMeta: buildRawMeta(meta, { aiOverviewTriggered: false }),
    };
  }

  let answerText = asNonEmptyString(aioItem['markdown']);
  if (answerText === undefined) {
    const parts: string[] = [];
    collectAioTextParts(aioItem['items'], parts);
    const joined = parts.join('\n\n');
    answerText = joined.length > 0 ? joined : (asNonEmptyString(aioItem['text']) ?? '');
  }

  const referenceLists: unknown[] = [];
  collectAioReferenceLists(aioItem, referenceLists);
  const citations = extractCitations(referenceLists, AIO_SNIPPET_KEYS);

  return {
    answerText,
    citations,
    fanOutQueries: [],
    rawMeta: buildRawMeta(meta, { aiOverviewTriggered: true }),
  };
}
