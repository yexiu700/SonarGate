import type { PlannedEngine, SupportedEngine } from './contract.js';

export type EngineRegion = 'domestic' | 'overseas';
export type EngineLifecycleStatus = 'ready' | 'unconfigured' | 'planned';

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
  signal: AbortSignal;
  timeoutMs: number;
}

export interface AdapterResult {
  answerText: string;
  citations: RawCitation[];
  fanOutQueries: string[];
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
  concurrencyLimit: number;
  activeRequests: number;
  queuedRequests: number;
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
