import { afterEach, describe, expect, it } from 'vitest';
import {
  UUID_V4_REGEX,
  assertValidGeoMixResponse,
  errorEnvelopeSchema,
} from '../helpers/geomix-schema.js';
import { PRIMARY_API_KEY, SECONDARY_API_KEY, createE2EHarness } from '../helpers/e2e-harness.js';
import type { E2EHarness } from '../helpers/e2e-harness.js';
import {
  buildDataForSeoTaskErrorPayload,
  buildDataForSeoTopLevelErrorPayload,
  buildDoubaoPayload,
  buildTongyiPayload,
} from '../helpers/mock-upstreams.js';

describe('Tier 3: Multi-Key Auth + X-Request-Id + Error Envelope Matrix', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await harness.close();
      harness = undefined;
    }
  });

  it('accepts rotated keys in GATEWAY_API_KEYS and supports GATEWAY_API_KEY single-key fallback', async () => {
    harness = createE2EHarness();
    harness.upstreams.mockEngineSuccess('doubao', undefined, { persist: true });

    const resPrimary = await harness.collect(
      { engine: 'doubao', prompt: 'primary key prompt' },
      { apiKey: PRIMARY_API_KEY, requestId: 'req.primary_01-ok' },
    );
    expect(resPrimary.statusCode).toBe(200);
    expect(resPrimary.headers['x-request-id']).toBe('req.primary_01-ok');
    const parsedPrimary = assertValidGeoMixResponse(resPrimary.body, resPrimary.json());
    expect(parsedPrimary.rawMeta?.['requestId']).toBe('req.primary_01-ok');

    const resSecondary = await harness.collect(
      { engine: 'doubao', prompt: 'secondary key prompt' },
      { apiKey: SECONDARY_API_KEY, requestId: 'req.secondary_02-ok' },
    );
    expect(resSecondary.statusCode).toBe(200);
    expect(resSecondary.headers['x-request-id']).toBe('req.secondary_02-ok');
    const parsedSecondary = assertValidGeoMixResponse(resSecondary.body, resSecondary.json());
    expect(parsedSecondary.rawMeta?.['requestId']).toBe('req.secondary_02-ok');

    await harness.close();
    harness = undefined;

    const legacyKey = 'legacy-single-gateway-key-0000001';
    harness = createE2EHarness({
      GATEWAY_API_KEYS: undefined,
      GATEWAY_API_KEY: legacyKey,
    });
    harness.upstreams.mockEngineSuccess('doubao');

    const resLegacy = await harness.collect(
      { engine: 'doubao', prompt: 'legacy fallback prompt' },
      { apiKey: legacyKey, requestId: 'req-legacy-01' },
    );
    expect(resLegacy.statusCode).toBe(200);
    expect(resLegacy.headers['x-request-id']).toBe('req-legacy-01');

    const resLegacyRejected = await harness.collect(
      { engine: 'doubao', prompt: 'legacy fallback prompt' },
      { apiKey: PRIMARY_API_KEY, requestId: 'req-legacy-401' },
    );
    expect(resLegacyRejected.statusCode).toBe(401);
    const err = errorEnvelopeSchema.parse(resLegacyRejected.json());
    expect(err.error.code).toBe('UNAUTHORIZED');
    expect(err.error.retryable).toBe(false);
    expect(err.error.requestId).toBe('req-legacy-401');
  });

  it('rejects missing, malformed, and wrong-length Bearer tokens with 401 while echoing valid X-Request-Id', async () => {
    harness = createE2EHarness();

    const invalidAuthCases: Array<{
      label: string;
      headers: Record<string, string>;
      apiKey?: string | null;
      requestId: string;
    }> = [
      { label: 'missing auth', headers: {}, apiKey: null, requestId: 'req-unauth-missing' },
      {
        label: 'basic scheme',
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
        requestId: 'req-unauth-scheme',
      },
      {
        label: 'short key',
        headers: { authorization: 'Bearer short' },
        requestId: 'req-unauth-short',
      },
      {
        label: 'overlong key',
        headers: { authorization: `Bearer ${PRIMARY_API_KEY}-extra-bytes` },
        requestId: 'req-unauth-long',
      },
      {
        label: 'same-length wrong key',
        headers: { authorization: `Bearer ${PRIMARY_API_KEY.slice(0, -1)}X` },
        requestId: 'req-unauth-same-len',
      },
    ];

    for (const tc of invalidAuthCases) {
      const res = await harness.collect(
        { engine: 'doubao', prompt: tc.label },
        {
          headers: tc.headers,
          ...(tc.apiKey !== undefined ? { apiKey: tc.apiKey } : {}),
          requestId: tc.requestId,
        },
      );
      expect(res.statusCode).toBe(401);
      expect(res.headers['x-request-id']).toBe(tc.requestId);
      const err = errorEnvelopeSchema.parse(res.json());
      expect(err.error.code).toBe('UNAUTHORIZED');
      expect(err.error.retryable).toBe(false);
      expect(err.error.requestId).toBe(tc.requestId);
    }
  });

  it('replaces invalid X-Request-Id with generated UUIDv4 on both 200 and error responses', async () => {
    harness = createE2EHarness();
    harness.upstreams.mockEngineSuccess('doubao', undefined, { persist: true });

    const invalidIds = ['', 'a'.repeat(65), 'req with space', 'req!@#bad', '../traversal'];

    for (let i = 0; i < invalidIds.length; i += 1) {
      const badId = invalidIds[i]!;

      const okRes = await harness.collect(
        { engine: 'doubao', prompt: `valid prompt ${i}` },
        { requestId: badId },
      );
      expect(okRes.statusCode).toBe(200);
      const okHeaderId = okRes.headers['x-request-id'];
      expect(typeof okHeaderId).toBe('string');
      expect(okHeaderId).toMatch(UUID_V4_REGEX);
      const parsedOk = assertValidGeoMixResponse(okRes.body, okRes.json());
      expect(parsedOk.rawMeta?.['requestId']).toBe(okHeaderId);

      const errRes = await harness.collect(
        { engine: 'yuanbao', prompt: `bad engine ${i}` },
        { requestId: badId },
      );
      expect(errRes.statusCode).toBe(501);
      const errHeaderId = errRes.headers['x-request-id'];
      expect(typeof errHeaderId).toBe('string');
      expect(errHeaderId).toMatch(UUID_V4_REGEX);
      const parsedErr = errorEnvelopeSchema.parse(errRes.json());
      expect(parsedErr.error.code).toBe('ENGINE_NOT_IMPLEMENTED');
      expect(parsedErr.error.requestId).toBe(errHeaderId);
    }
  });

  it('preserves rotated key auth and X-Request-Id echo across the full error envelope matrix', async () => {
    harness = createE2EHarness({
      MAX_UPSTREAM_RETRIES: '0',
      WENXIN_API_KEY: '',
      DOUBAO_MODEL: '',
    });

    // 400 INVALID_REQUEST: empty prompt, >2000-char prompt, malformed JSON
    const emptyPromptRes = await harness.collect(
      { engine: 'tongyi', prompt: '   ' },
      { apiKey: SECONDARY_API_KEY, requestId: 'req-400-empty' },
    );
    expect(emptyPromptRes.statusCode).toBe(400);
    expect(emptyPromptRes.headers['x-request-id']).toBe('req-400-empty');
    expect(errorEnvelopeSchema.parse(emptyPromptRes.json()).error).toMatchObject({
      code: 'INVALID_REQUEST',
      retryable: false,
      requestId: 'req-400-empty',
    });

    const overlongPromptRes = await harness.collect(
      { engine: 'tongyi', prompt: 'a'.repeat(2001) },
      { apiKey: SECONDARY_API_KEY, requestId: 'req-400-overlong' },
    );
    expect(overlongPromptRes.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(overlongPromptRes.json()).error).toMatchObject({
      code: 'INVALID_REQUEST',
      retryable: false,
      requestId: 'req-400-overlong',
    });

    const malformedJsonRes = await harness.collect(undefined, {
      apiKey: SECONDARY_API_KEY,
      requestId: 'req-400-json',
      rawBody: '{"engine":"tongyi","prompt":',
    });
    expect(malformedJsonRes.statusCode).toBe(400);
    expect(malformedJsonRes.headers['x-request-id']).toBe('req-400-json');
    expect(errorEnvelopeSchema.parse(malformedJsonRes.json()).error).toMatchObject({
      code: 'INVALID_REQUEST',
      retryable: false,
      requestId: 'req-400-json',
    });

    // 400 UNSUPPORTED_ENGINE: unknown_foo
    const unknownRes = await harness.collect(
      { engine: 'unknown_foo', prompt: 'test prompt' },
      { apiKey: SECONDARY_API_KEY, requestId: 'req-400-unknown' },
    );
    expect(unknownRes.statusCode).toBe(400);
    expect(unknownRes.headers['x-request-id']).toBe('req-400-unknown');
    expect(errorEnvelopeSchema.parse(unknownRes.json()).error).toMatchObject({
      code: 'UNSUPPORTED_ENGINE',
      retryable: false,
      requestId: 'req-400-unknown',
    });

    // 501 ENGINE_NOT_IMPLEMENTED: planned engines (yuanbao, nami, kimi)
    for (const planned of ['yuanbao', 'nami', 'kimi'] as const) {
      const reqId = `req-501-${planned}`;
      const res = await harness.collect(
        { engine: planned, prompt: 'test prompt' },
        { apiKey: SECONDARY_API_KEY, requestId: reqId },
      );
      expect(res.statusCode).toBe(501);
      expect(res.headers['x-request-id']).toBe(reqId);
      expect(errorEnvelopeSchema.parse(res.json()).error).toMatchObject({
        code: 'ENGINE_NOT_IMPLEMENTED',
        retryable: false,
        requestId: reqId,
      });
    }

    // 501 ENGINE_NOT_CONFIGURED: missing key (wenxin) and DOUBAO_MODEL="" (doubao)
    const wenxinUnconf = await harness.collect(
      { engine: 'wenxin', prompt: 'test unconfigured' },
      { apiKey: SECONDARY_API_KEY, requestId: 'req-501-wenxin' },
    );
    expect(wenxinUnconf.statusCode).toBe(501);
    expect(wenxinUnconf.headers['x-request-id']).toBe('req-501-wenxin');
    expect(errorEnvelopeSchema.parse(wenxinUnconf.json()).error).toMatchObject({
      code: 'ENGINE_NOT_CONFIGURED',
      retryable: false,
      engine: 'wenxin',
      requestId: 'req-501-wenxin',
    });

    const doubaoNoModel = await harness.collect(
      { engine: 'doubao', prompt: 'test doubao missing model' },
      { apiKey: SECONDARY_API_KEY, requestId: 'req-501-doubao' },
    );
    expect(doubaoNoModel.statusCode).toBe(501);
    expect(doubaoNoModel.headers['x-request-id']).toBe('req-501-doubao');
    expect(errorEnvelopeSchema.parse(doubaoNoModel.json()).error).toMatchObject({
      code: 'ENGINE_NOT_CONFIGURED',
      retryable: false,
      engine: 'doubao',
      requestId: 'req-501-doubao',
    });

    // 502 UPSTREAM_BAD_RESPONSE: upstream 500 and empty answerText
    harness.upstreams.mockEngineReply('tongyi', 500, { error: 'upstream crash' }, { times: 1 });
    const upstream500Res = await harness.collect(
      { engine: 'tongyi', prompt: 'trigger 500' },
      { apiKey: SECONDARY_API_KEY, requestId: 'req-502-500' },
    );
    expect(upstream500Res.statusCode).toBe(502);
    expect(upstream500Res.headers['x-request-id']).toBe('req-502-500');
    expect(errorEnvelopeSchema.parse(upstream500Res.json()).error).toMatchObject({
      code: 'UPSTREAM_BAD_RESPONSE',
      retryable: true,
      requestId: 'req-502-500',
    });

    harness.upstreams.mockEngineSuccess('tongyi', buildTongyiPayload({ answerText: '   ' }), {
      times: 1,
    });
    const emptyAnswerRes = await harness.collect(
      { engine: 'tongyi', prompt: 'trigger empty answer' },
      { apiKey: SECONDARY_API_KEY, requestId: 'req-502-empty' },
    );
    expect(emptyAnswerRes.statusCode).toBe(502);
    expect(emptyAnswerRes.headers['x-request-id']).toBe('req-502-empty');
    expect(errorEnvelopeSchema.parse(emptyAnswerRes.json()).error).toMatchObject({
      code: 'UPSTREAM_BAD_RESPONSE',
      retryable: true,
      requestId: 'req-502-empty',
    });

    // 503 UPSTREAM_AUTH_OR_QUOTA: domestic 401/403 + DataForSEO 40100/40101/40200 (never leaks 401!)
    harness.upstreams.mockEngineReply('deepseek', 401, { error: 'invalid api key' }, { times: 1 });
    const domestic401 = await harness.collect(
      { engine: 'deepseek', prompt: 'domestic 401' },
      { apiKey: SECONDARY_API_KEY, requestId: 'req-503-dom401' },
    );
    expect(domestic401.statusCode).toBe(503);
    expect(domestic401.headers['x-request-id']).toBe('req-503-dom401');
    expect(errorEnvelopeSchema.parse(domestic401.json()).error).toMatchObject({
      code: 'UPSTREAM_AUTH_OR_QUOTA',
      retryable: false,
      requestId: 'req-503-dom401',
    });

    harness.upstreams.mockEngineReply('zhipu', 403, { error: 'quota exceeded' }, { times: 1 });
    const domestic403 = await harness.collect(
      { engine: 'zhipu', prompt: 'domestic 403' },
      { apiKey: SECONDARY_API_KEY, requestId: 'req-503-dom403' },
    );
    expect(domestic403.statusCode).toBe(503);
    expect(errorEnvelopeSchema.parse(domestic403.json()).error).toMatchObject({
      code: 'UPSTREAM_AUTH_OR_QUOTA',
      retryable: false,
      requestId: 'req-503-dom403',
    });

    harness.upstreams.mockEngineReply(
      'chatgpt',
      200,
      buildDataForSeoTopLevelErrorPayload(40100, 'Unauthorized'),
      { times: 1 },
    );
    const dfs40100 = await harness.collect(
      { engine: 'chatgpt', prompt: 'dfs 40100' },
      { apiKey: SECONDARY_API_KEY, requestId: 'req-503-dfs40100' },
    );
    expect(dfs40100.statusCode).toBe(503);
    expect(errorEnvelopeSchema.parse(dfs40100.json()).error).toMatchObject({
      code: 'UPSTREAM_AUTH_OR_QUOTA',
      retryable: false,
      requestId: 'req-503-dfs40100',
    });

    harness.upstreams.mockEngineReply(
      'perplexity',
      200,
      buildDataForSeoTaskErrorPayload(40101, 'Invalid credentials'),
      { times: 1 },
    );
    const dfs40101 = await harness.collect(
      { engine: 'perplexity', prompt: 'dfs 40101' },
      { apiKey: SECONDARY_API_KEY, requestId: 'req-503-dfs40101' },
    );
    expect(dfs40101.statusCode).toBe(503);
    expect(errorEnvelopeSchema.parse(dfs40101.json()).error).toMatchObject({
      code: 'UPSTREAM_AUTH_OR_QUOTA',
      retryable: false,
      requestId: 'req-503-dfs40101',
    });

    harness.upstreams.mockEngineReply(
      'claude',
      200,
      buildDataForSeoTaskErrorPayload(40200, 'Payment required'),
      { times: 1 },
    );
    const dfs40200 = await harness.collect(
      { engine: 'claude', prompt: 'dfs 40200' },
      { apiKey: SECONDARY_API_KEY, requestId: 'req-503-dfs40200' },
    );
    expect(dfs40200.statusCode).toBe(503);
    expect(errorEnvelopeSchema.parse(dfs40200.json()).error).toMatchObject({
      code: 'UPSTREAM_AUTH_OR_QUOTA',
      retryable: false,
      requestId: 'req-503-dfs40200',
    });
  });

  it('keeps /health and /ready accessible without auth even when invalid Authorization header is sent', async () => {
    harness = createE2EHarness();
    harness.upstreams.mockEngineSuccess('doubao', buildDoubaoPayload());

    const healthRes = await harness.getHealth({ authorization: 'Bearer invalid-key' });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json()).toMatchObject({ status: 'ok', service: 'sonargate' });

    const readyRes = await harness.getReady({ authorization: 'Bearer invalid-key' });
    expect(readyRes.statusCode).toBe(200);
    expect(readyRes.json()).toMatchObject({ ready: true });
  });
});
