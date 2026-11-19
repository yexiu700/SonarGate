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

    const url = `${trimTrailingSlashes(this.config.baseUrl)}/chat/completions`;
    const body = {
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
    const citations = extractDomesticCitations(data['web_search']);
    const fanOutQueries = extractSearchIntentQueries(data['search_intent']);

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
