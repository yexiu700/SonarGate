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
  extractStringQueries,
  isRecord,
  mergeCitations,
} from '../shared/parsing.js';

export type TongyiConfig = AppConfig['domestic']['tongyi'];

export class TongyiAdapter implements EngineAdapter {
  readonly engine = 'tongyi' as const;
  readonly region = 'domestic' as const;
  readonly provider = 'aliyun-dashscope';
  readonly model: string | undefined;

  constructor(
    private readonly config: TongyiConfig,
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
        enable_search: true,
        search_options: {
          enable_source: true,
          enable_citation: true,
          forced_search: true,
          search_strategy: this.config.searchStrategy,
        },
      },
      ctx,
      engine: this.engine,
      provider: this.provider,
    });

    const { choice, message, usage, id, model } = extractChatCompletionParts(data);
    const answerText = asString(message?.['content']) ?? '';

    const topSearchInfo = isRecord(data['search_info']) ? data['search_info'] : undefined;
    const choiceSearchInfo = isRecord(choice?.['search_info']) ? choice['search_info'] : undefined;
    const msgSearchInfo = isRecord(message?.['search_info']) ? message['search_info'] : undefined;

    const citations = mergeCitations(
      [
        topSearchInfo?.['search_results'],
        choiceSearchInfo?.['search_results'],
        msgSearchInfo?.['search_results'],
        data['citations'],
        message?.['annotations'],
      ],
      {
        fallbackSnippetToSiteName: true,
      },
    );

    const fanOutQueries = dedupeQueryStrings([
      ...extractStringQueries(topSearchInfo?.['search_queries']),
      ...extractStringQueries(choiceSearchInfo?.['search_queries']),
      ...extractStringQueries(msgSearchInfo?.['search_queries']),
      ...extractStringQueries(data['search_queries']),
      ...extractStringQueries(data['web_search_queries']),
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
