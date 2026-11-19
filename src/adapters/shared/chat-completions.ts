import type { SupportedEngine } from '../../core/contract.js';
import { upstreamBadResponseError } from '../../core/errors.js';
import type { HttpClient } from '../../core/http-client.js';
import type { AdapterResult, CollectContext } from '../../core/types.js';
import { asNonEmptyString, asNonNegativeInt, isRecord, trimTrailingSlashes } from './parsing.js';

export interface ChatCompletionParts {
  message?: Record<string, unknown> | undefined;
  usage?: Record<string, unknown> | undefined;
  id?: string | undefined;
  model?: string | undefined;
}

export interface PostChatCompletionOptions {
  httpClient: HttpClient;
  baseUrl: string;
  apiKey: string;
  body: Record<string, unknown>;
  ctx: CollectContext;
  engine: SupportedEngine;
  provider: string;
  endpointPath?: string | undefined;
}

export interface BuildChatCompletionMetaOptions {
  provider: string;
  responseModel?: string | undefined;
  fallbackModel?: string | undefined;
  upstreamRequestId?: string | undefined;
  usage?: Record<string, unknown> | undefined;
  extra?: Record<string, unknown> | undefined;
}

/** Extract common OpenAI-compatible chat/completions fields safely. */
export function extractChatCompletionParts(data: Record<string, unknown>): ChatCompletionParts {
  let message: Record<string, unknown> | undefined;
  const choices = data['choices'];
  if (Array.isArray(choices) && choices.length > 0) {
    const firstChoice = choices[0];
    if (isRecord(firstChoice) && isRecord(firstChoice['message'])) {
      message = firstChoice['message'];
    }
  }

  const usage = isRecord(data['usage']) ? data['usage'] : undefined;
  const id = asNonEmptyString(data['id']);
  const model = asNonEmptyString(data['model']);

  return {
    ...(message !== undefined ? { message } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

/**
 * Sends a Bearer-authenticated JSON POST to an OpenAI-compatible endpoint (default `/chat/completions`)
 * and validates that the response body is a JSON object.
 */
export async function postChatCompletion(
  options: PostChatCompletionOptions,
): Promise<Record<string, unknown>> {
  const endpointPath = options.endpointPath ?? '/chat/completions';
  const url = `${trimTrailingSlashes(options.baseUrl)}${endpointPath}`;

  const response = await options.httpClient.postJson<unknown>(url, options.body, {
    headers: {
      Authorization: `Bearer ${options.apiKey.trim()}`,
    },
    timeoutMs: options.ctx.timeoutMs,
    signal: options.ctx.signal,
    engine: options.engine,
    provider: options.provider,
    requestId: options.ctx.requestId,
  });

  if (!isRecord(response.data)) {
    throw upstreamBadResponseError('Upstream returned non-object JSON payload', {
      engine: options.engine,
      retryable: true,
    });
  }

  return response.data;
}

/** Assemble normalized rawMeta from OpenAI-compatible chat/completions parts. */
export function buildChatCompletionMeta(
  options: BuildChatCompletionMetaOptions,
): AdapterResult['rawMeta'] {
  const model = options.responseModel ?? options.fallbackModel;
  const tokensIn = asNonNegativeInt(options.usage?.['prompt_tokens']);
  const tokensOut = asNonNegativeInt(options.usage?.['completion_tokens']);

  return {
    provider: options.provider,
    ...(model !== undefined ? { model } : {}),
    ...(options.upstreamRequestId !== undefined
      ? { upstreamRequestId: options.upstreamRequestId }
      : {}),
    ...(tokensIn !== undefined ? { tokensIn } : {}),
    ...(tokensOut !== undefined ? { tokensOut } : {}),
    ...(options.extra ?? {}),
  };
}
