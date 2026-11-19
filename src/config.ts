import { z } from 'zod';

export type NodeEnv = 'development' | 'production' | 'test';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
export type GeminiMode = 'scraper' | 'responses';
export type OverseasProviderMode = 'auto' | 'dataforseo' | 'openai_compat';

export interface OverseasEngineOpenAiConfig {
  provider: OverseasProviderMode;
  baseUrl: string;
  apiKey: string;
  model: string;
  extraBody: Record<string, unknown>;
}

export interface AppConfig {
  server: {
    host: string;
    port: number;
    nodeEnv: NodeEnv;
    logLevel: LogLevel;
  };
  auth: {
    gatewayApiKeys: readonly string[];
  };
  budget: {
    gatewayRequestTimeoutMs: number;
    domesticTimeoutMs: number;
    overseasTimeoutMs: number;
    maxUpstreamRetries: number;
    retryBaseDelayMs: number;
    semaphoreWaitMs: number;
    domesticConcurrencyPerEngine: number;
    dataforseoConcurrency: number;
  };
  cache: {
    ttlSeconds: number;
    maxEntries: number;
  };
  domestic: {
    doubao: {
      apiKey: string;
      baseUrl: string;
      model: string;
      extraBody: Record<string, unknown>;
    };
    deepseek: {
      apiKey: string;
      baseUrl: string;
      model: string;
      searchParams: Record<string, unknown>;
    };
    tongyi: {
      apiKey: string;
      baseUrl: string;
      model: string;
      searchStrategy: string;
    };
    zhipu: {
      apiKey: string;
      baseUrl: string;
      model: string;
      searchEngine: string;
    };
    wenxin: {
      apiKey: string;
      baseUrl: string;
      model: string;
    };
  };
  overseas: {
    dataforseo: {
      login: string;
      password: string;
      baseUrl: string;
      locationCode: number;
      languageCode: string;
      countryIso: string;
      perplexityModel: string;
      claudeModel: string;
      geminiMode: GeminiMode;
      geminiModel: string;
      geminiEndpoint?: string;
    };
    relay: {
      defaultProvider: OverseasProviderMode;
      baseUrl: string;
      apiKey: string;
    };
    engines: {
      chatgpt: OverseasEngineOpenAiConfig;
      perplexity: OverseasEngineOpenAiConfig;
      gemini: OverseasEngineOpenAiConfig;
      claude: OverseasEngineOpenAiConfig;
      google_aio: OverseasEngineOpenAiConfig;
    };
  };
}

function emptyToUndefined(val: unknown): unknown {
  if (typeof val === 'string' && val.trim() === '') {
    return undefined;
  }
  return val;
}

function intEnv(
  min: number,
  max: number,
  defaultVal: number,
): z.ZodType<number, z.ZodTypeDef, unknown> {
  return z.preprocess((val) => {
    const normalized = emptyToUndefined(val);
    if (normalized === undefined) {
      return undefined;
    }
    if (typeof normalized === 'string') {
      const trimmed = normalized.trim();
      if (/^-?\d+$/.test(trimmed)) {
        return Number(trimmed);
      }
      return normalized;
    }
    return normalized;
  }, z.number().int().min(min).max(max).default(defaultVal));
}

function stringEnv(defaultVal: string): z.ZodType<string, z.ZodTypeDef, unknown> {
  return z.preprocess(emptyToUndefined, z.string().trim().min(1).default(defaultVal));
}

function optionalSecretEnv(): z.ZodType<string, z.ZodTypeDef, unknown> {
  return z
    .string()
    .optional()
    .default('')
    .transform((s) => s.trim());
}

function urlEnv(defaultUrl: string): z.ZodType<string, z.ZodTypeDef, unknown> {
  return z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), {
        message: 'URL must use http:// or https:// protocol',
      })
      .default(defaultUrl)
      .transform((u) => u.replace(/\/+$/, '')),
  );
}

function optionalUrlEnv(): z.ZodType<string, z.ZodTypeDef, unknown> {
  return z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), {
        message: 'URL must use http:// or https:// protocol',
      })
      .optional()
      .transform((u) => (u !== undefined ? u.replace(/\/+$/, '') : '')),
  );
}

function optionalProviderEnv(): z.ZodType<OverseasProviderMode | undefined, z.ZodTypeDef, unknown> {
  return z.preprocess(emptyToUndefined, z.enum(['auto', 'dataforseo', 'openai_compat']).optional());
}

function jsonObjectEnv(
  defaultObj: Record<string, unknown>,
): z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown> {
  return z.preprocess(
    emptyToUndefined,
    z
      .string()
      .optional()
      .transform((raw, ctx): Record<string, unknown> => {
        if (raw === undefined) {
          return { ...defaultObj };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Invalid JSON',
          });
          return z.NEVER;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Expected a plain JSON object',
          });
          return z.NEVER;
        }
        return parsed as Record<string, unknown>;
      }),
  );
}

const rawEnvSchema = z
  .object({
    // Server & Auth
    HOST: stringEnv('0.0.0.0'),
    PORT: intEnv(1, 65535, 8080),
    NODE_ENV: z.preprocess(
      emptyToUndefined,
      z.enum(['development', 'production', 'test']).default('production'),
    ),
    LOG_LEVEL: z.preprocess(
      emptyToUndefined,
      z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    ),
    GATEWAY_API_KEYS: z.string().optional(),
    GATEWAY_API_KEY: z.string().optional(),

    // Budget, Resilience & Cache
    GATEWAY_REQUEST_TIMEOUT_MS: intEnv(1_000, 600_000, 105_000),
    DOMESTIC_TIMEOUT_MS: intEnv(1_000, 300_000, 45_000),
    OVERSEAS_TIMEOUT_MS: intEnv(1_000, 300_000, 85_000),
    MAX_UPSTREAM_RETRIES: intEnv(0, 10, 2),
    RETRY_BASE_DELAY_MS: intEnv(50, 30_000, 1_000),
    SEMAPHORE_WAIT_MS: intEnv(100, 120_000, 15_000),
    DOMESTIC_CONCURRENCY_PER_ENGINE: intEnv(1, 100, 5),
    DATAFORSEO_CONCURRENCY: intEnv(1, 200, 10),
    CACHE_TTL_SECONDS: intEnv(0, 86_400, 600),
    CACHE_MAX_ENTRIES: intEnv(1, 100_000, 2_000),

    // Domestic 1: Doubao
    DOUBAO_API_KEY: optionalSecretEnv(),
    DOUBAO_BASE_URL: urlEnv('https://ark.cn-beijing.volces.com/api/v3'),
    DOUBAO_MODEL: optionalSecretEnv(),
    DOUBAO_EXTRA_BODY_JSON: jsonObjectEnv({}),

    // Domestic 2: DeepSeek
    DEEPSEEK_API_KEY: optionalSecretEnv(),
    DEEPSEEK_BASE_URL: urlEnv('https://api.deepseek.com/v1'),
    DEEPSEEK_MODEL: stringEnv('deepseek-chat'),
    DEEPSEEK_SEARCH_PARAMS_JSON: jsonObjectEnv({ web_search: true }),

    // Domestic 3: Tongyi
    TONGYI_API_KEY: optionalSecretEnv(),
    TONGYI_BASE_URL: urlEnv('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    TONGYI_MODEL: stringEnv('qwen-plus'),
    TONGYI_SEARCH_STRATEGY: stringEnv('standard'),

    // Domestic 4: Zhipu
    ZHIPU_API_KEY: optionalSecretEnv(),
    ZHIPU_BASE_URL: urlEnv('https://open.bigmodel.cn/api/paas/v4'),
    ZHIPU_MODEL: stringEnv('glm-4-plus'),
    ZHIPU_SEARCH_ENGINE: stringEnv('search_pro'),

    // Domestic 5: Wenxin
    WENXIN_API_KEY: optionalSecretEnv(),
    WENXIN_BASE_URL: urlEnv('https://qianfan.baidubce.com/v2'),
    WENXIN_MODEL: stringEnv('ernie-4.5-turbo-128k'),

    // Overseas: DataForSEO
    DATAFORSEO_LOGIN: optionalSecretEnv(),
    DATAFORSEO_PASSWORD: optionalSecretEnv(),
    DATAFORSEO_BASE_URL: urlEnv('https://api.dataforseo.com'),
    DATAFORSEO_LOCATION_CODE: intEnv(1, 2_147_483_647, 2840),
    DATAFORSEO_LANGUAGE_CODE: stringEnv('en'),
    DATAFORSEO_COUNTRY_ISO: stringEnv('US'),
    DATAFORSEO_PERPLEXITY_MODEL: stringEnv('sonar'),
    DATAFORSEO_CLAUDE_MODEL: stringEnv('claude-sonnet-4-5'),
    DATAFORSEO_GEMINI_MODE: z.preprocess(
      emptyToUndefined,
      z.enum(['scraper', 'responses']).default('scraper'),
    ),
    DATAFORSEO_GEMINI_MODEL: stringEnv('gemini-2.5-flash'),
    DATAFORSEO_GEMINI_ENDPOINT: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),

    // Overseas: OpenAI-Compatible Relay (NewAPI / SubAPI / OpenRouter / etc.)
    OVERSEAS_PROVIDER: z.preprocess(
      emptyToUndefined,
      z.enum(['auto', 'dataforseo', 'openai_compat']).default('auto'),
    ),
    OVERSEAS_RELAY_BASE_URL: optionalUrlEnv(),
    OVERSEAS_RELAY_API_KEY: optionalSecretEnv(),

    CHATGPT_PROVIDER: optionalProviderEnv(),
    CHATGPT_BASE_URL: optionalUrlEnv(),
    CHATGPT_API_KEY: optionalSecretEnv(),
    CHATGPT_MODEL: stringEnv('gpt-4o-search-preview'),
    CHATGPT_EXTRA_BODY_JSON: jsonObjectEnv({}),

    PERPLEXITY_PROVIDER: optionalProviderEnv(),
    PERPLEXITY_BASE_URL: optionalUrlEnv(),
    PERPLEXITY_API_KEY: optionalSecretEnv(),
    PERPLEXITY_MODEL: stringEnv('sonar-pro'),
    PERPLEXITY_EXTRA_BODY_JSON: jsonObjectEnv({}),

    GEMINI_PROVIDER: optionalProviderEnv(),
    GEMINI_BASE_URL: optionalUrlEnv(),
    GEMINI_API_KEY: optionalSecretEnv(),
    GEMINI_MODEL: stringEnv('gemini-2.5-flash'),
    GEMINI_EXTRA_BODY_JSON: jsonObjectEnv({}),

    CLAUDE_PROVIDER: optionalProviderEnv(),
    CLAUDE_BASE_URL: optionalUrlEnv(),
    CLAUDE_API_KEY: optionalSecretEnv(),
    CLAUDE_MODEL: stringEnv('claude-sonnet-4-5'),
    CLAUDE_EXTRA_BODY_JSON: jsonObjectEnv({}),

    // TODO: google_aio defaults to the Gemini model as an openai_compat placeholder until a dedicated SERP/AIO provider is added.
    GOOGLE_AIO_PROVIDER: optionalProviderEnv(),
    GOOGLE_AIO_BASE_URL: optionalUrlEnv(),
    GOOGLE_AIO_API_KEY: optionalSecretEnv(),
    GOOGLE_AIO_MODEL: optionalSecretEnv(),
    GOOGLE_AIO_EXTRA_BODY_JSON: jsonObjectEnv({}),
  })
  .superRefine((data, ctx) => {
    const parsedKeys = parseGatewayApiKeys(data.GATEWAY_API_KEYS, data.GATEWAY_API_KEY);
    if (parsedKeys.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GATEWAY_API_KEYS'],
        message:
          'At least one non-empty API key must be configured via GATEWAY_API_KEYS (or GATEWAY_API_KEY)',
      });
    }
  });

function parseGatewayApiKeys(rawKeys?: string, rawSingle?: string): string[] {
  const fromList = (rawKeys ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  if (fromList.length > 0) {
    return Array.from(new Set(fromList));
  }

  const single = rawSingle?.trim();
  if (single && single.length > 0) {
    return [single];
  }

  return [];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = rawEnvSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : 'env';
        return `- ${path}: ${issue.message}`;
      })
      .join('\n');
    throw new Error(`Invalid SonarGate configuration:\n${details}`);
  }

  const data = result.data;
  const gatewayApiKeys = parseGatewayApiKeys(data.GATEWAY_API_KEYS, data.GATEWAY_API_KEY);

  return {
    server: {
      host: data.HOST,
      port: data.PORT,
      nodeEnv: data.NODE_ENV,
      logLevel: data.LOG_LEVEL,
    },
    auth: {
      gatewayApiKeys,
    },
    budget: {
      gatewayRequestTimeoutMs: data.GATEWAY_REQUEST_TIMEOUT_MS,
      domesticTimeoutMs: data.DOMESTIC_TIMEOUT_MS,
      overseasTimeoutMs: data.OVERSEAS_TIMEOUT_MS,
      maxUpstreamRetries: data.MAX_UPSTREAM_RETRIES,
      retryBaseDelayMs: data.RETRY_BASE_DELAY_MS,
      semaphoreWaitMs: data.SEMAPHORE_WAIT_MS,
      domesticConcurrencyPerEngine: data.DOMESTIC_CONCURRENCY_PER_ENGINE,
      dataforseoConcurrency: data.DATAFORSEO_CONCURRENCY,
    },
    cache: {
      ttlSeconds: data.CACHE_TTL_SECONDS,
      maxEntries: data.CACHE_MAX_ENTRIES,
    },
    domestic: {
      doubao: {
        apiKey: data.DOUBAO_API_KEY,
        baseUrl: data.DOUBAO_BASE_URL,
        model: data.DOUBAO_MODEL,
        extraBody: data.DOUBAO_EXTRA_BODY_JSON,
      },
      deepseek: {
        apiKey: data.DEEPSEEK_API_KEY,
        baseUrl: data.DEEPSEEK_BASE_URL,
        model: data.DEEPSEEK_MODEL,
        searchParams: data.DEEPSEEK_SEARCH_PARAMS_JSON,
      },
      tongyi: {
        apiKey: data.TONGYI_API_KEY,
        baseUrl: data.TONGYI_BASE_URL,
        model: data.TONGYI_MODEL,
        searchStrategy: data.TONGYI_SEARCH_STRATEGY,
      },
      zhipu: {
        apiKey: data.ZHIPU_API_KEY,
        baseUrl: data.ZHIPU_BASE_URL,
        model: data.ZHIPU_MODEL,
        searchEngine: data.ZHIPU_SEARCH_ENGINE,
      },
      wenxin: {
        apiKey: data.WENXIN_API_KEY,
        baseUrl: data.WENXIN_BASE_URL,
        model: data.WENXIN_MODEL,
      },
    },
    overseas: {
      dataforseo: {
        login: data.DATAFORSEO_LOGIN,
        password: data.DATAFORSEO_PASSWORD,
        baseUrl: data.DATAFORSEO_BASE_URL,
        locationCode: data.DATAFORSEO_LOCATION_CODE,
        languageCode: data.DATAFORSEO_LANGUAGE_CODE,
        countryIso: data.DATAFORSEO_COUNTRY_ISO,
        perplexityModel: data.DATAFORSEO_PERPLEXITY_MODEL,
        claudeModel: data.DATAFORSEO_CLAUDE_MODEL,
        geminiMode: data.DATAFORSEO_GEMINI_MODE,
        geminiModel: data.DATAFORSEO_GEMINI_MODEL,
        ...(data.DATAFORSEO_GEMINI_ENDPOINT !== undefined
          ? { geminiEndpoint: data.DATAFORSEO_GEMINI_ENDPOINT }
          : {}),
      },
      relay: {
        defaultProvider: data.OVERSEAS_PROVIDER,
        baseUrl: data.OVERSEAS_RELAY_BASE_URL,
        apiKey: data.OVERSEAS_RELAY_API_KEY,
      },
      engines: {
        chatgpt: {
          provider: data.CHATGPT_PROVIDER ?? data.OVERSEAS_PROVIDER,
          baseUrl: data.CHATGPT_BASE_URL || data.OVERSEAS_RELAY_BASE_URL,
          apiKey: data.CHATGPT_API_KEY || data.OVERSEAS_RELAY_API_KEY,
          model: data.CHATGPT_MODEL,
          extraBody: data.CHATGPT_EXTRA_BODY_JSON,
        },
        perplexity: {
          provider: data.PERPLEXITY_PROVIDER ?? data.OVERSEAS_PROVIDER,
          baseUrl: data.PERPLEXITY_BASE_URL || data.OVERSEAS_RELAY_BASE_URL,
          apiKey: data.PERPLEXITY_API_KEY || data.OVERSEAS_RELAY_API_KEY,
          model: data.PERPLEXITY_MODEL,
          extraBody: data.PERPLEXITY_EXTRA_BODY_JSON,
        },
        gemini: {
          provider: data.GEMINI_PROVIDER ?? data.OVERSEAS_PROVIDER,
          baseUrl: data.GEMINI_BASE_URL || data.OVERSEAS_RELAY_BASE_URL,
          apiKey: data.GEMINI_API_KEY || data.OVERSEAS_RELAY_API_KEY,
          model: data.GEMINI_MODEL,
          extraBody: data.GEMINI_EXTRA_BODY_JSON,
        },
        claude: {
          provider: data.CLAUDE_PROVIDER ?? data.OVERSEAS_PROVIDER,
          baseUrl: data.CLAUDE_BASE_URL || data.OVERSEAS_RELAY_BASE_URL,
          apiKey: data.CLAUDE_API_KEY || data.OVERSEAS_RELAY_API_KEY,
          model: data.CLAUDE_MODEL,
          extraBody: data.CLAUDE_EXTRA_BODY_JSON,
        },
        // TODO: google_aio uses the Gemini openai_compat config as a placeholder until a dedicated SERP/AIO provider is added.
        google_aio: {
          provider: data.GOOGLE_AIO_PROVIDER ?? data.OVERSEAS_PROVIDER,
          baseUrl: data.GOOGLE_AIO_BASE_URL || data.GEMINI_BASE_URL || data.OVERSEAS_RELAY_BASE_URL,
          apiKey: data.GOOGLE_AIO_API_KEY || data.GEMINI_API_KEY || data.OVERSEAS_RELAY_API_KEY,
          model: data.GOOGLE_AIO_MODEL || data.GEMINI_MODEL,
          extraBody:
            Object.keys(data.GOOGLE_AIO_EXTRA_BODY_JSON).length > 0
              ? data.GOOGLE_AIO_EXTRA_BODY_JSON
              : data.GEMINI_EXTRA_BODY_JSON,
        },
      },
    },
  };
}
