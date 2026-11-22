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
  dedupeQueryStrings,
  deepMergeRecords,
  extractMessageText,
  extractStringQueries,
  extractToolCallSearchInfo,
  isRecord,
  mergeCitations,
  mergeRawCitationLists,
} from '../shared/parsing.js';

export type YuanbaoConfig = AppConfig['domestic']['yuanbao'];

function extractSearchInfoQueries(searchInfo: Record<string, unknown> | undefined): string[] {
  if (searchInfo === undefined) {
    return [];
  }
  const collected: string[] = [];
  for (const field of [
    'search_queries',
    'search_query',
    'web_search_queries',
    'queries',
    'keywords',
    'mindmap',
  ] as const) {
    collected.push(...extractStringQueries(searchInfo[field]));
  }
  return collected;
}

/**
 * Tencent Yuanbao (powered by Tencent Hunyuan + Sogou/WeChat search enhancement) adapter.
 * Uses the OpenAI-compatible Chat Completions endpoint (`https://api.hunyuan.cloud.tencent.com/v1`)
 * with `enable_enhancement`, `force_search_enhancement`, `citation`, and `search_info` enabled.
 */
export class YuanbaoAdapter implements EngineAdapter {
  readonly engine = 'yuanbao' as const;
  readonly region = 'domestic' as const;
  readonly provider = 'tencent-hunyuan';
  readonly model: string | undefined;

  constructor(
    private readonly config: YuanbaoConfig,
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
        enable_enhancement: true,
        force_search_enhancement: true,
        citation: true,
        search_info: true,
      },
      this.config.extraBody,
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
    const answerText = extractMessageText(message?.['content']);
    const hasReasoning = asNonEmptyString(message?.['reasoning_content']) !== undefined;

    const topSearchInfo = isRecord(data['search_info']) ? data['search_info'] : undefined;
    const choiceSearchInfo = isRecord(choice?.['search_info']) ? choice['search_info'] : undefined;
    const msgSearchInfo = isRecord(message?.['search_info']) ? message['search_info'] : undefined;
    const toolCallSearch = extractToolCallSearchInfo(message?.['tool_calls']);

    const mergedCitations = mergeCitations(
      [
        topSearchInfo?.['search_results'],
        choiceSearchInfo?.['search_results'],
        msgSearchInfo?.['search_results'],
        data['search_results'],
        data['citations'],
        data['references'],
        choice?.['citations'],
        choice?.['search_results'],
        message?.['annotations'],
        message?.['citations'],
        message?.['search_results'],
      ],
      {
        fallbackSnippetToSiteName: true,
      },
    );

    const citations = mergeRawCitationLists([mergedCitations, toolCallSearch.citations]);

    const fanOutQueries = dedupeQueryStrings([
      ...extractSearchInfoQueries(topSearchInfo),
      ...extractSearchInfoQueries(choiceSearchInfo),
      ...extractSearchInfoQueries(msgSearchInfo),
      ...extractStringQueries(data['search_queries']),
      ...extractStringQueries(data['web_search_queries']),
      ...extractStringQueries(data['fan_out_queries']),
      ...extractStringQueries(choice?.['search_queries']),
      ...extractStringQueries(message?.['search_queries']),
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
        ...(hasReasoning ? { extra: { hasReasoning: true } } : {}),
      }),
    };
  }
}
