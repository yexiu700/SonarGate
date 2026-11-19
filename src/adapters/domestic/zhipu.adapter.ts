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

export type ZhipuConfig = AppConfig['domestic']['zhipu'];

function extractSearchIntentQueries(searchIntent: unknown): string[] {
  if (!Array.isArray(searchIntent)) {
    return [];
  }

  const collected: string[] = [];
  for (const item of searchIntent) {
    if (typeof item === 'string') {
      collected.push(item);
      continue;
    }
    if (!isRecord(item)) {
      continue;
    }
    collected.push(...extractStringQueries(item['keywords']));
    const query = asNonEmptyString(item['query']);
    if (query !== undefined) {
      collected.push(query);
    }
  }

  return dedupeQueryStrings(collected);
}

export class ZhipuAdapter implements EngineAdapter {
  readonly engine = 'zhipu' as const;
  readonly region = 'domestic' as const;
  readonly provider = 'zhipu-bigmodel';
  readonly model: string | undefined;

  constructor(
    private readonly config: ZhipuConfig,
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
        tools: [
          {
            type: 'web_search',
            web_search: {
              enable: true,
              search_engine: this.config.searchEngine,
              search_result: true,
              count: '10',
              search_intent: false,
            },
          },
        ],
      },
      ctx,
      engine: this.engine,
      provider: this.provider,
    });

    const { message, usage, id, model } = extractChatCompletionParts(data);
    const answerText = asString(message?.['content']) ?? '';
    const citations = extractCitations(data['web_search']);
    const fanOutQueries = extractSearchIntentQueries(data['search_intent']);

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
