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
  extractDomesticCitations,
  extractStringQueries,
  isRecord,
  trimTrailingSlashes,
} from './helpers.js';

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

    const url = `${trimTrailingSlashes(this.config.baseUrl)}/chat/completions`;
    const body = {
      model: this.config.model.trim(),
      messages: [{ role: 'user', content: ctx.prompt }],
      temperature: 0.2,
      stream: false,
      web_search: {
        enable: true,
        enable_citation: true,
        enable_trace: true,
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
    const citations = extractDomesticCitations(data['search_results']);
    const fanOutQueries = dedupeQueryStrings([
      ...extractSearchTraceQueries(data['search_trace']),
      ...extractStringQueries(data['search_queries']),
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
