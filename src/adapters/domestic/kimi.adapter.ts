import type { AppConfig } from '../../config.js';
import {
  engineNotConfiguredError,
  upstreamBadResponseError,
  upstreamTimeoutError,
} from '../../core/errors.js';
import type { HttpClient } from '../../core/http-client.js';
import type {
  AdapterResult,
  CollectContext,
  EngineAdapter,
  RawCitation,
} from '../../core/types.js';
import {
  buildChatCompletionMeta,
  extractChatCompletionParts,
  postChatCompletion,
} from '../shared/chat-completions.js';
import {
  asNonEmptyString,
  asNonNegativeInt,
  dedupeQueryStrings,
  deepMergeRecords,
  extractMessageText,
  extractStringQueries,
  extractToolCallSearchInfo,
  isRecord,
  mergeCitations,
  mergeRawCitationLists,
} from '../shared/parsing.js';

export type KimiConfig = AppConfig['domestic']['kimi'];

const DEFAULT_MAX_SEARCH_ROUNDS = 3;

interface ExtractedToolCall {
  id: string;
  name: string;
  rawArguments: string;
}

function parseToolCallsForEcho(rawToolCalls: unknown): ExtractedToolCall[] {
  if (!Array.isArray(rawToolCalls)) {
    return [];
  }

  const result: ExtractedToolCall[] = [];
  for (const entry of rawToolCalls) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = asNonEmptyString(entry['id']);
    const fn = isRecord(entry['function']) ? entry['function'] : undefined;
    const name = asNonEmptyString(fn?.['name']) ?? asNonEmptyString(entry['name']);
    if (id === undefined || name === undefined) {
      continue;
    }

    const args = fn?.['arguments'] ?? entry['arguments'];
    const rawArguments =
      typeof args === 'string' ? args : args !== undefined ? JSON.stringify(args) : '{}';
    result.push({ id, name, rawArguments });
  }
  return result;
}

/**
 * Moonshot AI Kimi adapter.
 * Supports both Moonshot's native multi-round `builtin_function` `$web_search` tool-call
 * echo protocol and single-turn OpenAI-compatible relays.
 */
export class KimiAdapter implements EngineAdapter {
  readonly engine = 'kimi' as const;
  readonly region = 'domestic' as const;
  readonly provider = 'moonshot-kimi';
  readonly model: string | undefined;

  constructor(
    private readonly config: KimiConfig,
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

    const maxRounds = Math.max(1, this.config.maxSearchRounds ?? DEFAULT_MAX_SEARCH_ROUNDS);
    const deadlineMs = Date.now() + ctx.timeoutMs;
    const messages: Record<string, unknown>[] = [{ role: 'user', content: ctx.prompt }];

    const collectedCitations: RawCitation[][] = [];
    const collectedQueries: string[] = [];
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let hasTokensIn = false;
    let hasTokensOut = false;
    let hasReasoning = false;
    let finalAnswerText = '';
    let finalModel: string | undefined;
    let finalUpstreamRequestId: string | undefined;
    let searchRounds = 0;

    for (let round = 1; round <= maxRounds; round += 1) {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0 || ctx.signal.aborted) {
        throw upstreamTimeoutError('Kimi web search exceeded attempt timeout budget', {
          engine: this.engine,
          retryable: !ctx.signal.aborted,
        });
      }

      const body = deepMergeRecords(
        {
          model: this.config.model.trim(),
          messages,
          temperature: 0.3,
          stream: false,
          tools: [
            {
              type: 'builtin_function',
              function: {
                name: '$web_search',
              },
            },
          ],
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
        timeoutMs: remainingMs,
      });

      const { choice, message, finishReason, usage, id, model } = extractChatCompletionParts(data);
      if (id !== undefined) {
        finalUpstreamRequestId = id;
      }
      if (model !== undefined) {
        finalModel = model;
      }

      const promptTokens = asNonNegativeInt(usage?.['prompt_tokens']);
      const completionTokens = asNonNegativeInt(usage?.['completion_tokens']);
      if (promptTokens !== undefined) {
        totalTokensIn += promptTokens;
        hasTokensIn = true;
      }
      if (completionTokens !== undefined) {
        totalTokensOut += completionTokens;
        hasTokensOut = true;
      }

      if (asNonEmptyString(message?.['reasoning_content']) !== undefined) {
        hasReasoning = true;
      }

      const topSearchInfo = isRecord(data['search_info']) ? data['search_info'] : undefined;
      const choiceSearchInfo = isRecord(choice?.['search_info'])
        ? choice['search_info']
        : undefined;
      const msgSearchInfo = isRecord(message?.['search_info']) ? message['search_info'] : undefined;
      const toolCallSearch = extractToolCallSearchInfo(message?.['tool_calls']);

      const roundCitations = mergeCitations([
        topSearchInfo?.['search_results'],
        choiceSearchInfo?.['search_results'],
        msgSearchInfo?.['search_results'],
        data['search_results'],
        data['citations'],
        data['references'],
        data['web_search'],
        choice?.['citations'],
        choice?.['search_results'],
        message?.['annotations'],
        message?.['citations'],
        message?.['search_results'],
      ]);
      if (roundCitations.length > 0) {
        collectedCitations.push(roundCitations);
      }
      if (toolCallSearch.citations.length > 0) {
        collectedCitations.push(toolCallSearch.citations);
      }

      collectedQueries.push(
        ...extractStringQueries(data['search_queries']),
        ...extractStringQueries(data['web_search_queries']),
        ...extractStringQueries(data['fan_out_queries']),
        ...extractStringQueries(topSearchInfo?.['search_queries']),
        ...extractStringQueries(choiceSearchInfo?.['search_queries']),
        ...extractStringQueries(msgSearchInfo?.['search_queries']),
        ...extractStringQueries(choice?.['search_queries']),
        ...extractStringQueries(message?.['search_queries']),
        ...toolCallSearch.queries,
      );

      const roundText = extractMessageText(message?.['content']);
      const toolCalls = parseToolCallsForEcho(message?.['tool_calls']);

      if (finishReason === 'tool_calls' && toolCalls.length > 0 && message !== undefined) {
        searchRounds += 1;
        if (round >= maxRounds) {
          if (roundText.trim().length > 0) {
            finalAnswerText = roundText;
            break;
          }
          throw upstreamBadResponseError(
            `Kimi web search exceeded maximum ${maxRounds} tool-call rounds without final answer`,
            {
              engine: this.engine,
              retryable: true,
            },
          );
        }

        // Follow Moonshot $web_search contract: append assistant tool_calls message
        // and echo each tool call's arguments verbatim in a role:"tool" message.
        messages.push({
          role: 'assistant',
          content: message['content'] ?? '',
          tool_calls: message['tool_calls'],
        });
        for (const tc of toolCalls) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.name,
            content: tc.rawArguments,
          });
        }
        continue;
      }

      finalAnswerText = roundText;
      break;
    }

    const citations = mergeRawCitationLists(collectedCitations);
    const fanOutQueries = dedupeQueryStrings(collectedQueries);

    return {
      answerText: finalAnswerText,
      citations,
      fanOutQueries,
      rawMeta: {
        ...buildChatCompletionMeta({
          provider: this.provider,
          responseModel: finalModel,
          fallbackModel: this.model,
          upstreamRequestId: finalUpstreamRequestId,
          extra: {
            ...(hasReasoning ? { hasReasoning: true } : {}),
            ...(searchRounds > 0 ? { searchRounds } : {}),
          },
        }),
        ...(hasTokensIn ? { tokensIn: totalTokensIn } : {}),
        ...(hasTokensOut ? { tokensOut: totalTokensOut } : {}),
      },
    };
  }
}
