import type { AdapterResult, RawCitation } from '../../core/types.js';
import {
  asNonEmptyString,
  dedupeQueryStrings,
  extractStringQueries,
  isRecord,
} from '../shared/parsing.js';

export const NO_AI_OVERVIEW_TEXT = '[NO_AI_OVERVIEW] 该查询未触发 Google AI Overview。';

export interface DataForSeoParseMeta {
  costUsd?: number | undefined;
  upstreamRequestId?: string | undefined;
  fallbackModel?: string | undefined;
}

const DEFAULT_SNIPPET_KEYS = [
  'snippet',
  'description',
  'text',
  'content',
  'cited_text',
  'summary',
] as const;
const AIO_SNIPPET_KEYS = ['text', 'snippet', 'description', 'content'] as const;

function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.trunc(value);
}

function firstStringField(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
): string | undefined {
  for (const obj of records) {
    for (const key of keys) {
      const val = asNonEmptyString(obj[key]);
      if (val !== undefined) {
        return val;
      }
    }
  }
  return undefined;
}

function unwrapCitationRecords(entry: Record<string, unknown>): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const key of ['url_citation', 'web', 'source'] as const) {
    const nested = entry[key];
    if (isRecord(nested)) {
      records.push(nested);
    }
  }
  records.push(entry);
  return records;
}

function extractCitations(
  lists: readonly unknown[],
  snippetKeys: readonly string[] = DEFAULT_SNIPPET_KEYS,
): RawCitation[] {
  const byUrl = new Map<string, RawCitation>();
  const citations: RawCitation[] = [];

  const upsert = (incoming: RawCitation): void => {
    const existing = byUrl.get(incoming.url);
    if (existing !== undefined) {
      if (existing.title === undefined && incoming.title !== undefined) {
        existing.title = incoming.title;
      }
      if (existing.snippet === undefined && incoming.snippet !== undefined) {
        existing.snippet = incoming.snippet;
      }
      return;
    }
    byUrl.set(incoming.url, incoming);
    citations.push(incoming);
  };

  for (const list of lists) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entry of list) {
      if (typeof entry === 'string') {
        const url = asNonEmptyString(entry);
        if (url !== undefined) {
          upsert({ url });
        }
        continue;
      }
      if (!isRecord(entry)) {
        continue;
      }
      const records = unwrapCitationRecords(entry);
      const url = firstStringField(records, ['url', 'uri', 'link', 'href', 'source_url']);
      if (url === undefined) {
        continue;
      }

      const title = firstStringField(records, [
        'title',
        'name',
        'source_name',
        'site_name',
        'domain',
      ]);
      const snippet = firstStringField(records, snippetKeys);

      upsert({
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
    for (const field of [
      'annotations',
      'sources',
      'search_results',
      'citations',
      'references',
    ] as const) {
      if (Array.isArray(item[field])) {
        collected.push(...item[field]);
      }
    }
    if (Array.isArray(item['sections'])) {
      for (const section of item['sections']) {
        if (!isRecord(section)) {
          continue;
        }
        for (const field of [
          'annotations',
          'sources',
          'citations',
          'references',
          'search_results',
        ] as const) {
          if (Array.isArray(section[field])) {
            collected.push(...section[field]);
          }
        }
      }
    }
  }
  return collected;
}

function collectQueriesFromItems(items: unknown): string[] {
  if (!Array.isArray(items)) {
    return [];
  }

  const collected: string[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    for (const field of [
      'fan_out_queries',
      'search_queries',
      'web_search_queries',
      'queries',
      'query',
    ] as const) {
      collected.push(...extractStringQueries(item[field]));
    }
    if (isRecord(item['action'])) {
      collected.push(
        ...extractStringQueries(item['action']['query']),
        ...extractStringQueries(item['action']['queries']),
      );
    }
    if (Array.isArray(item['sections'])) {
      for (const section of item['sections']) {
        if (!isRecord(section)) {
          continue;
        }
        collected.push(
          ...extractStringQueries(section['search_queries']),
          ...extractStringQueries(section['web_search_queries']),
          ...extractStringQueries(section['fan_out_queries']),
        );
      }
    }
  }

  return collected;
}

function extractGroundingMetadataFromResult(result: Record<string, unknown>): {
  citations: unknown[];
  queries: string[];
} {
  const grounding = isRecord(result['grounding_metadata'])
    ? result['grounding_metadata']
    : isRecord(result['groundingMetadata'])
      ? result['groundingMetadata']
      : undefined;

  if (grounding === undefined) {
    return { citations: [], queries: [] };
  }

  const citations: unknown[] = [];
  for (const field of ['grounding_chunks', 'groundingChunks'] as const) {
    if (Array.isArray(grounding[field])) {
      citations.push(...grounding[field]);
    }
  }

  const queries = [
    ...extractStringQueries(grounding['web_search_queries']),
    ...extractStringQueries(grounding['webSearchQueries']),
    ...extractStringQueries(grounding['search_queries']),
    ...extractStringQueries(grounding['searchQueries']),
  ];

  return { citations, queries };
}

function extractFanOutQueries(...lists: readonly unknown[]): string[] {
  const raw: string[] = [];

  for (const list of lists) {
    if (typeof list === 'string') {
      raw.push(list);
      continue;
    }
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entry of list) {
      if (typeof entry === 'string') {
        raw.push(entry);
      } else if (isRecord(entry)) {
        const text =
          asNonEmptyString(entry['query']) ??
          asNonEmptyString(entry['keyword']) ??
          asNonEmptyString(entry['title']);
        if (text !== undefined) {
          raw.push(text);
        }
      }
    }
  }

  return dedupeQueryStrings(raw);
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
    result['citations'],
    result['references'],
    itemAnnotations,
  ]);

  const fanOutQueries = extractFanOutQueries(
    result['fan_out_queries'],
    result['search_queries'],
    result['web_search_queries'],
    result['queries'],
    collectQueriesFromItems(result['items']),
  );

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
  const grounding = extractGroundingMetadataFromResult(result);
  const citations = extractCitations([
    itemAnnotations,
    result['sources'],
    result['search_results'],
    result['citations'],
    result['references'],
    result['annotations'],
    grounding.citations,
  ]);

  const fanOutQueries = extractFanOutQueries(
    result['fan_out_queries'],
    result['search_queries'],
    result['web_search_queries'],
    result['related_questions'],
    result['queries'],
    grounding.queries,
    collectQueriesFromItems(result['items']),
  );

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
  const grounding = extractGroundingMetadataFromResult(result);
  const citations = extractCitations([
    result['sources'],
    result['search_results'],
    result['citations'],
    result['references'],
    itemAnnotations,
    grounding.citations,
  ]);

  const fanOutQueries = extractFanOutQueries(
    result['fan_out_queries'],
    result['search_queries'],
    result['web_search_queries'],
    result['queries'],
    grounding.queries,
    collectQueriesFromItems(result['items']),
  );

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
  for (const field of ['references', 'sources', 'annotations', 'links'] as const) {
    if (Array.isArray(node[field])) {
      lists.push(node[field]);
    }
  }
  if (Array.isArray(node['items'])) {
    for (const child of node['items']) {
      if (isRecord(child)) {
        collectAioReferenceLists(child, lists);
      }
    }
  }
}

function collectSerpRelatedQueries(items: readonly unknown[]): string[] {
  const collected: string[] = [];
  for (const entry of items) {
    if (!isRecord(entry)) {
      continue;
    }
    const itemType = entry['type'];
    if (itemType === 'related_searches' && Array.isArray(entry['items'])) {
      collected.push(...extractStringQueries(entry['items']));
    } else if (itemType === 'people_also_ask' && Array.isArray(entry['items'])) {
      for (const paa of entry['items']) {
        if (typeof paa === 'string') {
          collected.push(paa);
        } else if (isRecord(paa)) {
          const title = asNonEmptyString(paa['title']) ?? asNonEmptyString(paa['question']);
          if (title !== undefined) {
            collected.push(title);
          }
        }
      }
    }
  }
  return collected;
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

  const fanOutQueries = extractFanOutQueries(
    aioItem['fan_out_queries'],
    aioItem['search_queries'],
    aioItem['web_search_queries'],
    result['fan_out_queries'],
    result['search_queries'],
    result['web_search_queries'],
    collectSerpRelatedQueries(items),
  );

  return {
    answerText,
    citations,
    fanOutQueries,
    rawMeta: buildRawMeta(meta, { aiOverviewTriggered: true }),
  };
}
