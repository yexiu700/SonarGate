import {
  engineNotConfiguredError,
  isGatewayError,
  upstreamBadResponseError,
  upstreamTimeoutError,
} from '../../core/errors.js';
import type { HttpClient, HttpStreamEvent } from '../../core/http-client.js';
import { defaultSleep } from '../../core/retry.js';
import type { AdapterResult, CollectContext, EngineAdapter, LoggerLike } from '../../core/types.js';
import {
  asNonEmptyString,
  asNonNegativeInt,
  asString,
  dedupeQueryStrings,
  extractStringQueries,
  isRecord,
  mergeCitations,
  shallowMergeRecord,
  trimTrailingSlashes,
} from '../shared/parsing.js';

export interface DoubaoConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  extraBody: Record<string, unknown>;
  /** Enables Volcengine Ark SSE streaming so phase timings (web_search, TTFT) and stall heartbeats are observed. */
  stream?: boolean | undefined;
  /** Optional channel-specific concurrency override (defaults to min(2, DOMESTIC_CONCURRENCY_PER_ENGINE)). */
  concurrency?: number | undefined;
  /** Optional per-attempt timeout override in ms (defaults to min(35000, DOMESTIC_TIMEOUT_MS)). */
  timeoutMs?: number | undefined;
  /** Fast-fail threshold waiting for HTTP headers / first chunk (ms). */
  firstByteTimeoutMs?: number | undefined;
  /** Fast-fail threshold for silence between stream chunks / heartbeats (ms). */
  idleTimeoutMs?: number | undefined;
  /** Optional minimum spacing between upstream dispatches on the Doubao channel (ms). */
  minIntervalMs?: number | undefined;
}

export interface DoubaoStageTimings {
  dispatchMs: number;
  webSearchMs?: number | undefined;
  ttftMs?: number | undefined;
  finishMs?: number | undefined;
  totalMs: number;
}

type DoubaoFailureStage =
  'pacing' | 'connect_dispatch' | 'web_search' | 'stream_ttft' | 'stream_body';

interface ParsedResponsesPayload {
  answerText: string;
  citations: ReturnType<typeof mergeCitations>;
  fanOutQueries: string[];
  responseModel?: string | undefined;
  upstreamRequestId?: string | undefined;
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
}

function extractQueriesFromWebSearchItem(item: Record<string, unknown>): string[] {
  const queries: string[] = [];
  const containers: Record<string, unknown>[] = [];
  if (isRecord(item['action'])) {
    containers.push(item['action']);
  }
  containers.push(item);

  for (const container of containers) {
    for (const key of ['query', 'queries', 'keywords', 'search_queries'] as const) {
      queries.push(...extractStringQueries(container[key]));
    }
  }
  return queries;
}

function parseResponsesObject(
  data: Record<string, unknown>,
  fallbackModel?: string,
): ParsedResponsesPayload {
  const textParts: string[] = [];
  const urlAnnotations: Record<string, unknown>[] = [];
  const extraCitationSources: unknown[] = [];
  const rawQueries: string[] = [];

  const output = data['output'];
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!isRecord(item)) {
        continue;
      }
      const itemType = item['type'];
      if (itemType === 'message' && Array.isArray(item['content'])) {
        for (const block of item['content']) {
          if (!isRecord(block) || block['type'] !== 'output_text') {
            continue;
          }
          const text = asString(block['text']);
          if (text !== undefined && text.length > 0) {
            textParts.push(text);
          }
          const annotations = block['annotations'];
          if (Array.isArray(annotations)) {
            for (const ann of annotations) {
              if (isRecord(ann) && (ann['type'] === 'url_citation' || ann['url'] !== undefined)) {
                urlAnnotations.push(ann);
              }
            }
          }
        }
      } else if (itemType === 'web_search_call') {
        rawQueries.push(...extractQueriesFromWebSearchItem(item));
        if (isRecord(item['action']) && Array.isArray(item['action']['sources'])) {
          extraCitationSources.push(item['action']['sources']);
        }
      }
    }
  }

  const joinedText = textParts.join('\n');
  const answerText =
    joinedText.trim().length > 0 ? joinedText : (asString(data['output_text']) ?? '');

  const citations = mergeCitations([
    urlAnnotations,
    data['references'],
    data['citations'],
    data['search_results'],
    ...extraCitationSources,
  ]);
  const fanOutQueries = dedupeQueryStrings(rawQueries);

  const usage = isRecord(data['usage']) ? data['usage'] : undefined;
  const responseModel = asNonEmptyString(data['model']) ?? fallbackModel;
  const upstreamRequestId = asNonEmptyString(data['id']);
  const tokensIn = asNonNegativeInt(usage?.['input_tokens']);
  const tokensOut = asNonNegativeInt(usage?.['output_tokens']);

  return {
    answerText,
    citations,
    fanOutQueries,
    ...(responseModel !== undefined ? { responseModel } : {}),
    ...(upstreamRequestId !== undefined ? { upstreamRequestId } : {}),
    ...(tokensIn !== undefined ? { tokensIn } : {}),
    ...(tokensOut !== undefined ? { tokensOut } : {}),
  };
}

class DoubaoSseAccumulator {
  finalResponse?: Record<string, unknown> | undefined;
  streamErrorMessage?: string | undefined;
  streamErrorCode?: string | undefined;
  upstreamRequestId?: string | undefined;
  responseModel?: string | undefined;

  webSearchStartMs?: number | undefined;
  webSearchEndMs?: number | undefined;
  ttftMs?: number | undefined;
  receivedAnyEvent = false;

  private readonly deltaParts: string[] = [];
  private readonly annotations: Record<string, unknown>[] = [];
  private readonly queries: string[] = [];

  handleEvent(evt: HttpStreamEvent): void {
    this.receivedAnyEvent = true;

    let parsed: unknown;
    try {
      parsed = JSON.parse(evt.data);
    } catch {
      return;
    }
    if (!isRecord(parsed)) {
      return;
    }

    const eventType = asNonEmptyString(parsed['type']) ?? evt.event;

    if (isRecord(parsed['response'])) {
      const resp = parsed['response'];
      this.upstreamRequestId ??= asNonEmptyString(resp['id']);
      this.responseModel ??= asNonEmptyString(resp['model']);
    }

    if (
      eventType === 'response.web_search_call.in_progress' ||
      eventType === 'response.web_search_call.searching'
    ) {
      if (this.webSearchStartMs === undefined) {
        this.webSearchStartMs = evt.elapsedMs;
      }
      return;
    }

    if (eventType === 'response.web_search_call.completed') {
      if (this.webSearchStartMs === undefined) {
        this.webSearchStartMs = evt.elapsedMs;
      }
      this.webSearchEndMs = evt.elapsedMs;
      return;
    }

    if (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') {
      const item = parsed['item'];
      if (isRecord(item)) {
        if (item['type'] === 'web_search_call') {
          if (this.webSearchStartMs === undefined) {
            this.webSearchStartMs = evt.elapsedMs;
          }
          if (eventType === 'response.output_item.done' || item['status'] === 'completed') {
            this.webSearchEndMs = evt.elapsedMs;
          }
          this.queries.push(...extractQueriesFromWebSearchItem(item));
        } else if (item['type'] === 'message' && Array.isArray(item['content'])) {
          for (const block of item['content']) {
            if (!isRecord(block)) {
              continue;
            }
            const annotations = block['annotations'];
            if (Array.isArray(annotations)) {
              for (const ann of annotations) {
                if (isRecord(ann)) {
                  this.annotations.push(ann);
                }
              }
            }
          }
        }
      }
      return;
    }

    if (eventType === 'response.output_text.delta') {
      const delta = asString(parsed['delta']);
      if (delta !== undefined && delta.length > 0) {
        if (this.ttftMs === undefined) {
          this.ttftMs = evt.elapsedMs;
        }
        this.deltaParts.push(delta);
      }
      return;
    }

    if (eventType === 'response.output_text.annotation.added') {
      const ann = parsed['annotation'];
      if (isRecord(ann)) {
        this.annotations.push(ann);
      }
      return;
    }

    if (eventType === 'response.completed' || eventType === 'response.incomplete') {
      if (isRecord(parsed['response'])) {
        this.finalResponse = parsed['response'];
      }
      return;
    }

    if (eventType === 'response.failed' || eventType === 'error') {
      const respErr =
        isRecord(parsed['response']) && isRecord(parsed['response']['error'])
          ? parsed['response']['error']
          : isRecord(parsed['error'])
            ? parsed['error']
            : parsed;
      this.streamErrorCode = asNonEmptyString(respErr['code']);
      this.streamErrorMessage = asNonEmptyString(respErr['message']) ?? 'Doubao SSE stream failed';
    }
  }

  toParsedPayload(fallbackModel?: string): ParsedResponsesPayload {
    const base =
      this.finalResponse !== undefined
        ? parseResponsesObject(this.finalResponse, fallbackModel)
        : {
            answerText: '',
            citations: [],
            fanOutQueries: [],
            ...(this.responseModel !== undefined
              ? { responseModel: this.responseModel }
              : fallbackModel !== undefined
                ? { responseModel: fallbackModel }
                : {}),
            ...(this.upstreamRequestId !== undefined
              ? { upstreamRequestId: this.upstreamRequestId }
              : {}),
          };

    const deltaText = this.deltaParts.join('');
    const answerText = base.answerText.trim().length > 0 ? base.answerText : deltaText;
    const citations = mergeCitations([base.citations, this.annotations]);
    const fanOutQueries = dedupeQueryStrings([...base.fanOutQueries, ...this.queries]);

    return {
      ...base,
      answerText,
      citations,
      fanOutQueries,
    };
  }
}

export class DoubaoAdapter implements EngineAdapter {
  readonly engine = 'doubao' as const;
  readonly region = 'domestic' as const;
  readonly provider = 'volcengine-ark';
  readonly model: string | undefined;
  private nextAllowedDispatchAt = 0;

  constructor(
    private readonly config: DoubaoConfig,
    private readonly httpClient: HttpClient,
    private readonly logger?: LoggerLike,
  ) {
    this.model = asNonEmptyString(config.model);
  }

  isConfigured(): boolean {
    return this.config.apiKey.trim().length > 0 && this.config.model.trim().length > 0;
  }

  private async waitForChannelPacing(ctx: CollectContext, startedAt: number): Promise<number> {
    const now = Date.now();
    const minIntervalMs = Math.max(0, this.config.minIntervalMs ?? 0);
    const waitMs = Math.max(0, this.nextAllowedDispatchAt - now);

    if (waitMs > 0) {
      const remainingMs = ctx.timeoutMs - (now - startedAt);
      if (waitMs >= remainingMs) {
        throw upstreamTimeoutError('Doubao channel pacing wait exceeded attempt timeout budget', {
          engine: this.engine,
          retryable: true,
        });
      }
      await defaultSleep(waitMs, ctx.signal, this.engine);
    }

    if (minIntervalMs > 0) {
      const dispatchNow = Date.now();
      this.nextAllowedDispatchAt =
        Math.max(this.nextAllowedDispatchAt, dispatchNow) + minIntervalMs;
    }

    return Math.max(0, ctx.timeoutMs - (Date.now() - startedAt));
  }

  private recordAdaptiveCooldown(err: unknown): void {
    if (!isGatewayError(err)) {
      return;
    }
    if (err.code === 'RATE_LIMITED') {
      const cooldownMs =
        err.retryAfterMs !== undefined ? Math.min(Math.max(0, err.retryAfterMs), 5_000) : 1_500;
      if (cooldownMs > 0) {
        this.nextAllowedDispatchAt = Math.max(this.nextAllowedDispatchAt, Date.now() + cooldownMs);
      }
    } else if (err.code === 'UPSTREAM_TIMEOUT' && (this.config.minIntervalMs ?? 0) > 0) {
      const cooldownMs = Math.min(this.config.minIntervalMs!, 500);
      this.nextAllowedDispatchAt = Math.max(this.nextAllowedDispatchAt, Date.now() + cooldownMs);
    }
  }

  private inferFailureStage(acc: DoubaoSseAccumulator, err: unknown): DoubaoFailureStage {
    if (acc.ttftMs !== undefined) {
      return 'stream_body';
    }
    if (acc.webSearchStartMs !== undefined && acc.webSearchEndMs === undefined) {
      return 'web_search';
    }
    if (acc.receivedAnyEvent) {
      return 'stream_ttft';
    }
    if (isGatewayError(err) && err.message.includes('pacing')) {
      return 'pacing';
    }
    return 'connect_dispatch';
  }

  async collect(ctx: CollectContext): Promise<AdapterResult> {
    if (!this.isConfigured()) {
      throw engineNotConfiguredError(this.engine);
    }

    const startedAt = Date.now();
    const useStream = this.config.stream === true;
    const baseBody: Record<string, unknown> = {
      model: this.config.model.trim(),
      input: [{ role: 'user', content: ctx.prompt }],
      tools: [
        {
          type: 'web_search',
          max_keyword: 3,
          limit: 10,
        },
      ],
      temperature: 0.2,
      ...(useStream ? { stream: true } : {}),
    };
    const body = shallowMergeRecord(baseBody, this.config.extraBody);
    const streamEnabled = body['stream'] === true;

    const url = `${trimTrailingSlashes(this.config.baseUrl)}/responses`;
    const headers: Record<string, string> = {
      ...(ctx.locale !== undefined ? { 'Accept-Language': ctx.locale } : {}),
      Authorization: `Bearer ${this.config.apiKey.trim()}`,
    };

    const sseAcc = new DoubaoSseAccumulator();

    try {
      const remainingTimeoutMs = await this.waitForChannelPacing(ctx, startedAt);
      if (remainingTimeoutMs <= 0) {
        throw upstreamTimeoutError('Doubao attempt timeout exceeded before dispatch', {
          engine: this.engine,
          retryable: true,
        });
      }

      const response = await this.httpClient.postStreamOrJson<unknown>(url, body, {
        headers,
        timeoutMs: remainingTimeoutMs,
        signal: ctx.signal,
        engine: this.engine,
        provider: this.provider,
        requestId: ctx.requestId,
        ...(this.config.firstByteTimeoutMs !== undefined
          ? { firstByteTimeoutMs: this.config.firstByteTimeoutMs }
          : {}),
        ...(this.config.idleTimeoutMs !== undefined
          ? { idleTimeoutMs: this.config.idleTimeoutMs }
          : {}),
        onSseEvent: (evt) => {
          sseAcc.handleEvent(evt);
        },
      });

      let parsed: ParsedResponsesPayload;
      if (response.mode === 'sse') {
        if (sseAcc.streamErrorMessage !== undefined) {
          throw upstreamBadResponseError(
            `Doubao stream failed${sseAcc.streamErrorCode ? ` (${sseAcc.streamErrorCode})` : ''}: ${sseAcc.streamErrorMessage}`,
            {
              engine: this.engine,
              retryable: true,
            },
          );
        }
        parsed = sseAcc.toParsedPayload(this.model);
      } else {
        if (!isRecord(response.data)) {
          throw upstreamBadResponseError('Upstream returned non-object JSON payload', {
            engine: this.engine,
            retryable: true,
          });
        }
        parsed = parseResponsesObject(response.data, this.model);
      }

      const dispatchMs = response.timingsMs.dispatchMs;
      const totalMs = Math.max(0, Date.now() - startedAt);
      const webSearchMs =
        sseAcc.webSearchStartMs !== undefined && sseAcc.webSearchEndMs !== undefined
          ? Math.max(0, sseAcc.webSearchEndMs - sseAcc.webSearchStartMs)
          : undefined;
      const ttftMs = sseAcc.ttftMs;
      const finishMs = ttftMs !== undefined ? Math.max(0, totalMs - ttftMs) : undefined;

      const stageTimingsMs: DoubaoStageTimings = {
        dispatchMs,
        ...(webSearchMs !== undefined ? { webSearchMs } : {}),
        ...(ttftMs !== undefined ? { ttftMs } : {}),
        ...(finishMs !== undefined ? { finishMs } : {}),
        totalMs,
      };

      this.logger?.info(
        {
          engine: this.engine,
          provider: this.provider,
          ...(parsed.responseModel !== undefined ? { model: parsed.responseModel } : {}),
          requestId: ctx.requestId,
          stream: streamEnabled,
          responseMode: response.mode,
          outcome: 'ok',
          timingsMs: stageTimingsMs,
          citationsCount: parsed.citations.length,
          fanOutCount: parsed.fanOutQueries.length,
          ...(parsed.upstreamRequestId !== undefined
            ? { upstreamRequestId: parsed.upstreamRequestId }
            : {}),
        },
        'doubao stage timings',
      );

      return {
        answerText: parsed.answerText,
        citations: parsed.citations,
        fanOutQueries: parsed.fanOutQueries,
        rawMeta: {
          provider: this.provider,
          ...(parsed.responseModel !== undefined ? { model: parsed.responseModel } : {}),
          ...(parsed.upstreamRequestId !== undefined
            ? { upstreamRequestId: parsed.upstreamRequestId }
            : {}),
          ...(parsed.tokensIn !== undefined ? { tokensIn: parsed.tokensIn } : {}),
          ...(parsed.tokensOut !== undefined ? { tokensOut: parsed.tokensOut } : {}),
          ...(response.mode === 'sse' ? { stageTimingsMs } : {}),
        },
      };
    } catch (err) {
      this.recordAdaptiveCooldown(err);

      const totalMs = Math.max(0, Date.now() - startedAt);
      const failureStage = this.inferFailureStage(sseAcc, err);
      const webSearchMs =
        sseAcc.webSearchStartMs !== undefined
          ? Math.max(0, (sseAcc.webSearchEndMs ?? totalMs) - sseAcc.webSearchStartMs)
          : undefined;

      this.logger?.warn(
        {
          engine: this.engine,
          provider: this.provider,
          ...(this.model !== undefined ? { model: this.model } : {}),
          requestId: ctx.requestId,
          stream: streamEnabled,
          outcome: isGatewayError(err) && err.code === 'UPSTREAM_TIMEOUT' ? 'timeout' : 'error',
          failureStage,
          ...(isGatewayError(err)
            ? { errorCode: err.code, statusCode: err.statusCode, retryable: err.retryable }
            : {}),
          timingsMs: {
            ...(webSearchMs !== undefined ? { webSearchMs } : {}),
            ...(sseAcc.ttftMs !== undefined ? { ttftMs: sseAcc.ttftMs } : {}),
            totalMs,
          },
          ...(sseAcc.upstreamRequestId !== undefined
            ? { upstreamRequestId: sseAcc.upstreamRequestId }
            : {}),
        },
        'doubao stage timings',
      );

      throw err;
    }
  }
}
