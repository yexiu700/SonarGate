import type { AppConfig } from '../../config.js';
import { engineNotConfiguredError } from '../../core/errors.js';
import type { HttpClient } from '../../core/http-client.js';
import type { AdapterResult, CollectContext, EngineAdapter } from '../../core/types.js';
import { postChatCompletion } from '../shared/chat-completions.js';
import {
  asNonEmptyString,
  asNonNegativeInt,
  asString,
  dedupeQueryStrings,
  extractStringQueries,
  isRecord,
  mergeCitations,
  shallowMergeRecord,
} from '../shared/parsing.js';

export type DoubaoConfig = AppConfig['domestic']['doubao'];

export class DoubaoAdapter implements EngineAdapter {
  readonly engine = 'doubao' as const;
  readonly region = 'domestic' as const;
  readonly provider = 'volcengine-ark';
  readonly model: string | undefined;

  constructor(
    private readonly config: DoubaoConfig,
    private readonly httpClient: HttpClient,
  ) {
    this.model = asNonEmptyString(config.model);
  }

  isConfigured(): boolean {
    return this.config.apiKey.trim().length > 0 && this.config.model.trim().length > 0;
  }

  async collect(ctx: CollectContext): Promise<AdapterResult> {
    if (!this.isConfigured()) {
      throw engineNotConfiguredError(this.engine);
    }

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
    };
    const body = shallowMergeRecord(baseBody, this.config.extraBody);

    const data = await postChatCompletion({
      httpClient: this.httpClient,
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      body,
      ctx,
      engine: this.engine,
      provider: this.provider,
      endpointPath: '/responses',
    });

    const textParts: string[] = [];
    const urlAnnotations: Record<string, unknown>[] = [];
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
                if (isRecord(ann) && ann['type'] === 'url_citation') {
                  urlAnnotations.push(ann);
                }
              }
            }
          }
        } else if (itemType === 'web_search_call' && isRecord(item['action'])) {
          const action = item['action'];
          const singleQuery = asNonEmptyString(action['query']);
          if (singleQuery !== undefined) {
            rawQueries.push(singleQuery);
          }
          rawQueries.push(...extractStringQueries(action['queries']));
        }
      }
    }

    const joinedText = textParts.join('\n');
    const answerText =
      joinedText.trim().length > 0 ? joinedText : (asString(data['output_text']) ?? '');

    const citations = mergeCitations([urlAnnotations, data['references']]);
    const fanOutQueries = dedupeQueryStrings(rawQueries);

    const usage = isRecord(data['usage']) ? data['usage'] : undefined;
    const responseModel = asNonEmptyString(data['model']) ?? this.model;
    const upstreamRequestId = asNonEmptyString(data['id']);
    const tokensIn = asNonNegativeInt(usage?.['input_tokens']);
    const tokensOut = asNonNegativeInt(usage?.['output_tokens']);

    return {
      answerText,
      citations,
      fanOutQueries,
      rawMeta: {
        provider: this.provider,
        ...(responseModel !== undefined ? { model: responseModel } : {}),
        ...(upstreamRequestId !== undefined ? { upstreamRequestId } : {}),
        ...(tokensIn !== undefined ? { tokensIn } : {}),
        ...(tokensOut !== undefined ? { tokensOut } : {}),
      },
    };
  }
}
