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
  asString,
  dedupeQueryStrings,
  deepMergeRecords,
  extractStringQueries,
  isRecord,
  mergeCitations,
} from '../shared/parsing.js';

function extractAnswerText(message: Record<string, unknown> | undefined): string {
  if (message === undefined) {
    return '';
  }

  const content = message['content'];
  const direct = asString(content);
  if (direct !== undefined) {
    return direct;
  }

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part);
      } else if (isRecord(part)) {
        const text = asString(part['text']) ?? asString(part['content']);
        if (text !== undefined) {
          parts.push(text);
        }
      }
    }
    return parts.join('\n');
  }

  return '';
}

function extractOpenAiAnnotations(rawAnnotations: unknown): RawCitation[] {
  if (!Array.isArray(rawAnnotations)) {
    return [];
  }

  const citations: RawCitation[] = [];
  for (const item of rawAnnotations) {
    if (!isRecord(item)) {
      continue;
    }

    const nested = isRecord(item['url_citation']) ? item['url_citation'] : item;
    const url =
      asNonEmptyString(nested['url']) ??
      asNonEmptyString(nested['uri']) ??
      asNonEmptyString(nested['link']);

    if (url === undefined) {
      continue;
    }

    const title = asNonEmptyString(nested['title']) ?? asNonEmptyString(nested['name']);
    const snippet =
      asNonEmptyString(nested['snippet']) ??
      asNonEmptyString(nested['content']) ??
      asNonEmptyString(nested['text']);

    citations.push({
      url,
      ...(title !== undefined ? { title } : {}),
      ...(snippet !== undefined ? { snippet } : {}),
    });
  }

  return citations;
}

function extractGroundingMetadata(
  data: Record<string, unknown>,
  message: Record<string, unknown> | undefined,
): { citations: RawCitation[]; queries: string[] } {
  const candidates: unknown[] = [data['grounding_metadata'], message?.['grounding_metadata']];
  const choices = data['choices'];
  if (Array.isArray(choices) && choices.length > 0 && isRecord(choices[0])) {
    candidates.push(choices[0]['grounding_metadata']);
  }

  const citations: RawCitation[] = [];
  const queries: string[] = [];

  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }

    queries.push(
      ...extractStringQueries(candidate['web_search_queries']),
      ...extractStringQueries(candidate['search_queries']),
    );

    const chunks = candidate['grounding_chunks'];
    if (Array.isArray(chunks)) {
      for (const chunk of chunks) {
        if (!isRecord(chunk)) {
          continue;
        }
        const web = isRecord(chunk['web']) ? chunk['web'] : chunk;
        const url = asNonEmptyString(web['uri']) ?? asNonEmptyString(web['url']);
        if (url === undefined) {
          continue;
        }
        const title = asNonEmptyString(web['title']);
        citations.push({
          url,
          ...(title !== undefined ? { title } : {}),
        });
      }
    }
  }

  return { citations, queries };
}

function dedupeRawCitations(lists: readonly (readonly RawCitation[])[]): RawCitation[] {
  const seen = new Set<string>();
  const result: RawCitation[] = [];

  for (const list of lists) {
    for (const item of list) {
      const url = item.url.trim();
      if (url.length === 0 || seen.has(url)) {
        continue;
      }
      seen.add(url);
      result.push({ ...item, url });
    }
  }

  return result;
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

    const body = deepMergeRecords(
      {
        model: this.config.model.trim(),
        messages: [{ role: 'user', content: ctx.prompt }],
        temperature: 0.2,
        stream: false,
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

    const { message, usage, id, model } = extractChatCompletionParts(data);
    const answerText = extractAnswerText(message);
    const grounding = extractGroundingMetadata(data, message);

    const annotationCitations = extractOpenAiAnnotations(message?.['annotations']);
    const genericCitations = mergeCitations([
      data['citations'],
      data['search_results'],
      data['web_search'],
      message?.['citations'],
      message?.['search_results'],
    ]);

    const citations = dedupeRawCitations([
      annotationCitations,
      genericCitations,
      grounding.citations,
    ]);

    const fanOutQueries = dedupeQueryStrings([
      ...extractStringQueries(data['search_queries']),
      ...extractStringQueries(data['web_search_queries']),
      ...extractStringQueries(message?.['search_queries']),
      ...grounding.queries,
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
        // TODO: Remove placeholder marker once google_aio has a dedicated non-DataForSEO SERP/AIO adapter.
        ...(this.engine === 'google_aio' ? { extra: { placeholder: 'gemini_openai_compat' } } : {}),
      }),
    };
  }
}
