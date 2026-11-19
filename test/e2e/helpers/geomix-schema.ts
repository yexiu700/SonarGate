import { z } from 'zod';

export const DOMESTIC_ENGINES = ['doubao', 'deepseek', 'tongyi', 'zhipu', 'wenxin'] as const;

export const OVERSEAS_ENGINES = [
  'chatgpt',
  'perplexity',
  'gemini',
  'claude',
  'google_aio',
] as const;

export const SUPPORTED_ENGINES = [...DOMESTIC_ENGINES, ...OVERSEAS_ENGINES] as const;

export type DomesticEngine = (typeof DOMESTIC_ENGINES)[number];
export type OverseasEngine = (typeof OVERSEAS_ENGINES)[number];
export type SupportedEngine = (typeof SUPPORTED_ENGINES)[number];

export const GEOMIX_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const GATEWAY_BYTE_GUARD_LIMIT = 1_900_000;

export const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Exact GeoMix `remoteScraperResponseSchema` (verified from `yexiu700/geomix`).
 */
export const remoteScraperResponseSchema = z.object({
  answerText: z.string().min(1).max(200_000),
  citations: z
    .array(
      z.object({
        url: z.string().min(1).max(2048),
        title: z.string().max(300).optional(),
        snippet: z.string().max(1000).optional(),
        position: z.number().int().positive().optional(),
      }),
    )
    .max(100)
    .default([]),
  fanOutQueries: z.array(z.string().max(300)).max(50).default([]),
  rawMeta: z.record(z.unknown()).optional(),
});

export type RemoteScraperResponse = z.infer<typeof remoteScraperResponseSchema>;

export const GATEWAY_ERROR_CODES = [
  'INVALID_REQUEST',
  'UNSUPPORTED_ENGINE',
  'UNAUTHORIZED',
  'UPSTREAM_TIMEOUT',
  'RATE_LIMITED',
  'ENGINE_NOT_CONFIGURED',
  'UPSTREAM_BAD_RESPONSE',
  'UPSTREAM_AUTH_OR_QUOTA',
  'INTERNAL_ERROR',
] as const;

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.enum(GATEWAY_ERROR_CODES),
    message: z.string().min(1),
    retryable: z.boolean(),
    engine: z.string().optional(),
    requestId: z.string().min(1),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/**
 * Verifies a raw HTTP response body and parsed JSON satisfy both the GeoMix 2 MiB
 * transport ceiling and `remoteScraperResponseSchema`.
 */
export function assertValidGeoMixResponse(rawBody: string, parsed: unknown): RemoteScraperResponse {
  const byteLength = Buffer.byteLength(rawBody, 'utf8');
  if (byteLength >= GEOMIX_MAX_RESPONSE_BYTES) {
    throw new Error(
      `Response body size (${byteLength} bytes) must be strictly less than GeoMix 2 MiB limit (${GEOMIX_MAX_RESPONSE_BYTES} bytes).`,
    );
  }
  return remoteScraperResponseSchema.parse(parsed);
}

/**
 * Verifies a `google_aio` No-AIO fallback answer satisfies GeoMix's
 * `assessAnswerTopicRelevance()` bypass rules:
 *   1. Does not start with `【FAKE】`
 *   2. Non-whitespace length is strictly `< 60`
 */
export function assertPassesGeoMixTopicRelevanceFallback(answerText: string): void {
  if (answerText.startsWith('【FAKE】')) {
    throw new Error(`Fallback answerText must not start with "【FAKE】", received: ${answerText}`);
  }
  const compactLength = answerText.replace(/\s+/g, '').length;
  if (compactLength >= 60) {
    throw new Error(
      `Fallback answerText non-whitespace length must be < 60, received ${compactLength}: ${answerText}`,
    );
  }
}

/**
 * Returns true if `text` contains any lone UTF-16 high or low surrogate code unit.
 */
export function hasBrokenSurrogatePair(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
