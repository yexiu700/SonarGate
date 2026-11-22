import { z } from 'zod';
import { MARKET_VALUES, canonicalizeLocale, normalizeRegionCode, type Market } from './locale.js';

export { MARKET_VALUES, type Market };

export const DOMESTIC_ENGINES = [
  'doubao',
  'deepseek',
  'tongyi',
  'zhipu',
  'wenxin',
  'yuanbao',
  'kimi',
] as const;

export const OVERSEAS_ENGINES = [
  'chatgpt',
  'perplexity',
  'gemini',
  'claude',
  'google_aio',
] as const;

export const SUPPORTED_ENGINES = [...DOMESTIC_ENGINES, ...OVERSEAS_ENGINES] as const;

export const PLANNED_ENGINES = ['nami'] as const;

export type DomesticEngine = (typeof DOMESTIC_ENGINES)[number];
export type OverseasEngine = (typeof OVERSEAS_ENGINES)[number];
export type SupportedEngine = (typeof SUPPORTED_ENGINES)[number];
export type PlannedEngine = (typeof PLANNED_ENGINES)[number];

export const ENGINE_ALIASES: Readonly<Record<string, SupportedEngine>> = {
  qwen: 'tongyi',
};

export const SUPPORTED_ENGINE_SET: ReadonlySet<string> = new Set(SUPPORTED_ENGINES);
export const PLANNED_ENGINE_SET: ReadonlySet<string> = new Set(PLANNED_ENGINES);

export function resolveEngineAlias(value: string): string {
  const normalized = value.trim().toLowerCase();
  return ENGINE_ALIASES[normalized] ?? normalized;
}

export function getAliasesForEngine(engine: SupportedEngine): string[] {
  return Object.entries(ENGINE_ALIASES)
    .filter(([, target]) => target === engine)
    .map(([alias]) => alias);
}

export function isSupportedEngine(value: string): value is SupportedEngine {
  return SUPPORTED_ENGINE_SET.has(value);
}

export function isPlannedEngine(value: string): value is PlannedEngine {
  return PLANNED_ENGINE_SET.has(value);
}

const LOCALE_TAG_RE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;
const REGION_ISO_RE = /^[A-Za-z]{2}$/;

export const collectRequestSchema = z.object({
  prompt: z.string().trim().min(1, 'prompt 不能为空').max(2000, 'prompt 长度不能超过 2000'),
  engine: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .transform((s) => s.toLowerCase()),
  market: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.enum(MARKET_VALUES))
    .optional(),
  locale: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .regex(LOCALE_TAG_RE, 'locale 必须是合法的 BCP-47 语种标签（如 zh-CN、en-US、de-DE、ja-JP）')
    .transform((s) => canonicalizeLocale(s))
    .optional(),
  region: z
    .string()
    .trim()
    .regex(REGION_ISO_RE, 'region 必须是 2 位 ISO 国家/地区码（如 CN、US、GB、DE、JP）')
    .transform((s) => normalizeRegionCode(s))
    .optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().trim().min(2).max(16).optional(),
  noCache: z.boolean().optional(),
});

export const normalizedCitationSchema = z.object({
  url: z.string().url().max(2048),
  title: z.string().max(300).optional(),
  snippet: z.string().max(1000).optional(),
  position: z.number().int().positive().optional(),
});

export const collectRawMetaSchema = z
  .object({
    engine: z.string(),
    region: z.enum(['domestic', 'overseas']),
    provider: z.string(),
    model: z.string().optional(),
    requestId: z.string(),
    latencyMs: z.number().int().nonnegative(),
    attempts: z.number().int().positive(),
    cached: z.boolean(),
    costUsd: z.number().nonnegative().optional(),
    tokensIn: z.number().int().nonnegative().optional(),
    tokensOut: z.number().int().nonnegative().optional(),
    aiOverviewTriggered: z.boolean().optional(),
    citationsExtractedFromText: z.boolean().optional(),
    truncatedForByteLimit: z.boolean().optional(),
    upstreamRequestId: z.string().optional(),
    market: z.enum(MARKET_VALUES).optional(),
    locale: z.string().optional(),
    countryCode: z.string().optional(),
    requestedEngine: z.string().optional(),
  })
  .passthrough();

export const collectResponseSchema = z.object({
  answerText: z.string().min(1).max(200_000),
  citations: z.array(normalizedCitationSchema).max(100),
  fanOutQueries: z.array(z.string().min(1).max(300)).max(50),
  rawMeta: collectRawMetaSchema,
});

export const gatewayErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'UNSUPPORTED_ENGINE',
  'UNAUTHORIZED',
  'UPSTREAM_TIMEOUT',
  'RATE_LIMITED',
  'ENGINE_NOT_CONFIGURED',
  'ENGINE_NOT_IMPLEMENTED',
  'UPSTREAM_BAD_RESPONSE',
  'UPSTREAM_AUTH_OR_QUOTA',
  'INTERNAL_ERROR',
]);

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: gatewayErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    engine: z.string().optional(),
    requestId: z.string(),
  }),
});

export type CollectRequest = z.infer<typeof collectRequestSchema>;
export type NormalizedCitation = z.infer<typeof normalizedCitationSchema>;
export type CollectRawMeta = z.infer<typeof collectRawMetaSchema>;
export type CollectResponse = z.infer<typeof collectResponseSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
