import type { AppConfig } from '../../config.js';
import { engineNotConfiguredError, upstreamBadResponseError } from '../../core/errors.js';
import type { HttpClient } from '../../core/http-client.js';
import type { AdapterResult, CollectContext, EngineAdapter } from '../../core/types.js';
import {
  asNonEmptyString,
  asNonNegativeInt,
  asString,
  dedupeQueryStrings,
  extractChatCompletionParts,
  extractStringQueries,
  isRecord,
  mergeDomesticCitations,
  trimTrailingSlashes,
} from './helpers.js';

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

    const url = `${trimTrailingSlashes(this.config.baseUrl)}/chat/completions`;
    const body = {
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
    };

    const response = await this.httpClient.postJson<unknown>(url, body, {
      headers: {
        Authorization: `Bearer ${this.config.apiKey.trim()}`,
      },
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      engine: this.engine,
      provider: this.provider,
      requestId: ctx.requestId,
    });

    const data = response.data;
    if (!isRecord(data)) {
      throw upstreamBadResponseError('Upstream returned non-object JSON payload', {
        engine: this.engine,
        retryable: true,
      });
    }

    const { message, usage, id, model } = extractChatCompletionParts(data);
    const answerText = asString(message?.['content']) ?? '';

    const topSearchInfo = isRecord(data['search_info']) ? data['search_info'] : undefined;
    const msgSearchInfo = isRecord(message?.['search_info']) ? message['search_info'] : undefined;

    const citations = mergeDomesticCitations(
      [topSearchInfo?.['search_results'], msgSearchInfo?.['search_results']],
      {
        fallbackSnippetToSiteName: true,
      },
    );

    const fanOutQueries = dedupeQueryStrings([
      ...extractStringQueries(topSearchInfo?.['search_queries']),
      ...extractStringQueries(msgSearchInfo?.['search_queries']),
    ]);

    const responseModel = model ?? this.model;
    const tokensIn = asNonNegativeInt(usage?.['prompt_tokens']);
    const tokensOut = asNonNegativeInt(usage?.['completion_tokens']);

    return {
      answerText,
      citations,
      fanOutQueries,
      rawMeta: {
        provider: this.provider,
        ...(responseModel !== undefined ? { model: responseModel } : {}),
        ...(id !== undefined ? { upstreamRequestId: id } : {}),
        ...(tokensIn !== undefined ? { tokensIn } : {}),
        ...(tokensOut !== undefined ? { tokensOut } : {}),
      },
    };
  }
}
