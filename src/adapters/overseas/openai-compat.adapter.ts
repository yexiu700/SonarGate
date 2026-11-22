import type { OverseasEngineOpenAiConfig } from '../../config.js';
import type { OverseasEngine } from '../../core/contract.js';
import { engineNotConfiguredError } from '../../core/errors.js';
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
  asString,
  dedupeQueryStrings,
  deepMergeRecords,
  extractMessageText,
  extractStringQueries,
  extractToolCallSearchInfo,
  isRecord,
  mergeCitations,
  mergeRawCitationLists,
} from '../shared/parsing.js';

function extractAnswerFromResponsesOutput(output: unknown): {
  text: string;
  citations: RawCitation[];
  queries: string[];
} {
  if (!Array.isArray(output)) {
    return { text: '', citations: [], queries: [] };
  }

  const textParts: string[] = [];
  const citationSources: unknown[] = [];
  const queries: string[] = [];

  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    const itemType = item['type'];
    if (itemType === 'message' && Array.isArray(item['content'])) {
      for (const block of item['content']) {
        if (!isRecord(block)) {
          continue;
        }
        const text = asString(block['text']);
        if (text !== undefined && text.length > 0) {
          textParts.push(text);
        }
        if (Array.isArray(block['annotations'])) {
          citationSources.push(block['annotations']);
        }
        if (Array.isArray(block['citations'])) {
          citationSources.push(block['citations']);
        }
      }
    } else if (itemType === 'web_search_call') {
      const action = isRecord(item['action']) ? item['action'] : item;
      queries.push(
        ...extractStringQueries(action['query']),
        ...extractStringQueries(action['queries']),
        ...extractStringQueries(action['keywords']),
      );
      if (Array.isArray(action['sources'])) {
        citationSources.push(action['sources']);
      }
    }
  }

  return {
    text: textParts.join('\n'),
    citations: mergeCitations(citationSources),
    queries: dedupeQueryStrings(queries),
  };
}

function extractAnthropicContentBlocks(content: unknown): {
  text: string;
  citations: RawCitation[];
  queries: string[];
} {
  if (!Array.isArray(content)) {
    return { text: '', citations: [], queries: [] };
  }

  const textParts: string[] = [];
  const citationSources: unknown[] = [];
  const queries: string[] = [];

  for (const block of content) {
    if (typeof block === 'string') {
      textParts.push(block);
      continue;
    }
    if (!isRecord(block)) {
      continue;
    }

    const blockType = asNonEmptyString(block['type']);
    if (blockType === 'thinking' || blockType === 'reasoning') {
      continue;
    }

    if (blockType === 'server_tool_use' || blockType === 'tool_use') {
      const name = (asNonEmptyString(block['name']) ?? '').toLowerCase();
      if ((name.includes('search') || name.includes('web')) && isRecord(block['input'])) {
        queries.push(
          ...extractStringQueries(block['input']['query']),
          ...extractStringQueries(block['input']['queries']),
        );
      }
      continue;
    }

    if (blockType === 'web_search_tool_result' && Array.isArray(block['content'])) {
      citationSources.push(block['content']);
      continue;
    }

    const text = asString(block['text']) ?? asString(block['content']);
    if (text !== undefined && text.length > 0) {
      textParts.push(text);
    }
    if (Array.isArray(block['citations'])) {
      citationSources.push(block['citations']);
    }
    if (Array.isArray(block['annotations'])) {
      citationSources.push(block['annotations']);
    }
  }

  return {
    text: textParts.join('\n'),
    citations: mergeCitations(citationSources),
    queries: dedupeQueryStrings(queries),
  };
}

function extractGeminiCandidatesText(data: Record<string, unknown>): string {
  const candidates = data['candidates'];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return '';
  }
  const first = candidates[0];
  if (
    !isRecord(first) ||
    !isRecord(first['content']) ||
    !Array.isArray(first['content']['parts'])
  ) {
    return '';
  }

  const parts: string[] = [];
  for (const part of first['content']['parts']) {
    if (isRecord(part)) {
      const text = asString(part['text']);
      if (text !== undefined && text.length > 0) {
        parts.push(text);
      }
    }
  }
  return parts.join('\n');
}

function collectGroundingCandidates(
  data: Record<string, unknown>,
  choice: Record<string, unknown> | undefined,
  message: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  const containers: unknown[] = [
    data,
    isRecord(data['metadata']) ? data['metadata'] : undefined,
    isRecord(data['provider_specific_fields']) ? data['provider_specific_fields'] : undefined,
    choice,
    isRecord(choice?.['provider_specific_fields']) ? choice['provider_specific_fields'] : undefined,
    message,
    isRecord(message?.['metadata']) ? message['metadata'] : undefined,
    isRecord(message?.['provider_specific_fields'])
      ? message['provider_specific_fields']
      : undefined,
  ];

  const geminiCandidates = data['candidates'];
  if (Array.isArray(geminiCandidates) && geminiCandidates.length > 0) {
    containers.push(geminiCandidates[0]);
  }

  const groundingObjects: Record<string, unknown>[] = [];
  for (const container of containers) {
    if (!isRecord(container)) {
      continue;
    }
    for (const key of [
      'grounding_metadata',
      'groundingMetadata',
      'vertex_ai_grounding_metadata',
    ] as const) {
      const value = container[key];
      if (isRecord(value)) {
        groundingObjects.push(value);
      } else if (Array.isArray(value)) {
        for (const entry of value) {
          if (isRecord(entry)) {
            groundingObjects.push(entry);
          }
        }
      }
    }
  }

  return groundingObjects;
}

function extractGroundingMetadata(
  data: Record<string, unknown>,
  choice: Record<string, unknown> | undefined,
  message: Record<string, unknown> | undefined,
): { citations: RawCitation[]; queries: string[] } {
  const candidates = collectGroundingCandidates(data, choice, message);
  const citations: RawCitation[] = [];
  const queries: string[] = [];

  for (const candidate of candidates) {
    queries.push(
      ...extractStringQueries(candidate['web_search_queries']),
      ...extractStringQueries(candidate['webSearchQueries']),
      ...extractStringQueries(candidate['search_queries']),
      ...extractStringQueries(candidate['searchQueries']),
      ...extractStringQueries(candidate['fan_out_queries']),
      ...extractStringQueries(candidate['fanOutQueries']),
    );

    // Map groundingSupports segment text -> chunk index so chunks gain grounded snippets
    const snippetByChunkIdx = new Map<number, string>();
    const supports = candidate['grounding_supports'] ?? candidate['groundingSupports'];
    if (Array.isArray(supports)) {
      for (const support of supports) {
        if (!isRecord(support)) {
          continue;
        }
        const segment = isRecord(support['segment']) ? support['segment'] : undefined;
        const segmentText = asNonEmptyString(segment?.['text']);
        const indices = support['grounding_chunk_indices'] ?? support['groundingChunkIndices'];
        if (segmentText !== undefined && Array.isArray(indices)) {
          for (const idx of indices) {
            if (typeof idx === 'number' && Number.isInteger(idx) && !snippetByChunkIdx.has(idx)) {
              snippetByChunkIdx.set(idx, segmentText);
            }
          }
        }
      }
    }

    const chunks = candidate['grounding_chunks'] ?? candidate['groundingChunks'];
    if (Array.isArray(chunks)) {
      chunks.forEach((chunk, idx) => {
        if (!isRecord(chunk)) {
          return;
        }
        const web = isRecord(chunk['web'])
          ? chunk['web']
          : isRecord(chunk['retrievedContext'])
            ? chunk['retrievedContext']
            : isRecord(chunk['retrieved_context'])
              ? chunk['retrieved_context']
              : chunk;
        const url = asNonEmptyString(web['uri']) ?? asNonEmptyString(web['url']);
        if (url === undefined) {
          return;
        }
        const title = asNonEmptyString(web['title']);
        const snippet =
          asNonEmptyString(web['snippet']) ??
          asNonEmptyString(web['text']) ??
          snippetByChunkIdx.get(idx);
        citations.push({
          url,
          ...(title !== undefined ? { title } : {}),
          ...(snippet !== undefined ? { snippet } : {}),
        });
      });
    }
  }

  return {
    citations: mergeRawCitationLists([citations]),
    queries: dedupeQueryStrings(queries),
  };
}

function buildEngineSearchDefaults(
  engine: OverseasEngine,
  ctx: CollectContext,
): Record<string, unknown> {
  const region = ctx.region;

  if (engine === 'perplexity') {
    return {
      return_related_questions: true,
      ...(region !== undefined
        ? {
            web_search_options: {
              user_location: {
                country: region,
              },
            },
          }
        : {}),
    };
  }

  if (region !== undefined) {
    return {
      web_search_options: {
        user_location: {
          type: 'approximate',
          approximate: {
            country: region,
          },
        },
      },
    };
  }

  return {};
}

function stripNullTopLevelKeys(body: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value !== null) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

/**
 * Generic OpenAI-compatible relay adapter for overseas engines (NewAPI, SubAPI, OneAPI, OpenRouter, etc.).
 *
 * TODO: When used for `google_aio`, this currently acts as a Gemini openai_compat placeholder.
 * Replace with a dedicated SERP/AI Overview provider (e.g. SerpApi/Serper) when needed outside DataForSEO.
 */
export class OpenAiCompatOverseasAdapter implements EngineAdapter {
  readonly engine: OverseasEngine;
  readonly region = 'overseas' as const;
  readonly provider = 'openai_compat';
  readonly model: string | undefined;

  constructor(
    engine: OverseasEngine,
    private readonly config: OverseasEngineOpenAiConfig,
    private readonly httpClient: HttpClient,
  ) {
    this.engine = engine;
    this.model = asNonEmptyString(config.model);
  }

  isConfigured(): boolean {
    return (
      this.config.baseUrl.trim().length > 0 &&
      this.config.apiKey.trim().length > 0 &&
      this.config.model.trim().length > 0
    );
  }

  async collect(ctx: CollectContext): Promise<AdapterResult> {
    if (!this.isConfigured()) {
      throw engineNotConfiguredError(this.engine);
    }

    const baseBody: Record<string, unknown> = {
      model: this.config.model.trim(),
      messages: [{ role: 'user', content: ctx.prompt }],
      temperature: 0.2,
      stream: false,
      ...buildEngineSearchDefaults(this.engine, ctx),
    };

    const body = stripNullTopLevelKeys(deepMergeRecords(baseBody, this.config.extraBody));

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

    const responsesOutput = extractAnswerFromResponsesOutput(data['output']);
    const msgBlocks = extractAnthropicContentBlocks(message?.['content']);
    const topBlocks = extractAnthropicContentBlocks(data['content']);

    const directMessageText = extractMessageText(message?.['content']);
    const answerText =
      directMessageText.trim().length > 0
        ? directMessageText
        : msgBlocks.text.trim().length > 0
          ? msgBlocks.text
          : responsesOutput.text.trim().length > 0
            ? responsesOutput.text
            : topBlocks.text.trim().length > 0
              ? topBlocks.text
              : (asString(data['output_text']) ?? extractGeminiCandidatesText(data));

    const grounding = extractGroundingMetadata(data, choice, message);
    const toolCallSearch = extractToolCallSearchInfo(message?.['tool_calls']);

    const dataMeta = isRecord(data['metadata']) ? data['metadata'] : undefined;
    const perplexityMeta = isRecord(dataMeta?.['perplexity']) ? dataMeta['perplexity'] : undefined;
    const dataPsf = isRecord(data['provider_specific_fields'])
      ? data['provider_specific_fields']
      : undefined;
    const choicePsf = isRecord(choice?.['provider_specific_fields'])
      ? choice['provider_specific_fields']
      : undefined;
    const topSearchInfo = isRecord(data['search_info']) ? data['search_info'] : undefined;
    const msgSearchInfo = isRecord(message?.['search_info']) ? message['search_info'] : undefined;

    // Order structured rich sources (annotations / search_results / sources / grounding) alongside bare citations[]
    // so mergeCitations preserves order AND enriches bare URLs with titles/snippets when available.
    const richAndGenericCitations = mergeCitations([
      message?.['annotations'],
      choice?.['annotations'],
      data['annotations'],
      data['search_results'],
      message?.['search_results'],
      choice?.['search_results'],
      perplexityMeta?.['search_results'],
      dataMeta?.['search_results'],
      dataPsf?.['search_results'],
      choicePsf?.['search_results'],
      topSearchInfo?.['search_results'],
      msgSearchInfo?.['search_results'],
      data['sources'],
      message?.['sources'],
      data['references'],
      message?.['references'],
      data['web_search'],
      data['citations'],
      message?.['citations'],
      choice?.['citations'],
      perplexityMeta?.['citations'],
      dataMeta?.['citations'],
      dataPsf?.['citations'],
      choicePsf?.['citations'],
    ]);

    const citations = mergeRawCitationLists([
      richAndGenericCitations,
      grounding.citations,
      responsesOutput.citations,
      msgBlocks.citations,
      topBlocks.citations,
      toolCallSearch.citations,
    ]);

    const fanOutQueries = dedupeQueryStrings([
      ...extractStringQueries(data['fan_out_queries']),
      ...extractStringQueries(data['search_queries']),
      ...extractStringQueries(data['web_search_queries']),
      ...extractStringQueries(data['related_questions']),
      ...extractStringQueries(choice?.['search_queries']),
      ...extractStringQueries(choice?.['related_questions']),
      ...extractStringQueries(message?.['search_queries']),
      ...extractStringQueries(message?.['web_search_queries']),
      ...extractStringQueries(message?.['related_questions']),
      ...extractStringQueries(topSearchInfo?.['search_queries']),
      ...extractStringQueries(msgSearchInfo?.['search_queries']),
      ...extractStringQueries(perplexityMeta?.['search_queries']),
      ...extractStringQueries(perplexityMeta?.['related_questions']),
      ...grounding.queries,
      ...responsesOutput.queries,
      ...msgBlocks.queries,
      ...topBlocks.queries,
      ...toolCallSearch.queries,
    ]);

    const tokensIn =
      asNonNegativeInt(usage?.['prompt_tokens']) ?? asNonNegativeInt(usage?.['input_tokens']);
    const tokensOut =
      asNonNegativeInt(usage?.['completion_tokens']) ?? asNonNegativeInt(usage?.['output_tokens']);

    return {
      answerText,
      citations,
      fanOutQueries,
      rawMeta: {
        ...buildChatCompletionMeta({
          provider: this.provider,
          responseModel: model,
          fallbackModel: this.model,
          upstreamRequestId: id,
          usage,
          // TODO: Remove placeholder marker once google_aio has a dedicated non-DataForSEO SERP/AIO adapter.
          ...(this.engine === 'google_aio'
            ? { extra: { placeholder: 'gemini_openai_compat' } }
            : {}),
        }),
        ...(tokensIn !== undefined ? { tokensIn } : {}),
        ...(tokensOut !== undefined ? { tokensOut } : {}),
      },
    };
  }
}
