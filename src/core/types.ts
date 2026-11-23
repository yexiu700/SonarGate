import type { Market, PlannedEngine, SupportedEngine } from './contract.js';

export type EngineRegion = 'domestic' | 'overseas';
export type EngineLifecycleStatus = 'ready' | 'unconfigured' | 'disabled' | 'planned';

export interface RawCitation {
  url: string;
  title?: string | undefined;
  snippet?: string | undefined;
  position?: number | undefined;
}

export interface CollectContext {
  prompt: string;
  engine: SupportedEngine;
  requestId: string;
  locationCode: number;
  languageCode: string;
  market?: Market | undefined;
  locale?: string | undefined;
  /** Normalized ISO-3166-1 alpha-2 country/region code (e.g. CN, US, GB, DE, JP). */
  region?: string | undefined;
  signal: AbortSignal;
  timeoutMs: number;
}

/**
 * A page recalled (or opened) by an engine's server-side search tool. These are NOT
 * final citations: they are surfaced separately (via `rawMeta.retrievedSources` /
 * `rawMeta.openedPages`) so they never inflate `citations`.
 */
export interface RetrievedSource extends RawCitation {
  siteName?: string | undefined;
  publishedAt?: string | undefined;
  /** True when the model actually opened/read this page (`open_page` action). */
  opened?: boolean | undefined;
}

export interface AdapterResult {
  answerText: string;
  citations: RawCitation[];
  fanOutQueries: string[];
  /** Pages recalled by server-side search but not necessarily cited (e.g. DeepSeek `server_tool_calls`). */
  retrievedSources?: RetrievedSource[] | undefined;
  /** Pages the model actually opened during server-side search (`open_page`). */
  openedPages?: RetrievedSource[] | undefined;
  rawMeta: {
    provider: string;
    model?: string | undefined;
    upstreamRequestId?: string | undefined;
    tokensIn?: number | undefined;
    tokensOut?: number | undefined;
    costUsd?: number | undefined;
    aiOverviewTriggered?: boolean | undefined;
    hasReasoning?: boolean | undefined;
    [key: string]: unknown;
  };
}

export interface EngineAdapter {
  readonly engine: SupportedEngine;
  readonly region: EngineRegion;
  readonly provider: string;
  readonly model?: string | undefined;
  isConfigured(): boolean;
  collect(ctx: CollectContext): Promise<AdapterResult>;
}

export interface EngineStatus {
  engine: SupportedEngine;
  region: EngineRegion;
  provider: string;
  model?: string | undefined;
  configured: boolean;
  status: Exclude<EngineLifecycleStatus, 'planned'>;
  aliases?: readonly string[] | undefined;
  concurrencyLimit: number;
  activeRequests: number;
  queuedRequests: number;
}

export interface ReadyEngineSummary {
  engine: SupportedEngine;
  region: EngineRegion;
  configured: boolean;
  status: Exclude<EngineLifecycleStatus, 'planned'>;
  aliases?: readonly string[] | undefined;
}

export interface PlannedEngineStatus {
  engine: PlannedEngine;
  region: EngineRegion;
  configured: false;
  status: 'planned';
}

export interface LoggerLike {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}
