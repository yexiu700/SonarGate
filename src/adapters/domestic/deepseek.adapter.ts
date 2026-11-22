import type { AppConfig } from '../../config.js';
import { engineNotConfiguredError } from '../../core/errors.js';
import type { HttpClient } from '../../core/http-client.js';
import type { AdapterResult, CollectContext, EngineAdapter } from '../../core/types.js';
import {
  buildChatCompletionMeta,
  extractChatCompletionParts,
  postChatCompletion,
} from '../shared/chat-completions.js';
import {
  asNonEmptyString,
  asString,
  dedupeQueryStrings,
  deepMergeRecords,
  extractMessageText,
  extractStringQueries,
  extractToolCallSearchInfo,
  isRecord,
  mergeCitations,
  mergeRawCitationLists,
} from '../shared/parsing.js';

export type DeepSeekConfig = AppConfig['domestic']['deepseek'];

function extractNestedSearchQueries(value: unknown): string[] {
  if (typeof value === 'string') {
    return extractStringQueries(value);
  }
  if (Array.isArray(value)) {
    const collected: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        collected.push(item);
      } else if (isRecord(item)) {
        for (const field of [
          'query',
          'keyword',
          'keywords',
          'queries',
          'search_queries',
        ] as const) {
          collected.push(...extractStringQueries(item[field]));
        }
      }
    }
    return collected;
  }
  if (isRecord(value)) {
    const collected: string[] = [];
    for (const field of ['query', 'keyword', 'keywords', 'queries', 'search_queries'] as const) {
      collected.push(...extractStringQueries(value[field]));
    }
    return collected;
  }
  return [];
}

function extractArkOutputFallbacks(output: unknown): {
  text: string;
  citationSources: unknown[];
  queries: string[];
} {
  if (!Array.isArray(output)) {
    return { text: '', citationSources: [], queries: [] };
  }

  const textParts: string[] = [];
  const citationSources: unknown[] = [];
  const queries: string[] = [];

  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    const itemType = item['type'];
    if (itemType === 'message' && Array.isArray(item['content'])) {
      for (const block of item['content']) {
        if (!isRecord(block)) {
          continue;
        }
        const text = asString(block['text']);
        if (text !== undefined && text.length > 0) {
          textParts.push(text);
        }
        if (Array.isArray(block['annotations'])) {
          citationSources.push(block['annotations']);
        }
      }
    } else if (itemType === 'web_search_call') {
      const action = isRecord(item['action']) ? item['action'] : item;
      queries.push(
        ...extractStringQueries(action['query']),
        ...extractStringQueries(action['queries']),
        ...extractStringQueries(action['keywords']),
      );
      if (Array.isArray(action['sources'])) {
        citationSources.push(action['sources']);
      }
    }
  }

  return {
    text: textParts.join('\n'),
    citationSources,
    queries,
  };
}

export class DeepSeekAdapter implements EngineAdapter {
  readonly engine = 'deepseek' as const;
  readonly region = 'domestic' as const;
  readonly provider = 'deepseek';
  readonly model: string | undefined;

  constructor(
    private readonly config: DeepSeekConfig,
    private readonly httpClient: HttpClient,
  ) {
    this.model = asNonEmptyString(config.model);
  }

  isConfigured(): boolean {
    return this.config.apiKey.trim().length > 0 && this.config.model.trim().length > 0;
  }

  async collect(ctx: CollectContext): Promise<AdapterResult> {
    if (!this.isConfigured()) {
      throw engineNotConfiguredError(this.engine);
    }

    const body = deepMergeRecords(
      {
        model: this.config.model.trim(),
        messages: [{ role: 'user', content: ctx.prompt }],
        temperature: 0.2,
        stream: false,
      },
      this.config.searchParams,
    );

    const data = await postChatCompletion({
      httpClient: this.httpClient,
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      body,
      ctx,
      engine: this.engine,
      provider: this.provider,
    });

    const { choice, message, usage, id, model } = extractChatCompletionParts(data);
    const arkFallback = extractArkOutputFallbacks(data['output']);
    const msgText = extractMessageText(message?.['content']);
    const answerText =
      msgText.trim().length > 0
        ? msgText
        : arkFallback.text.trim().length > 0
          ? arkFallback.text
          : (asString(data['output_text']) ?? '');
    const hasReasoning = asNonEmptyString(message?.['reasoning_content']) !== undefined;

    const topSearchInfo = isRecord(data['search_info']) ? data['search_info'] : undefined;
    const choiceSearchInfo = isRecord(choice?.['search_info']) ? choice['search_info'] : undefined;
    const msgSearchInfo = isRecord(message?.['search_info']) ? message['search_info'] : undefined;
    const toolCallSearch = extractToolCallSearchInfo(message?.['tool_calls']);

    const mergedCitations = mergeCitations([
      data['citations'],
      data['search_results'],
      data['web_search'],
      data['references'],
      topSearchInfo?.['search_results'],
      choice?.['citations'],
      choice?.['search_results'],
      choice?.['references'],
      choice?.['annotations'],
      choiceSearchInfo?.['search_results'],
      message?.['annotations'],
      message?.['citations'],
      message?.['search_results'],
      message?.['references'],
      message?.['web_search'],
      msgSearchInfo?.['search_results'],
      ...arkFallback.citationSources,
    ]);

    const citations = mergeRawCitationLists([mergedCitations, toolCallSearch.citations]);

    const fanOutQueries = dedupeQueryStrings([
      ...extractStringQueries(data['search_queries']),
      ...extractStringQueries(data['web_search_queries']),
      ...extractStringQueries(data['fan_out_queries']),
      ...extractStringQueries(topSearchInfo?.['search_queries']),
      ...extractStringQueries(choice?.['search_queries']),
      ...extractStringQueries(choiceSearchInfo?.['search_queries']),
      ...extractStringQueries(message?.['search_queries']),
      ...extractStringQueries(message?.['web_search_queries']),
      ...extractStringQueries(msgSearchInfo?.['search_queries']),
      ...extractNestedSearchQueries(data['search_trace']),
      ...extractNestedSearchQueries(data['search_intent']),
      ...arkFallback.queries,
      ...toolCallSearch.queries,
    ]);

    return {
      answerText,
      citations,
      fanOutQueries,
      rawMeta: buildChatCompletionMeta({
        provider: this.provider,
        responseModel: model,
        fallbackModel: this.model,
        upstreamRequestId: id,
        usage,
        extra: { hasReasoning },
      }),
    };
  }
}
