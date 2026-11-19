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
  extractCitations,
  extractStringQueries,
  isRecord,
} from '../shared/parsing.js';

export type WenxinConfig = AppConfig['domestic']['wenxin'];

function extractTraceEntryQueries(entry: Record<string, unknown>): string[] {
  const collected: string[] = [];
  for (const field of ['query', 'keyword', 'keywords', 'queries', 'search_queries'] as const) {
    collected.push(...extractStringQueries(entry[field]));
  }
  return collected;
}

function extractSearchTraceQueries(searchTrace: unknown): string[] {
  if (typeof searchTrace === 'string') {
    return extractStringQueries(searchTrace);
  }
  if (Array.isArray(searchTrace)) {
    const collected: string[] = [];
    for (const item of searchTrace) {
      if (typeof item === 'string') {
        collected.push(item);
      } else if (isRecord(item)) {
        collected.push(...extractTraceEntryQueries(item));
      }
    }
    return collected;
  }
  if (isRecord(searchTrace)) {
    return extractTraceEntryQueries(searchTrace);
  }
  return [];
}

export class WenxinAdapter implements EngineAdapter {
  readonly engine = 'wenxin' as const;
  readonly region = 'domestic' as const;
  readonly provider = 'baidu-qianfan';
  readonly model: string | undefined;

  constructor(
    private readonly config: WenxinConfig,
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

    const data = await postChatCompletion({
      httpClient: this.httpClient,
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      body: {
        model: this.config.model.trim(),
        messages: [{ role: 'user', content: ctx.prompt }],
        temperature: 0.2,
        stream: false,
        web_search: {
          enable: true,
          enable_citation: true,
          enable_trace: true,
        },
      },
      ctx,
      engine: this.engine,
      provider: this.provider,
    });

    const { message, usage, id, model } = extractChatCompletionParts(data);
    const answerText = asString(message?.['content']) ?? '';
    const citations = extractCitations(data['search_results']);
    const fanOutQueries = dedupeQueryStrings([
      ...extractSearchTraceQueries(data['search_trace']),
      ...extractStringQueries(data['search_queries']),
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
      }),
    };
  }
}
