import type { AppConfig } from '../../config.js';
import {
  engineNotConfiguredError,
  invalidRequestError,
  rateLimitedError,
  upstreamAuthOrQuotaError,
  upstreamBadResponseError,
  type GatewayError,
} from '../../core/errors.js';
import { HttpClient, sanitizeUrlForLog } from '../../core/http-client.js';
import type { CollectContext, LoggerLike } from '../../core/types.js';

export type DataForSeoConfig = AppConfig['overseas']['dataforseo'];

export interface DataForSeoTaskEnvelope {
  id?: string;
  status_code?: number;
  status_message?: string;
  cost?: number;
  result_count?: number;
  result?: unknown[];
}

export interface DataForSeoResponseEnvelope {
  version?: string;
  status_code?: number;
  status_message?: string;
  time?: string;
  cost?: number;
  tasks_count?: number;
  tasks_error?: number;
  tasks?: DataForSeoTaskEnvelope[];
}

export interface DataForSeoCallResult {
  task: DataForSeoTaskEnvelope;
  result: Record<string, unknown>;
  costUsd?: number | undefined;
  upstreamRequestId?: string | undefined;
}

export interface DataForSeoRequestParams {
  endpointPath: string;
  payload: Record<string, unknown>;
  ctx: CollectContext;
}

const DATAFORSEO_OK_CODE = 20000;
const DATAFORSEO_AUTH_OR_QUOTA_CODES = new Set([40100, 40101, 40200]);
const DATAFORSEO_RATE_LIMIT_CODE = 42900;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractCostUsd(
  body: DataForSeoResponseEnvelope,
  task: DataForSeoTaskEnvelope,
): number | undefined {
  if (typeof body.cost === 'number' && Number.isFinite(body.cost) && body.cost >= 0) {
    return body.cost;
  }
  if (typeof task.cost === 'number' && Number.isFinite(task.cost) && task.cost >= 0) {
    return task.cost;
  }
  return undefined;
}

function extractUpstreamRequestId(task: DataForSeoTaskEnvelope): string | undefined {
  if (typeof task.id === 'string') {
    const trimmed = task.id.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

export class DataForSeoClient {
  private readonly config: DataForSeoConfig;
  private readonly httpClient: HttpClient;
  private readonly logger: LoggerLike | undefined;

  constructor(config: DataForSeoConfig, httpClient: HttpClient, logger?: LoggerLike | undefined) {
    this.config = config;
    this.httpClient = httpClient;
    this.logger = logger;
  }

  isConfigured(): boolean {
    return this.config.login.trim().length > 0 && this.config.password.trim().length > 0;
  }

  private resolveUrl(endpointPath: string): string {
    if (endpointPath.startsWith('http://') || endpointPath.startsWith('https://')) {
      return endpointPath;
    }
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const normalizedPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
    return `${base}${normalizedPath}`;
  }

  private mapLogicalStatusCode(
    statusCode: unknown,
    statusMessage: unknown,
    params: DataForSeoRequestParams,
    url: string,
  ): GatewayError {
    const engine = params.ctx.engine;
    const detail =
      typeof statusMessage === 'string' && statusMessage.trim().length > 0
        ? statusMessage.trim()
        : 'Unknown DataForSEO error';

    if (typeof statusCode === 'number' && Number.isFinite(statusCode)) {
      if (DATAFORSEO_AUTH_OR_QUOTA_CODES.has(statusCode)) {
        this.logger?.error(
          {
            engine,
            provider: 'dataforseo',
            requestId: params.ctx.requestId,
            statusCode,
            statusMessage: detail,
            url: sanitizeUrlForLog(url),
          },
          'DataForSEO authentication or quota error',
        );
        return upstreamAuthOrQuotaError(
          `DataForSEO authentication or quota error (${statusCode}): ${detail}`,
          { engine },
        );
      }

      if (statusCode === DATAFORSEO_RATE_LIMIT_CODE) {
        return rateLimitedError(`DataForSEO rate limited (${statusCode}): ${detail}`, { engine });
      }

      if (statusCode >= 40000 && statusCode <= 40999) {
        return invalidRequestError(`DataForSEO rejected request (${statusCode}): ${detail}`, {
          engine,
        });
      }

      return upstreamBadResponseError(`DataForSEO upstream error (${statusCode}): ${detail}`, {
        engine,
        retryable: true,
      });
    }

    return upstreamBadResponseError(`DataForSEO returned invalid logical status_code: ${detail}`, {
      engine,
      retryable: true,
    });
  }

  async postTask(params: DataForSeoRequestParams): Promise<DataForSeoCallResult> {
    if (!this.isConfigured()) {
      throw engineNotConfiguredError(params.ctx.engine);
    }

    const url = this.resolveUrl(params.endpointPath);
    const basicToken = Buffer.from(
      `${this.config.login.trim()}:${this.config.password.trim()}`,
      'utf8',
    ).toString('base64');

    const response = await this.httpClient.postJson<DataForSeoResponseEnvelope>(
      url,
      [params.payload],
      {
        headers: {
          authorization: `Basic ${basicToken}`,
        },
        timeoutMs: params.ctx.timeoutMs,
        signal: params.ctx.signal,
        engine: params.ctx.engine,
        provider: 'dataforseo',
        requestId: params.ctx.requestId,
      },
    );

    const body = response.data;
    if (!isPlainRecord(body)) {
      throw upstreamBadResponseError('DataForSEO returned non-object JSON payload', {
        engine: params.ctx.engine,
        retryable: true,
      });
    }

    if (body.status_code !== DATAFORSEO_OK_CODE) {
      throw this.mapLogicalStatusCode(body.status_code, body.status_message, params, url);
    }

    const task = Array.isArray(body.tasks) ? body.tasks[0] : undefined;
    if (!isPlainRecord(task)) {
      throw upstreamBadResponseError('DataForSEO response missing tasks[0]', {
        engine: params.ctx.engine,
        retryable: true,
      });
    }

    const typedTask = task as DataForSeoTaskEnvelope;
    if (typedTask.status_code !== DATAFORSEO_OK_CODE) {
      throw this.mapLogicalStatusCode(typedTask.status_code, typedTask.status_message, params, url);
    }

    const firstResult = Array.isArray(typedTask.result) ? typedTask.result[0] : undefined;
    if (!isPlainRecord(firstResult)) {
      throw upstreamBadResponseError('DataForSEO task response missing result[0]', {
        engine: params.ctx.engine,
        retryable: true,
      });
    }

    const costUsd = extractCostUsd(body as DataForSeoResponseEnvelope, typedTask);
    const upstreamRequestId = extractUpstreamRequestId(typedTask);

    this.logger?.info(
      {
        engine: params.ctx.engine,
        provider: 'dataforseo',
        requestId: params.ctx.requestId,
        url: sanitizeUrlForLog(url),
        ...(upstreamRequestId !== undefined ? { upstreamRequestId } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      },
      'DataForSEO request succeeded',
    );

    return {
      task: typedTask,
      result: firstResult,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(upstreamRequestId !== undefined ? { upstreamRequestId } : {}),
    };
  }
}
