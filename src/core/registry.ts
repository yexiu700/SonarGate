import type { AppConfig } from '../config.js';
import { DeepSeekAdapter } from '../adapters/domestic/deepseek.adapter.js';
import { DoubaoAdapter } from '../adapters/domestic/doubao.adapter.js';
import { KimiAdapter } from '../adapters/domestic/kimi.adapter.js';
import { TongyiAdapter } from '../adapters/domestic/tongyi.adapter.js';
import { WenxinAdapter } from '../adapters/domestic/wenxin.adapter.js';
import { YuanbaoAdapter } from '../adapters/domestic/yuanbao.adapter.js';
import { ZhipuAdapter } from '../adapters/domestic/zhipu.adapter.js';
import { createDataForSeoAdapters } from '../adapters/overseas/dataforseo.adapter.js';
import { OpenAiCompatOverseasAdapter } from '../adapters/overseas/openai-compat.adapter.js';
import {
  OVERSEAS_ENGINES,
  PLANNED_ENGINES,
  SUPPORTED_ENGINES,
  getAliasesForEngine,
  isPlannedEngine,
  isSupportedEngine,
  resolveEngineAlias,
  type SupportedEngine,
} from './contract.js';
import {
  engineNotConfiguredError,
  engineNotImplementedError,
  unsupportedEngineError,
} from './errors.js';
import type { HttpClient } from './http-client.js';
import { Semaphore } from './semaphore.js';
import type {
  EngineAdapter,
  EngineStatus,
  LoggerLike,
  PlannedEngineStatus,
  ReadyEngineSummary,
} from './types.js';

export interface ResolvedEngine {
  adapter: EngineAdapter;
  semaphore: Semaphore;
}

export interface EngineRegistryOptions {
  adapters: readonly EngineAdapter[];
  domesticConcurrencyPerEngine: number;
  dataforseoConcurrency: number;
  semaphoreWaitMs: number;
  perEngineConcurrency?: Partial<Record<SupportedEngine, number>> | undefined;
}

const DEFAULT_DOUBAO_GENTLE_CONCURRENCY = 2;

export class EngineRegistry {
  private readonly adapters = new Map<SupportedEngine, EngineAdapter>();
  private readonly semaphores = new Map<SupportedEngine, Semaphore>();

  constructor(options: EngineRegistryOptions) {
    const overseasSemaphore = new Semaphore({
      maxConcurrency: options.dataforseoConcurrency,
      waitTimeoutMs: options.semaphoreWaitMs,
      name: 'dataforseo',
    });

    for (const adapter of options.adapters) {
      this.adapters.set(adapter.engine, adapter);
      if (adapter.region === 'domestic') {
        const overrideConcurrency = options.perEngineConcurrency?.[adapter.engine];
        this.semaphores.set(
          adapter.engine,
          new Semaphore({
            maxConcurrency: overrideConcurrency ?? options.domesticConcurrencyPerEngine,
            waitTimeoutMs: options.semaphoreWaitMs,
            name: adapter.engine,
          }),
        );
      } else {
        this.semaphores.set(adapter.engine, overseasSemaphore);
      }
    }
  }

  static fromConfig(
    config: AppConfig,
    httpClient: HttpClient,
    logger?: LoggerLike,
  ): EngineRegistry {
    const domesticAdapters: EngineAdapter[] = [
      new DoubaoAdapter(config.domestic.doubao, httpClient, logger),
      new DeepSeekAdapter(config.domestic.deepseek, httpClient),
      new TongyiAdapter(config.domestic.tongyi, httpClient),
      new ZhipuAdapter(config.domestic.zhipu, httpClient),
      new WenxinAdapter(config.domestic.wenxin, httpClient),
      new YuanbaoAdapter(config.domestic.yuanbao, httpClient),
      new KimiAdapter(config.domestic.kimi, httpClient),
    ];

    const dataforseoAdapters = createDataForSeoAdapters({
      config: config.overseas.dataforseo,
      httpClient,
      ...(logger !== undefined ? { logger } : {}),
    });
    const dataforseoByEngine = new Map<SupportedEngine, EngineAdapter>(
      dataforseoAdapters.map((adapter) => [adapter.engine, adapter]),
    );

    const overseasAdapters: EngineAdapter[] = OVERSEAS_ENGINES.map((engine) => {
      const dfsAdapter = dataforseoByEngine.get(engine)!;
      const openAiConfig = config.overseas.engines[engine];
      const openAiAdapter = new OpenAiCompatOverseasAdapter(engine, openAiConfig, httpClient);

      if (openAiConfig.provider === 'openai_compat') {
        return openAiAdapter;
      }
      if (openAiConfig.provider === 'dataforseo') {
        return dfsAdapter;
      }
      if (dfsAdapter.isConfigured()) {
        return dfsAdapter;
      }
      if (openAiAdapter.isConfigured()) {
        return openAiAdapter;
      }
      return dfsAdapter;
    });

    const doubaoConcurrency =
      config.domestic.doubao.concurrency ??
      Math.min(DEFAULT_DOUBAO_GENTLE_CONCURRENCY, config.budget.domesticConcurrencyPerEngine);

    return new EngineRegistry({
      adapters: [...domesticAdapters, ...overseasAdapters],
      domesticConcurrencyPerEngine: config.budget.domesticConcurrencyPerEngine,
      dataforseoConcurrency: config.budget.dataforseoConcurrency,
      semaphoreWaitMs: config.budget.semaphoreWaitMs,
      perEngineConcurrency: {
        doubao: doubaoConcurrency,
      },
    });
  }

  resolve(engineName: string): ResolvedEngine {
    const rawNormalized = engineName.trim().toLowerCase();
    const canonical = resolveEngineAlias(rawNormalized);

    if (!isSupportedEngine(canonical)) {
      if (isPlannedEngine(canonical)) {
        throw engineNotImplementedError(canonical);
      }
      throw unsupportedEngineError(rawNormalized.length > 0 ? rawNormalized : engineName);
    }

    const adapter = this.adapters.get(canonical);
    const semaphore = this.semaphores.get(canonical);
    if (adapter === undefined || semaphore === undefined || !adapter.isConfigured()) {
      throw engineNotConfiguredError(canonical);
    }

    return { adapter, semaphore };
  }

  getStatuses(): EngineStatus[] {
    const statuses: EngineStatus[] = [];

    for (const engine of SUPPORTED_ENGINES) {
      const adapter = this.adapters.get(engine);
      const semaphore = this.semaphores.get(engine);
      if (adapter === undefined || semaphore === undefined) {
        continue;
      }

      const configured = adapter.isConfigured();
      const stats = semaphore.getStats();
      const aliases = getAliasesForEngine(adapter.engine);
      statuses.push({
        engine: adapter.engine,
        region: adapter.region,
        provider: adapter.provider,
        ...(adapter.model !== undefined ? { model: adapter.model } : {}),
        configured,
        status: configured ? 'ready' : 'unconfigured',
        ...(aliases.length > 0 ? { aliases } : {}),
        concurrencyLimit: stats.maxConcurrency,
        activeRequests: stats.active,
        queuedRequests: stats.queued,
      });
    }

    return statuses;
  }

  /** Sanitized availability list safe for the unauthenticated `/ready` endpoint. */
  getReadyEngineSummaries(): ReadyEngineSummary[] {
    const summaries: ReadyEngineSummary[] = [];

    for (const engine of SUPPORTED_ENGINES) {
      const adapter = this.adapters.get(engine);
      if (adapter === undefined) {
        continue;
      }
      const configured = adapter.isConfigured();
      const aliases = getAliasesForEngine(adapter.engine);
      summaries.push({
        engine: adapter.engine,
        region: adapter.region,
        configured,
        status: configured ? 'ready' : 'unconfigured',
        ...(aliases.length > 0 ? { aliases } : {}),
      });
    }

    return summaries;
  }

  getPlannedStatuses(): PlannedEngineStatus[] {
    return PLANNED_ENGINES.map((engine) => ({
      engine,
      region: 'domestic',
      configured: false,
      status: 'planned',
    }));
  }

  getConfiguredCount(): number {
    let count = 0;
    for (const engine of SUPPORTED_ENGINES) {
      const adapter = this.adapters.get(engine);
      if (adapter !== undefined && adapter.isConfigured()) {
        count += 1;
      }
    }
    return count;
  }

  getTotalSupported(): number {
    return SUPPORTED_ENGINES.length;
  }
}
