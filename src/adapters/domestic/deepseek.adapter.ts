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
  extractStringQueries,
  mergeCitations,
} from '../shared/parsing.js';

export type DeepSeekConfig = AppConfig['domestic']['deepseek'];

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

    const { message, usage, id, model } = extractChatCompletionParts(data);
    const answerText = asString(message?.['content']) ?? '';
    const hasReasoning = asNonEmptyString(message?.['reasoning_content']) !== undefined;

    const citations = mergeCitations([
      data['citations'],
      data['search_results'],
      data['web_search'],
      message?.['annotations'],
      message?.['search_results'],
    ]);

    const fanOutQueries = dedupeQueryStrings([
      ...extractStringQueries(data['search_queries']),
      ...extractStringQueries(data['web_search_queries']),
      ...extractStringQueries(message?.['search_queries']),
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
