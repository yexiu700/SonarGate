import type { AppConfig } from '../config.js';
import { DeepSeekAdapter } from '../adapters/domestic/deepseek.adapter.js';
import { DoubaoAdapter } from '../adapters/domestic/doubao.adapter.js';
import { TongyiAdapter } from '../adapters/domestic/tongyi.adapter.js';
import { WenxinAdapter } from '../adapters/domestic/wenxin.adapter.js';
import { ZhipuAdapter } from '../adapters/domestic/zhipu.adapter.js';
import { createDataForSeoAdapters } from '../adapters/overseas/dataforseo.adapter.js';
import { OpenAiCompatOverseasAdapter } from '../adapters/overseas/openai-compat.adapter.js';
import {
  OVERSEAS_ENGINES,
  PLANNED_ENGINES,
  SUPPORTED_ENGINES,
  isPlannedEngine,
  isSupportedEngine,
  type SupportedEngine,
} from './contract.js';
import {
  engineNotConfiguredError,
  engineNotImplementedError,
  unsupportedEngineError,
} from './errors.js';
import type { HttpClient } from './http-client.js';
import { Semaphore } from './semaphore.js';
import type { EngineAdapter, EngineStatus, LoggerLike, PlannedEngineStatus } from './types.js';

export interface ResolvedEngine {
  adapter: EngineAdapter;
  semaphore: Semaphore;
}

export interface EngineRegistryOptions {
  adapters: readonly EngineAdapter[];
  domesticConcurrencyPerEngine: number;
  dataforseoConcurrency: number;
  semaphoreWaitMs: number;
}

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
        this.semaphores.set(
          adapter.engine,
          new Semaphore({
            maxConcurrency: options.domesticConcurrencyPerEngine,
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
      new DoubaoAdapter(config.domestic.doubao, httpClient),
      new DeepSeekAdapter(config.domestic.deepseek, httpClient),
      new TongyiAdapter(config.domestic.tongyi, httpClient),
      new ZhipuAdapter(config.domestic.zhipu, httpClient),
      new WenxinAdapter(config.domestic.wenxin, httpClient),
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

    return new EngineRegistry({
      adapters: [...domesticAdapters, ...overseasAdapters],
      domesticConcurrencyPerEngine: config.budget.domesticConcurrencyPerEngine,
      dataforseoConcurrency: config.budget.dataforseoConcurrency,
      semaphoreWaitMs: config.budget.semaphoreWaitMs,
    });
  }

  resolve(engineName: string): ResolvedEngine {
    const normalized = engineName.trim().toLowerCase();
    if (!isSupportedEngine(normalized)) {
      if (isPlannedEngine(normalized)) {
        throw engineNotImplementedError(normalized);
      }
      throw unsupportedEngineError(normalized.length > 0 ? normalized : engineName);
    }

    const adapter = this.adapters.get(normalized);
    const semaphore = this.semaphores.get(normalized);
    if (adapter === undefined || semaphore === undefined || !adapter.isConfigured()) {
      throw engineNotConfiguredError(normalized);
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
      statuses.push({
        engine: adapter.engine,
        region: adapter.region,
        provider: adapter.provider,
        ...(adapter.model !== undefined ? { model: adapter.model } : {}),
        configured,
        status: configured ? 'ready' : 'unconfigured',
        concurrencyLimit: stats.maxConcurrency,
        activeRequests: stats.active,
        queuedRequests: stats.queued,
      });
    }

    return statuses;
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
