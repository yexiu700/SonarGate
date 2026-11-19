import type { AppConfig } from '../../config.js';
import { engineNotConfiguredError, upstreamBadResponseError } from '../../core/errors.js';
import type { HttpClient } from '../../core/http-client.js';
import type { AdapterResult, CollectContext, EngineAdapter } from '../../core/types.js';
import {
  asNonEmptyString,
  asNonNegativeInt,
  asString,
  dedupeQueryStrings,
  deepMergeRecords,
  extractChatCompletionParts,
  extractStringQueries,
  isRecord,
  mergeDomesticCitations,
  trimTrailingSlashes,
} from './helpers.js';

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

    const url = `${trimTrailingSlashes(this.config.baseUrl)}/chat/completions`;
    const baseBody: Record<string, unknown> = {
      model: this.config.model.trim(),
      messages: [{ role: 'user', content: ctx.prompt }],
      temperature: 0.2,
      stream: false,
    };
    const body = deepMergeRecords(baseBody, this.config.searchParams);

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
    const hasReasoning = asNonEmptyString(message?.['reasoning_content']) !== undefined;

    const citations = mergeDomesticCitations([
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
        hasReasoning,
      },
    };
  }
}
