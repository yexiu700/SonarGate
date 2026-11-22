import type { HttpClient } from '../../core/http-client.js';
import type { AdapterResult, CollectContext, EngineAdapter, LoggerLike } from '../../core/types.js';
import { DataForSeoClient, type DataForSeoConfig } from './dataforseo.client.js';
import {
  parseChatGptResult,
  parseClaudeResult,
  parseGeminiResult,
  parseGoogleAioResult,
  parsePerplexityResult,
} from './dataforseo.parsers.js';

export const DATAFORSEO_ENDPOINTS = {
  chatgpt: '/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced',
  perplexity: '/v3/ai_optimization/perplexity/llm_responses/live',
  geminiScraper: '/v3/ai_optimization/gemini/llm_scraper/live/advanced',
  geminiResponses: '/v3/ai_optimization/gemini/llm_responses/live',
  claude: '/v3/ai_optimization/claude/llm_responses/live',
  googleAio: '/v3/serp/google/organic/live/advanced',
} as const;

export interface CreateDataForSeoAdaptersOptions {
  config: DataForSeoConfig;
  httpClient: HttpClient;
  logger?: LoggerLike | undefined;
}

interface ResolvedGeminiConfig {
  mode: 'scraper' | 'responses';
  endpointPath: string;
}

function resolveGeminiConfig(config: DataForSeoConfig): ResolvedGeminiConfig {
  const customEndpoint = config.geminiEndpoint?.trim();
  if (customEndpoint !== undefined && customEndpoint.length > 0) {
    let mode: 'scraper' | 'responses' = config.geminiMode;
    if (customEndpoint.includes('llm_responses')) {
      mode = 'responses';
    } else if (customEndpoint.includes('llm_scraper')) {
      mode = 'scraper';
    }
    return {
      mode,
      endpointPath: customEndpoint,
    };
  }
  if (config.geminiMode === 'responses') {
    return {
      mode: 'responses',
      endpointPath: DATAFORSEO_ENDPOINTS.geminiResponses,
    };
  }
  return {
    mode: 'scraper',
    endpointPath: DATAFORSEO_ENDPOINTS.geminiScraper,
  };
}

export function createDataForSeoAdapters(
  options: CreateDataForSeoAdaptersOptions,
): EngineAdapter[] {
  const { config, httpClient, logger } = options;
  const client = new DataForSeoClient(config, httpClient, logger);
  const geminiConfig = resolveGeminiConfig(config);

  const chatgptAdapter: EngineAdapter = {
    engine: 'chatgpt',
    region: 'overseas',
    provider: 'dataforseo',
    isConfigured(): boolean {
      return client.isConfigured();
    },
    async collect(ctx: CollectContext): Promise<AdapterResult> {
      const callResult = await client.postTask({
        endpointPath: DATAFORSEO_ENDPOINTS.chatgpt,
        payload: {
          keyword: ctx.prompt,
          location_code: ctx.locationCode,
          language_code: ctx.languageCode,
          force_web_search: true,
        },
        ctx,
      });
      return parseChatGptResult(callResult.result, {
        costUsd: callResult.costUsd,
        upstreamRequestId: callResult.upstreamRequestId,
      });
    },
  };

  const perplexityAdapter: EngineAdapter = {
    engine: 'perplexity',
    region: 'overseas',
    provider: 'dataforseo',
    model: config.perplexityModel,
    isConfigured(): boolean {
      return client.isConfigured();
    },
    async collect(ctx: CollectContext): Promise<AdapterResult> {
      const countryIso = ctx.region ?? config.countryIso;
      const callResult = await client.postTask({
        endpointPath: DATAFORSEO_ENDPOINTS.perplexity,
        payload: {
          user_prompt: ctx.prompt,
          model_name: config.perplexityModel,
          web_search: true,
          web_search_country_iso_code: countryIso,
        },
        ctx,
      });
      return parsePerplexityResult(callResult.result, {
        costUsd: callResult.costUsd,
        upstreamRequestId: callResult.upstreamRequestId,
        fallbackModel: config.perplexityModel,
      });
    },
  };

  const geminiAdapter: EngineAdapter = {
    engine: 'gemini',
    region: 'overseas',
    provider: 'dataforseo',
    ...(geminiConfig.mode === 'responses' ? { model: config.geminiModel } : {}),
    isConfigured(): boolean {
      return client.isConfigured();
    },
    async collect(ctx: CollectContext): Promise<AdapterResult> {
      const countryIso = ctx.region ?? config.countryIso;
      const payload =
        geminiConfig.mode === 'responses'
          ? {
              user_prompt: ctx.prompt,
              model_name: config.geminiModel,
              web_search: true,
              web_search_country_iso_code: countryIso,
            }
          : {
              keyword: ctx.prompt,
              location_code: ctx.locationCode,
              language_code: ctx.languageCode,
            };

      const callResult = await client.postTask({
        endpointPath: geminiConfig.endpointPath,
        payload,
        ctx,
      });
      return parseGeminiResult(callResult.result, {
        costUsd: callResult.costUsd,
        upstreamRequestId: callResult.upstreamRequestId,
        ...(geminiConfig.mode === 'responses' ? { fallbackModel: config.geminiModel } : {}),
      });
    },
  };

  const claudeAdapter: EngineAdapter = {
    engine: 'claude',
    region: 'overseas',
    provider: 'dataforseo',
    model: config.claudeModel,
    isConfigured(): boolean {
      return client.isConfigured();
    },
    async collect(ctx: CollectContext): Promise<AdapterResult> {
      const countryIso = ctx.region ?? config.countryIso;
      const callResult = await client.postTask({
        endpointPath: DATAFORSEO_ENDPOINTS.claude,
        payload: {
          user_prompt: ctx.prompt,
          model_name: config.claudeModel,
          web_search: true,
          web_search_country_iso_code: countryIso,
        },
        ctx,
      });
      return parseClaudeResult(callResult.result, {
        costUsd: callResult.costUsd,
        upstreamRequestId: callResult.upstreamRequestId,
        fallbackModel: config.claudeModel,
      });
    },
  };

  const googleAioAdapter: EngineAdapter = {
    engine: 'google_aio',
    region: 'overseas',
    provider: 'dataforseo',
    isConfigured(): boolean {
      return client.isConfigured();
    },
    async collect(ctx: CollectContext): Promise<AdapterResult> {
      const callResult = await client.postTask({
        endpointPath: DATAFORSEO_ENDPOINTS.googleAio,
        payload: {
          keyword: ctx.prompt,
          location_code: ctx.locationCode,
          language_code: ctx.languageCode,
          device: 'desktop',
          os: 'windows',
          load_async_ai_overview: true,
          expand_ai_overview: true,
        },
        ctx,
      });
      return parseGoogleAioResult(callResult.result, {
        costUsd: callResult.costUsd,
        upstreamRequestId: callResult.upstreamRequestId,
      });
    },
  };

  return [chatgptAdapter, perplexityAdapter, geminiAdapter, claudeAdapter, googleAioAdapter];
}
