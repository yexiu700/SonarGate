import { MockAgent } from 'undici';
import type { Interceptable } from 'undici';
import { SUPPORTED_ENGINES } from './geomix-schema.js';
import type { SupportedEngine } from './geomix-schema.js';

export type UndiciMockScope = ReturnType<ReturnType<Interceptable['intercept']>['replyWithError']>;

export interface UpstreamRequestCallbackOptions {
  path: string;
  method: string;
  headers?: unknown;
  origin?: string;
  body?: unknown;
}

export type UpstreamRouteKey = SupportedEngine | 'gemini_responses';

export interface UpstreamRoute {
  readonly origin: string;
  readonly path: string;
  readonly method: 'POST';
}

export const UPSTREAM_ROUTES: Record<UpstreamRouteKey, UpstreamRoute> = {
  doubao: {
    origin: 'https://ark.cn-beijing.volces.com',
    path: '/api/v3/responses',
    method: 'POST',
  },
  deepseek: {
    origin: 'https://api.deepseek.com',
    path: '/v1/chat/completions',
    method: 'POST',
  },
  tongyi: {
    origin: 'https://dashscope.aliyuncs.com',
    path: '/compatible-mode/v1/chat/completions',
    method: 'POST',
  },
  zhipu: {
    origin: 'https://open.bigmodel.cn',
    path: '/api/paas/v4/chat/completions',
    method: 'POST',
  },
  wenxin: {
    origin: 'https://qianfan.baidubce.com',
    path: '/v2/chat/completions',
    method: 'POST',
  },
  yuanbao: {
    origin: 'https://api.hunyuan.cloud.tencent.com',
    path: '/v1/chat/completions',
    method: 'POST',
  },
  kimi: {
    origin: 'https://api.moonshot.cn',
    path: '/v1/chat/completions',
    method: 'POST',
  },
  chatgpt: {
    origin: 'https://api.dataforseo.com',
    path: '/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced',
    method: 'POST',
  },
  perplexity: {
    origin: 'https://api.dataforseo.com',
    path: '/v3/ai_optimization/perplexity/llm_responses/live',
    method: 'POST',
  },
  gemini: {
    origin: 'https://api.dataforseo.com',
    path: '/v3/ai_optimization/gemini/llm_scraper/live/advanced',
    method: 'POST',
  },
  gemini_responses: {
    origin: 'https://api.dataforseo.com',
    path: '/v3/ai_optimization/gemini/llm_responses/live',
    method: 'POST',
  },
  claude: {
    origin: 'https://api.dataforseo.com',
    path: '/v3/ai_optimization/claude/llm_responses/live',
    method: 'POST',
  },
  google_aio: {
    origin: 'https://api.dataforseo.com',
    path: '/v3/serp/google/organic/live/advanced',
    method: 'POST',
  },
};

export interface MockCitationInput {
  url: string;
  title?: string;
  snippet?: string;
}

export interface UpstreamPayloadOverrides {
  answerText?: string;
  citations?: MockCitationInput[];
  fanOutQueries?: string[];
  upstreamRequestId?: string;
  costUsd?: number;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  reasoningContent?: string;
}

export type GeminiMode = 'scraper' | 'responses';

export interface MockEngineOptions {
  delayMs?: number;
  times?: number;
  persist?: boolean;
  geminiMode?: GeminiMode;
  onRequest?: (opts: UpstreamRequestCallbackOptions) => void;
}

export interface MockEngineReplyOptions extends MockEngineOptions {
  headers?: Record<string, string>;
}

export interface MockEngineErrorOptions {
  times?: number;
  geminiMode?: GeminiMode;
}

export interface CapturedUpstreamRequest {
  engine: SupportedEngine;
  routeKey: UpstreamRouteKey;
  origin: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  rawBody: string | undefined;
  jsonBody: unknown;
}

function resolveRouteKey(engine: SupportedEngine, geminiMode?: GeminiMode): UpstreamRouteKey {
  if (engine === 'gemini' && geminiMode === 'responses') {
    return 'gemini_responses';
  }
  return engine;
}

interface RouteLookupEntry {
  readonly engine: SupportedEngine;
  readonly routeKey: UpstreamRouteKey;
  readonly route: UpstreamRoute;
}

const ROUTE_LOOKUP = new Map<string, RouteLookupEntry>(
  (Object.entries(UPSTREAM_ROUTES) as [UpstreamRouteKey, UpstreamRoute][]).map(
    ([routeKey, route]) => {
      const engine: SupportedEngine = routeKey === 'gemini_responses' ? 'gemini' : routeKey;
      return [`${route.origin}|${route.path}|${route.method}`, { engine, routeKey, route }];
    },
  ),
);

export function buildDoubaoPayload(overrides?: UpstreamPayloadOverrides): Record<string, unknown> {
  const citations = overrides?.citations ?? [
    {
      url: 'https://doubao.example.com/crm-guide',
      title: '豆包 CRM 选型指南',
      snippet: '面向中小企业的 2026 年 CRM 对比评测摘要。',
    },
    {
      url: 'https://doubao.example.com/crm-pricing',
      title: '豆包 CRM 价格参考',
      snippet: '主流云端 CRM 订阅方案分析。',
    },
  ];

  const fanOutQueries = overrides?.fanOutQueries ?? ['2026 中小企业 CRM 推荐', '云端 CRM 选型对比'];
  const firstQuery = fanOutQueries[0] ?? '2026 CRM 选型';

  return {
    id: overrides?.upstreamRequestId ?? 'resp_doubao_e2e_001',
    model: overrides?.model ?? 'ep-e2e-doubao-test',
    output: [
      {
        type: 'web_search_call',
        action: {
          query: firstQuery,
          queries: fanOutQueries,
        },
      },
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text:
              overrides?.answerText ??
              '豆包联网搜索结果表明，2026 年中小企业选择 CRM 时应重点关注销售自动化、微信生态集成和性价比。',
            annotations: citations.map((c) => ({
              type: 'url_citation',
              url: c.url,
              ...(c.title !== undefined ? { title: c.title } : {}),
              ...(c.snippet !== undefined ? { summary: c.snippet } : {}),
            })),
          },
        ],
      },
    ],
    usage: {
      input_tokens: overrides?.tokensIn ?? 112,
      output_tokens: overrides?.tokensOut ?? 264,
    },
  };
}

export function buildDeepseekPayload(
  overrides?: UpstreamPayloadOverrides,
): Record<string, unknown> {
  const citations = overrides?.citations ?? [
    {
      url: 'https://deepseek.example.com/report-1',
      title: 'DeepSeek 行业评测 1',
      snippet: 'DeepSeek 联网检索摘要 1。',
    },
    {
      url: 'https://deepseek.example.com/report-2',
      title: 'DeepSeek 行业评测 2',
      snippet: 'DeepSeek 联网检索摘要 2。',
    },
  ];
  const fanOutQueries = overrides?.fanOutQueries ?? ['DeepSeek CRM 评测', '企业级 SaaS 对比'];

  return {
    id: overrides?.upstreamRequestId ?? 'chatcmpl_deepseek_e2e_001',
    model: overrides?.model ?? 'deepseek-chat',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content:
            overrides?.answerText ??
            'DeepSeek 联网回答：企业在选型 CRM 时建议优先评估 API 开放能力与移动端体验。',
          reasoning_content:
            overrides?.reasoningContent ??
            '内部思维链：先比较厂商定价再总结优缺点，此内容绝对不可出现在 answerText 中。',
          annotations: citations.map((c) => ({
            url: c.url,
            ...(c.title !== undefined ? { title: c.title } : {}),
            ...(c.snippet !== undefined ? { snippet: c.snippet } : {}),
          })),
          search_queries: fanOutQueries,
        },
      },
    ],
    citations: [],
    search_queries: fanOutQueries,
    usage: {
      prompt_tokens: overrides?.tokensIn ?? 88,
      completion_tokens: overrides?.tokensOut ?? 205,
    },
  };
}

export function buildTongyiPayload(overrides?: UpstreamPayloadOverrides): Record<string, unknown> {
  const citations = overrides?.citations ?? [
    {
      url: 'https://tongyi.example.com/article-1',
      title: '通义千问来源 1',
      snippet: '通义联网检索摘要 1。',
    },
    {
      url: 'https://tongyi.example.com/article-2',
      title: '通义千问来源 2',
    },
  ];
  const fanOutQueries = overrides?.fanOutQueries ?? ['通义千问 CRM 对比'];

  return {
    id: overrides?.upstreamRequestId ?? 'chatcmpl_tongyi_e2e_001',
    model: overrides?.model ?? 'qwen-plus',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content:
            overrides?.answerText ??
            '通义千问联网回答：结合企业规模与线索流转需求，可优先考虑支持钉钉与企微互通的方案。',
        },
      },
    ],
    search_info: {
      search_results: citations.map((c, idx) => ({
        url: c.url,
        ...(c.title !== undefined ? { title: c.title } : {}),
        ...(c.snippet !== undefined
          ? { snippet: c.snippet }
          : { site_name: `通义站点 ${idx + 1}` }),
      })),
      search_queries: fanOutQueries,
    },
    usage: {
      prompt_tokens: overrides?.tokensIn ?? 76,
      completion_tokens: overrides?.tokensOut ?? 182,
    },
  };
}

export function buildZhipuPayload(overrides?: UpstreamPayloadOverrides): Record<string, unknown> {
  const citations = overrides?.citations ?? [
    {
      url: 'https://zhipu.example.com/review-1',
      title: '智谱清言来源 1',
      snippet: '智谱联网检索摘要 1。',
    },
  ];
  const fanOutQueries = overrides?.fanOutQueries ?? ['智谱 CRM 方案'];

  return {
    id: overrides?.upstreamRequestId ?? 'zhipu_e2e_001',
    model: overrides?.model ?? 'glm-4-plus',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content:
            overrides?.answerText ??
            '智谱 GLM 联网回答：建议从客户生命周期管理、报表分析和实施成本三个维度进行评估。',
        },
      },
    ],
    web_search: citations.map((c) => ({
      link: c.url,
      ...(c.title !== undefined ? { title: c.title } : {}),
      ...(c.snippet !== undefined ? { content: c.snippet } : {}),
    })),
    search_intent: fanOutQueries.map((q) => ({
      query: q,
      keywords: q,
    })),
    usage: {
      prompt_tokens: overrides?.tokensIn ?? 94,
      completion_tokens: overrides?.tokensOut ?? 175,
    },
  };
}

export function buildWenxinPayload(overrides?: UpstreamPayloadOverrides): Record<string, unknown> {
  const citations = overrides?.citations ?? [
    {
      url: 'https://wenxin.example.com/doc-1',
      title: '文心一言参考 1',
      snippet: '百度千帆联网检索摘要 1。',
    },
  ];
  const fanOutQueries = overrides?.fanOutQueries ?? ['文心一言 CRM 选型'];

  return {
    id: overrides?.upstreamRequestId ?? 'as_wenxin_e2e_001',
    model: overrides?.model ?? 'ernie-4.5-turbo-128k',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content:
            overrides?.answerText ??
            '文心一言联网回答：中小企业引入 CRM 系统时应重视数据迁移与权限隔离机制。',
        },
      },
    ],
    search_results: citations.map((c) => ({
      url: c.url,
      ...(c.title !== undefined ? { title: c.title } : {}),
      ...(c.snippet !== undefined ? { content: c.snippet } : {}),
    })),
    search_queries: fanOutQueries,
    usage: {
      prompt_tokens: overrides?.tokensIn ?? 65,
      completion_tokens: overrides?.tokensOut ?? 160,
    },
  };
}

export function buildYuanbaoPayload(
  overrides?: UpstreamPayloadOverrides,
): Record<string, unknown> {
  const citations = overrides?.citations ?? [
    {
      url: 'https://mp.weixin.qq.com/s/yuanbao-e2e-1',
      title: '腾讯元宝参考 1',
      snippet: '微信生态与搜狗检索摘要 1。',
    },
  ];
  const fanOutQueries = overrides?.fanOutQueries ?? ['腾讯元宝 CRM 推荐'];

  return {
    id: overrides?.upstreamRequestId ?? 'hunyuan_yuanbao_e2e_001',
    model: overrides?.model ?? 'hunyuan-turbos-latest',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content:
            overrides?.answerText ??
            '腾讯元宝联网回答：建议结合企业微信生态打通能力与客户留存转化报表综合选型。',
        },
        finish_reason: 'stop',
      },
    ],
    search_info: {
      search_results: citations.map((c, idx) => ({
        index: idx + 1,
        url: c.url,
        ...(c.title !== undefined ? { title: c.title } : {}),
        ...(c.snippet !== undefined ? { text: c.snippet } : { site_name: '微信公众号' }),
      })),
      search_queries: fanOutQueries,
    },
    usage: {
      prompt_tokens: overrides?.tokensIn ?? 82,
      completion_tokens: overrides?.tokensOut ?? 190,
    },
  };
}

export function buildKimiPayload(overrides?: UpstreamPayloadOverrides): Record<string, unknown> {
  const citations = overrides?.citations ?? [
    {
      url: 'https://kimi.example.com/crm-guide-1',
      title: 'Kimi 联网参考 1',
      snippet: 'Moonshot Kimi 联网检索摘要 1。',
    },
  ];
  const fanOutQueries = overrides?.fanOutQueries ?? ['Kimi 中小企业 CRM 评测'];

  return {
    id: overrides?.upstreamRequestId ?? 'cmpl_kimi_e2e_001',
    model: overrides?.model ?? 'moonshot-v1-auto',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content:
            overrides?.answerText ??
            'Kimi 联网回答：2026 年中小企业选型 CRM 可重点关注自动化线索流转、移动端易用性与按席位成本。',
        },
        finish_reason: 'stop',
      },
    ],
    search_results: citations.map((c) => ({
      url: c.url,
      ...(c.title !== undefined ? { title: c.title } : {}),
      ...(c.snippet !== undefined ? { snippet: c.snippet } : {}),
    })),
    search_queries: fanOutQueries,
    usage: {
      prompt_tokens: overrides?.tokensIn ?? 91,
      completion_tokens: overrides?.tokensOut ?? 215,
    },
  };
}

export function buildDataForSeoEnvelope(
  result: Record<string, unknown>,
  overrides?: { costUsd?: number; upstreamRequestId?: string },
): Record<string, unknown> {
  const cost = overrides?.costUsd ?? 0.015;
  return {
    version: '0.1.20260101',
    status_code: 20000,
    status_message: 'Ok.',
    time: '0.42 sec.',
    cost,
    tasks_count: 1,
    tasks_error: 0,
    tasks: [
      {
        id: overrides?.upstreamRequestId ?? 'dfs-task-e2e-001',
        status_code: 20000,
        status_message: 'Ok.',
        time: '0.41 sec.',
        cost,
        result_count: 1,
        result: [result],
      },
    ],
  };
}

export function buildDataForSeoTopLevelErrorPayload(
  statusCode: number,
  statusMessage = 'DataForSEO top-level error.',
): Record<string, unknown> {
  return {
    version: '0.1.20260101',
    status_code: statusCode,
    status_message: statusMessage,
    time: '0.05 sec.',
    cost: 0,
    tasks_count: 0,
    tasks_error: 0,
    tasks: [],
  };
}

export function buildDataForSeoTaskErrorPayload(
  statusCode: number,
  statusMessage = 'DataForSEO task-level error.',
  taskId = 'dfs-task-err-001',
): Record<string, unknown> {
  return {
    version: '0.1.20260101',
    status_code: 20000,
    status_message: 'Ok.',
    time: '0.08 sec.',
    cost: 0,
    tasks_count: 1,
    tasks_error: 1,
    tasks: [
      {
        id: taskId,
        status_code: statusCode,
        status_message: statusMessage,
        time: '0.07 sec.',
        cost: 0,
        result_count: 0,
        result: null,
      },
    ],
  };
}

export function buildChatGptPayload(overrides?: UpstreamPayloadOverrides): Record<string, unknown> {
  const citations = overrides?.citations ?? [
    {
      url: 'https://chatgpt-src.example.com/best-crm',
      title: 'Best CRM Software 2026',
      snippet: 'Comprehensive review of top SMB CRM platforms.',
    },
  ];
  const fanOutQueries = overrides?.fanOutQueries ?? ['best crm software for smb 2026'];

  return buildDataForSeoEnvelope(
    {
      markdown:
        overrides?.answerText ??
        'Top CRM tools for small businesses in 2026 include HubSpot, Pipedrive, and Zoho CRM, offering strong automation and transparent pricing.',
      sources: citations.map((c) => ({
        url: c.url,
        ...(c.title !== undefined ? { title: c.title } : {}),
        ...(c.snippet !== undefined ? { snippet: c.snippet } : {}),
      })),
      search_results: [],
      fan_out_queries: fanOutQueries,
    },
    {
      costUsd: overrides?.costUsd ?? 0.02,
      upstreamRequestId: overrides?.upstreamRequestId ?? 'dfs-chatgpt-e2e-001',
    },
  );
}

export function buildPerplexityPayload(
  overrides?: UpstreamPayloadOverrides,
): Record<string, unknown> {
  const citations = overrides?.citations ?? [
    {
      url: 'https://perplexity-src.example.com/crm-comparison',
      title: 'CRM Comparison Report',
      snippet: 'Independent benchmark of cloud CRM platforms.',
    },
  ];

  return buildDataForSeoEnvelope(
    {
      model_name: overrides?.model ?? 'sonar',
      input_tokens: overrides?.tokensIn ?? 95,
      output_tokens: overrides?.tokensOut ?? 210,
      items: [
        {
          type: 'message',
          sections: [
            {
              text:
                overrides?.answerText ??
                'Perplexity analysis highlights HubSpot and Salesforce Starter as leading CRM choices for growing teams.',
              annotations: citations.map((c) => ({
                url: c.url,
                ...(c.title !== undefined ? { title: c.title } : {}),
                ...(c.snippet !== undefined ? { snippet: c.snippet } : {}),
              })),
            },
          ],
        },
      ],
      sources: citations.map((c) => ({
        url: c.url,
        ...(c.title !== undefined ? { title: c.title } : {}),
        ...(c.snippet !== undefined ? { snippet: c.snippet } : {}),
      })),
      ...(overrides?.fanOutQueries !== undefined
        ? { fan_out_queries: overrides.fanOutQueries }
        : {}),
    },
    {
      costUsd: overrides?.costUsd ?? 0.012,
      upstreamRequestId: overrides?.upstreamRequestId ?? 'dfs-perplexity-e2e-001',
    },
  );
}

export function buildGeminiScraperPayload(
  overrides?: UpstreamPayloadOverrides,
): Record<string, unknown> {
  const citations = overrides?.citations ?? [
    {
      url: 'https://gemini-src.example.com/crm-guide',
      title: 'Gemini CRM Overview',
      snippet: 'Overview of AI-assisted CRM suites.',
    },
  ];
  const fanOutQueries = overrides?.fanOutQueries ?? ['ai crm software comparison 2026'];

  return buildDataForSeoEnvelope(
    {
      markdown:
        overrides?.answerText ??
        'Gemini scraper response: Modern CRM platforms combine pipeline tracking, email sync, and AI-powered forecasting.',
      sources: citations.map((c) => ({
        url: c.url,
        ...(c.title !== undefined ? { title: c.title } : {}),
        ...(c.snippet !== undefined ? { snippet: c.snippet } : {}),
      })),
      fan_out_queries: fanOutQueries,
    },
    {
      costUsd: overrides?.costUsd ?? 0.018,
      upstreamRequestId: overrides?.upstreamRequestId ?? 'dfs-gemini-scraper-e2e-001',
    },
  );
}

export function buildGeminiResponsesPayload(
  overrides?: UpstreamPayloadOverrides,
): Record<string, unknown> {
  const citations = overrides?.citations ?? [
    {
      url: 'https://gemini-resp.example.com/crm-guide',
      title: 'Gemini Responses CRM Guide',
      snippet: 'Detailed CRM evaluation via Gemini responses API.',
    },
  ];

  return buildDataForSeoEnvelope(
    {
      model_name: overrides?.model ?? 'gemini-2.5-flash',
      input_tokens: overrides?.tokensIn ?? 85,
      output_tokens: overrides?.tokensOut ?? 195,
      items: [
        {
          type: 'message',
          sections: [
            {
              text:
                overrides?.answerText ??
                'Gemini responses mode: Prioritize CRM tools with native workflow automation and clean data governance.',
              annotations: citations.map((c) => ({
                url: c.url,
                ...(c.title !== undefined ? { title: c.title } : {}),
                ...(c.snippet !== undefined ? { snippet: c.snippet } : {}),
              })),
            },
          ],
        },
      ],
      sources: citations.map((c) => ({
        url: c.url,
        ...(c.title !== undefined ? { title: c.title } : {}),
        ...(c.snippet !== undefined ? { snippet: c.snippet } : {}),
      })),
    },
    {
      costUsd: overrides?.costUsd ?? 0.014,
      upstreamRequestId: overrides?.upstreamRequestId ?? 'dfs-gemini-responses-e2e-001',
    },
  );
}

export function buildClaudePayload(overrides?: UpstreamPayloadOverrides): Record<string, unknown> {
  const citations = overrides?.citations ?? [
    {
      url: 'https://claude-src.example.com/crm-analysis',
      title: 'Claude CRM Market Analysis',
      snippet: 'Analysis of B2B CRM adoption and retention.',
    },
  ];

  return buildDataForSeoEnvelope(
    {
      model_name: overrides?.model ?? 'claude-sonnet-4-5',
      input_tokens: overrides?.tokensIn ?? 102,
      output_tokens: overrides?.tokensOut ?? 230,
      items: [
        {
          type: 'message',
          sections: [
            {
              text:
                overrides?.answerText ??
                'Claude analysis: Effective CRM adoption depends on clean contact hygiene, clear pipeline stages, and reliable integrations.',
              annotations: citations.map((c) => ({
                url: c.url,
                ...(c.title !== undefined ? { title: c.title } : {}),
                ...(c.snippet !== undefined ? { snippet: c.snippet } : {}),
              })),
            },
          ],
        },
      ],
    },
    {
      costUsd: overrides?.costUsd ?? 0.025,
      upstreamRequestId: overrides?.upstreamRequestId ?? 'dfs-claude-e2e-001',
    },
  );
}

export function buildGoogleAioPayload(
  overrides?: UpstreamPayloadOverrides,
): Record<string, unknown> {
  const citations = overrides?.citations ?? [
    {
      url: 'https://aio-src.example.com/crm-summary',
      title: 'Google AIO CRM Summary',
      snippet: 'Key factors in choosing an SMB CRM.',
    },
  ];

  return buildDataForSeoEnvelope(
    {
      items: [
        {
          type: 'ai_overview',
          markdown:
            overrides?.answerText ??
            'Google AI Overview: Leading SMB CRM platforms offer contact management, deal pipelines, and automated follow-ups.',
          references: citations.map((c) => ({
            url: c.url,
            ...(c.title !== undefined ? { title: c.title } : {}),
            ...(c.snippet !== undefined ? { text: c.snippet } : {}),
          })),
        },
        {
          type: 'organic',
          rank_group: 1,
          url: 'https://organic.example.com/crm-list',
          title: 'Organic CRM Directory',
          description: 'Standard organic search listing.',
        },
      ],
    },
    {
      costUsd: overrides?.costUsd ?? 0.01,
      upstreamRequestId: overrides?.upstreamRequestId ?? 'dfs-google-aio-e2e-001',
    },
  );
}

export function buildGoogleAioNoAioPayload(overrides?: {
  costUsd?: number;
  upstreamRequestId?: string;
}): Record<string, unknown> {
  return buildDataForSeoEnvelope(
    {
      items: [
        {
          type: 'organic',
          rank_group: 1,
          url: 'https://organic.example.com/result-1',
          title: 'Standard Organic Result 1',
          description: 'No AI Overview was triggered for this search query.',
        },
        {
          type: 'organic',
          rank_group: 2,
          url: 'https://organic.example.com/result-2',
          title: 'Standard Organic Result 2',
          description: 'Another organic SERP listing.',
        },
      ],
    },
    {
      costUsd: overrides?.costUsd ?? 0.01,
      upstreamRequestId: overrides?.upstreamRequestId ?? 'dfs-google-no-aio-e2e-001',
    },
  );
}

export function buildUpstreamPayload(
  engine: SupportedEngine,
  overrides?: UpstreamPayloadOverrides,
  options?: { geminiMode?: GeminiMode },
): Record<string, unknown> {
  switch (engine) {
    case 'doubao':
      return buildDoubaoPayload(overrides);
    case 'deepseek':
      return buildDeepseekPayload(overrides);
    case 'tongyi':
      return buildTongyiPayload(overrides);
    case 'zhipu':
      return buildZhipuPayload(overrides);
    case 'wenxin':
      return buildWenxinPayload(overrides);
    case 'yuanbao':
      return buildYuanbaoPayload(overrides);
    case 'kimi':
      return buildKimiPayload(overrides);
    case 'chatgpt':
      return buildChatGptPayload(overrides);
    case 'perplexity':
      return buildPerplexityPayload(overrides);
    case 'gemini':
      return options?.geminiMode === 'responses'
        ? buildGeminiResponsesPayload(overrides)
        : buildGeminiScraperPayload(overrides);
    case 'claude':
      return buildClaudePayload(overrides);
    case 'google_aio':
      return buildGoogleAioPayload(overrides);
  }
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers || typeof headers !== 'object') {
    return result;
  }
  if (typeof (headers as { forEach?: unknown }).forEach === 'function') {
    (headers as { forEach: (cb: (value: string, key: string) => void) => void }).forEach(
      (value, key) => {
        result[key.toLowerCase()] = value;
      },
    );
    return result;
  }
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) {
      const k = headers[i];
      const v = headers[i + 1];
      if (typeof k === 'string' && typeof v === 'string') {
        result[k.toLowerCase()] = v;
      }
    }
    return result;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === 'string') {
      result[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      result[key.toLowerCase()] = value.map(String).join(', ');
    }
  }
  return result;
}

function normalizeBody(body: unknown): { rawBody: string | undefined; jsonBody: unknown } {
  if (body === null || body === undefined) {
    return { rawBody: undefined, jsonBody: undefined };
  }
  let rawBody: string | undefined;
  if (typeof body === 'string') {
    rawBody = body;
  } else if (Buffer.isBuffer(body)) {
    rawBody = body.toString('utf8');
  } else if (body instanceof Uint8Array) {
    rawBody = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
  } else if (body instanceof ArrayBuffer) {
    rawBody = Buffer.from(body).toString('utf8');
  }

  if (rawBody === undefined) {
    return { rawBody: undefined, jsonBody: undefined };
  }

  try {
    return { rawBody, jsonBody: JSON.parse(rawBody) as unknown };
  } catch {
    return { rawBody, jsonBody: undefined };
  }
}

export class UpstreamMocker {
  readonly mockAgent: MockAgent;
  private readonly hitCounts = new Map<SupportedEngine, number>();
  private readonly capturedRequests = new Map<SupportedEngine, CapturedUpstreamRequest[]>();
  private readonly registeredNetworkErrors = new WeakSet<Error>();
  private closed = false;

  constructor() {
    this.mockAgent = new MockAgent();
    this.mockAgent.disableNetConnect();

    const originalDispatch = this.mockAgent.dispatch.bind(this.mockAgent);
    this.mockAgent.dispatch = (opts, handler) => {
      const origin = typeof opts.origin === 'string' ? opts.origin : opts.origin?.toString();
      const routeEntry =
        origin !== undefined
          ? ROUTE_LOOKUP.get(`${origin}|${opts.path}|${opts.method.toUpperCase()}`)
          : undefined;

      if (routeEntry !== undefined && typeof handler.onError === 'function') {
        const originalOnError = handler.onError.bind(handler);
        handler.onError = (err: Error) => {
          if (this.registeredNetworkErrors.has(err)) {
            this.recordHit(routeEntry.engine, routeEntry.routeKey, routeEntry.route, {
              path: opts.path,
              method: opts.method,
              headers: opts.headers,
              origin: routeEntry.route.origin,
              body: opts.body,
            });
          }
          return originalOnError(err);
        };
      }

      return originalDispatch(opts, handler);
    };
  }

  private recordHit(
    engine: SupportedEngine,
    routeKey: UpstreamRouteKey,
    route: UpstreamRoute,
    opts?: UpstreamRequestCallbackOptions,
  ): void {
    this.hitCounts.set(engine, (this.hitCounts.get(engine) ?? 0) + 1);
    const list = this.capturedRequests.get(engine) ?? [];
    const { rawBody, jsonBody } = normalizeBody(opts?.body);
    list.push({
      engine,
      routeKey,
      origin: opts?.origin ?? route.origin,
      path: opts?.path ?? route.path,
      method: opts?.method ?? route.method,
      headers: normalizeHeaders(opts?.headers),
      rawBody,
      jsonBody,
    });
    this.capturedRequests.set(engine, list);
  }

  private applyScopeModifiers(
    scope: UndiciMockScope,
    options?: { delayMs?: number; times?: number; persist?: boolean },
  ): UndiciMockScope {
    if (options?.delayMs !== undefined && options.delayMs > 0) {
      scope.delay(options.delayMs);
    }
    if (options?.persist === true) {
      scope.persist();
    } else if (options?.times !== undefined) {
      scope.times(options.times);
    }
    return scope;
  }

  mockEngineSuccess(
    engine: SupportedEngine,
    payload?: Record<string, unknown>,
    options?: MockEngineOptions,
  ): UndiciMockScope {
    const resolvedPayload =
      payload ??
      buildUpstreamPayload(
        engine,
        undefined,
        options?.geminiMode !== undefined ? { geminiMode: options.geminiMode } : undefined,
      );
    return this.mockEngineReply(engine, 200, resolvedPayload, options);
  }

  mockEngineReply(
    engine: SupportedEngine,
    statusCode: number,
    body: Record<string, unknown> | string | Buffer,
    options?: MockEngineReplyOptions,
  ): UndiciMockScope {
    const routeKey = resolveRouteKey(engine, options?.geminiMode);
    const route = UPSTREAM_ROUTES[routeKey];
    const pool = this.mockAgent.get(route.origin);

    const defaultHeaders: Record<string, string> =
      typeof body === 'string' || Buffer.isBuffer(body)
        ? {}
        : { 'content-type': 'application/json' };
    const responseHeaders: Record<string, string> = {
      ...defaultHeaders,
      ...(options?.headers ?? {}),
    };

    const scope = pool.intercept({ path: route.path, method: route.method }).reply((opts) => {
      this.recordHit(engine, routeKey, route, opts);
      options?.onRequest?.(opts);
      return {
        statusCode,
        data: body,
        responseOptions: {
          headers: responseHeaders,
        },
      };
    });

    return this.applyScopeModifiers(scope, options);
  }

  mockEngineNetworkError(
    engine: SupportedEngine,
    error: Error,
    options?: MockEngineErrorOptions,
  ): UndiciMockScope {
    const routeKey = resolveRouteKey(engine, options?.geminiMode);
    const route = UPSTREAM_ROUTES[routeKey];
    const pool = this.mockAgent.get(route.origin);

    this.registeredNetworkErrors.add(error);
    const scope = pool
      .intercept({
        path: route.path,
        method: route.method,
      })
      .replyWithError(error);

    return this.applyScopeModifiers(
      scope,
      options?.times !== undefined ? { times: options.times } : undefined,
    );
  }

  mockAllTenSuccess(options?: { delayMs?: number; persist?: boolean }): void {
    for (const engine of SUPPORTED_ENGINES) {
      this.mockEngineSuccess(engine, undefined, options);
    }
  }

  getHitCount(engine: SupportedEngine): number {
    return this.hitCounts.get(engine) ?? 0;
  }

  getTotalHits(): number {
    let total = 0;
    for (const count of this.hitCounts.values()) {
      total += count;
    }
    return total;
  }

  getCapturedRequests(engine?: SupportedEngine): readonly CapturedUpstreamRequest[] {
    if (engine !== undefined) {
      return [...(this.capturedRequests.get(engine) ?? [])];
    }
    const all: CapturedUpstreamRequest[] = [];
    for (const list of this.capturedRequests.values()) {
      all.push(...list);
    }
    return all;
  }

  resetCounts(): void {
    this.hitCounts.clear();
    this.capturedRequests.clear();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.mockAgent.close();
  }
}
