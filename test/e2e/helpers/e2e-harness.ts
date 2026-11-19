import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { buildApp } from '../../../src/app.js';
import { loadConfig } from '../../../src/config.js';
import type { AppConfig } from '../../../src/config.js';
import { UpstreamMocker } from './mock-upstreams.js';

export const PRIMARY_API_KEY = 'e2e-primary-key-32bytes-00000001';
export const SECONDARY_API_KEY = 'e2e-secondary-key-32bytes-000002';

export const DEFAULT_E2E_ENV: Record<string, string> = {
  HOST: '127.0.0.1',
  PORT: '8080',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  GATEWAY_API_KEYS: `${PRIMARY_API_KEY},${SECONDARY_API_KEY}`,
  GATEWAY_REQUEST_TIMEOUT_MS: '105000',
  DOMESTIC_TIMEOUT_MS: '45000',
  OVERSEAS_TIMEOUT_MS: '85000',
  MAX_UPSTREAM_RETRIES: '2',
  RETRY_BASE_DELAY_MS: '1000',
  SEMAPHORE_WAIT_MS: '15000',
  DOMESTIC_CONCURRENCY_PER_ENGINE: '5',
  DATAFORSEO_CONCURRENCY: '10',
  CACHE_TTL_SECONDS: '600',
  CACHE_MAX_ENTRIES: '2000',
  DOUBAO_API_KEY: 'e2e-secret-doubao-key-0001',
  DOUBAO_BASE_URL: 'https://ark.cn-beijing.volces.com/api/v3',
  DOUBAO_MODEL: 'ep-e2e-doubao-test',
  DOUBAO_EXTRA_BODY_JSON: '{}',
  DEEPSEEK_API_KEY: 'e2e-secret-deepseek-key-0002',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
  DEEPSEEK_MODEL: 'deepseek-chat',
  DEEPSEEK_SEARCH_PARAMS_JSON: '{"web_search":true}',
  TONGYI_API_KEY: 'e2e-secret-tongyi-key-0003',
  TONGYI_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  TONGYI_MODEL: 'qwen-plus',
  TONGYI_SEARCH_STRATEGY: 'standard',
  ZHIPU_API_KEY: 'e2e-secret-zhipu-key-0004',
  ZHIPU_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
  ZHIPU_MODEL: 'glm-4-plus',
  ZHIPU_SEARCH_ENGINE: 'search_pro',
  WENXIN_API_KEY: 'e2e-secret-wenxin-key-0005',
  WENXIN_BASE_URL: 'https://qianfan.baidubce.com/v2',
  WENXIN_MODEL: 'ernie-4.5-turbo-128k',
  DATAFORSEO_LOGIN: 'e2e-secret-dfs-login',
  DATAFORSEO_PASSWORD: 'e2e-secret-dfs-password',
  DATAFORSEO_BASE_URL: 'https://api.dataforseo.com',
  DATAFORSEO_LOCATION_CODE: '2840',
  DATAFORSEO_LANGUAGE_CODE: 'en',
  DATAFORSEO_COUNTRY_ISO: 'US',
  DATAFORSEO_PERPLEXITY_MODEL: 'sonar',
  DATAFORSEO_CLAUDE_MODEL: 'claude-sonnet-4-5',
  DATAFORSEO_GEMINI_MODE: 'scraper',
  DATAFORSEO_GEMINI_MODEL: 'gemini-2.5-flash',
};

export interface CollectHelperOptions {
  apiKey?: string | null;
  requestId?: string;
  bypassCache?: boolean;
  headers?: Record<string, string>;
  rawBody?: string;
}

export interface EnginesHelperOptions {
  apiKey?: string | null;
  requestId?: string;
  headers?: Record<string, string>;
}

export interface E2EHarness {
  readonly app: FastifyInstance;
  readonly config: AppConfig;
  readonly upstreams: UpstreamMocker;
  collect(body: unknown, opts?: CollectHelperOptions): Promise<LightMyRequestResponse>;
  getHealth(headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  getReady(headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  getEngines(opts?: EnginesHelperOptions): Promise<LightMyRequestResponse>;
  markShuttingDown(): void;
  close(): Promise<void>;
}

type ShutdownCapableApp = FastifyInstance & {
  markShuttingDown?: () => void;
};

function hasHeaderCaseInsensitive(headers: Record<string, string>, target: string): boolean {
  const lower = target.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function buildMergedEnv(
  overrides?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...DEFAULT_E2E_ENV };
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
}

export function createE2EHarness(envOverrides?: Record<string, string | undefined>): E2EHarness {
  const previousDispatcher = getGlobalDispatcher();
  const upstreams = new UpstreamMocker();
  setGlobalDispatcher(upstreams.mockAgent);

  let config: AppConfig;
  let app: FastifyInstance;

  try {
    const mergedEnv = buildMergedEnv(envOverrides);
    config = loadConfig(mergedEnv);
    app = buildApp({ config, logger: false });
  } catch (err) {
    setGlobalDispatcher(previousDispatcher);
    void upstreams.close();
    throw err;
  }

  let closed = false;

  const collect = async (
    body: unknown,
    opts?: CollectHelperOptions,
  ): Promise<LightMyRequestResponse> => {
    const headers: Record<string, string> = { ...(opts?.headers ?? {}) };

    if (!hasHeaderCaseInsensitive(headers, 'content-type')) {
      headers['content-type'] = 'application/json';
    }

    if (!hasHeaderCaseInsensitive(headers, 'authorization') && opts?.apiKey !== null) {
      const token = opts?.apiKey ?? PRIMARY_API_KEY;
      headers['authorization'] = `Bearer ${token}`;
    }

    if (opts?.requestId !== undefined && !hasHeaderCaseInsensitive(headers, 'x-request-id')) {
      headers['x-request-id'] = opts.requestId;
    }

    if (opts?.bypassCache === true && !hasHeaderCaseInsensitive(headers, 'x-bypass-cache')) {
      headers['x-bypass-cache'] = 'true';
    }

    const payload = opts?.rawBody !== undefined ? opts.rawBody : JSON.stringify(body);

    return app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers,
      payload,
    });
  };

  const getHealth = async (headers?: Record<string, string>): Promise<LightMyRequestResponse> => {
    if (headers !== undefined) {
      return app.inject({ method: 'GET', url: '/health', headers });
    }
    return app.inject({ method: 'GET', url: '/health' });
  };

  const getReady = async (headers?: Record<string, string>): Promise<LightMyRequestResponse> => {
    if (headers !== undefined) {
      return app.inject({ method: 'GET', url: '/ready', headers });
    }
    return app.inject({ method: 'GET', url: '/ready' });
  };

  const getEngines = async (opts?: EnginesHelperOptions): Promise<LightMyRequestResponse> => {
    const headers: Record<string, string> = { ...(opts?.headers ?? {}) };

    if (!hasHeaderCaseInsensitive(headers, 'authorization') && opts?.apiKey !== null) {
      const token = opts?.apiKey ?? PRIMARY_API_KEY;
      headers['authorization'] = `Bearer ${token}`;
    }

    if (opts?.requestId !== undefined && !hasHeaderCaseInsensitive(headers, 'x-request-id')) {
      headers['x-request-id'] = opts.requestId;
    }

    return app.inject({
      method: 'GET',
      url: '/v1/engines',
      headers,
    });
  };

  const markShuttingDown = (): void => {
    const shutdownApp = app as ShutdownCapableApp;
    if (typeof shutdownApp.markShuttingDown !== 'function') {
      throw new Error('Expected Fastify app from buildApp() to expose markShuttingDown().');
    }
    shutdownApp.markShuttingDown();
  };

  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      await app.close();
    } finally {
      try {
        await upstreams.close();
      } finally {
        setGlobalDispatcher(previousDispatcher);
      }
    }
  };

  return {
    app,
    config,
    upstreams,
    collect,
    getHealth,
    getReady,
    getEngines,
    markShuttingDown,
    close,
  };
}
