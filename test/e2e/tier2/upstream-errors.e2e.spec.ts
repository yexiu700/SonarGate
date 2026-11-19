import { afterEach, describe, expect, it } from 'vitest';
import { createE2EHarness } from '../helpers/e2e-harness.js';
import type { E2EHarness } from '../helpers/e2e-harness.js';
import { errorEnvelopeSchema } from '../helpers/geomix-schema.js';
import type { GatewayErrorCode } from '../helpers/geomix-schema.js';
import {
  buildDataForSeoTaskErrorPayload,
  buildDataForSeoTopLevelErrorPayload,
  buildDeepseekPayload,
} from '../helpers/mock-upstreams.js';

describe('Tier 2 — Upstream Auth, Quota & DataForSEO Logical Errors', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.close();
      harness = undefined;
    }
  });

  describe('Upstream HTTP 401/403 isolation (never passthrough 401/403, never retry)', () => {
    for (const upstreamStatus of [401, 403] as const) {
      it(`maps domestic HTTP ${upstreamStatus} to 503 UPSTREAM_AUTH_OR_QUOTA with 0 retries`, async () => {
        harness = createE2EHarness({ MAX_UPSTREAM_RETRIES: '2', RETRY_BASE_DELAY_MS: '50' });
        harness.upstreams.mockEngineReply('deepseek', upstreamStatus, {
          error: { message: 'Invalid vendor API key' },
        });

        const res = await harness.collect({
          engine: 'deepseek',
          prompt: `domestic ${upstreamStatus} isolation test`,
        });

        expect(res.statusCode).toBe(503);
        const envelope = errorEnvelopeSchema.parse(res.json());
        expect(envelope.error.code).toBe('UPSTREAM_AUTH_OR_QUOTA');
        expect(envelope.error.retryable).toBe(false);
        expect(envelope.error.engine).toBe('deepseek');
        expect(harness.upstreams.getHitCount('deepseek')).toBe(1);
      });

      it(`maps DataForSEO HTTP ${upstreamStatus} to 503 UPSTREAM_AUTH_OR_QUOTA with 0 retries`, async () => {
        harness = createE2EHarness({ MAX_UPSTREAM_RETRIES: '2', RETRY_BASE_DELAY_MS: '50' });
        harness.upstreams.mockEngineReply('chatgpt', upstreamStatus, {
          status_code: 40100,
          status_message: 'Unauthorized',
        });

        const res = await harness.collect({
          engine: 'chatgpt',
          prompt: `overseas ${upstreamStatus} isolation test`,
        });

        expect(res.statusCode).toBe(503);
        const envelope = errorEnvelopeSchema.parse(res.json());
        expect(envelope.error.code).toBe('UPSTREAM_AUTH_OR_QUOTA');
        expect(envelope.error.retryable).toBe(false);
        expect(envelope.error.engine).toBe('chatgpt');
        expect(harness.upstreams.getHitCount('chatgpt')).toBe(1);
      });
    }
  });

  describe('DataForSEO HTTP 200 logical status_code mapping (top-level & task-level)', () => {
    const dfsErrorCases: Array<{
      dfsCode: number;
      expectedHttp: number;
      expectedCode: GatewayErrorCode;
      expectedRetryable: boolean;
      expectNoRetry: boolean;
    }> = [
      {
        dfsCode: 40100,
        expectedHttp: 503,
        expectedCode: 'UPSTREAM_AUTH_OR_QUOTA',
        expectedRetryable: false,
        expectNoRetry: true,
      },
      {
        dfsCode: 40101,
        expectedHttp: 503,
        expectedCode: 'UPSTREAM_AUTH_OR_QUOTA',
        expectedRetryable: false,
        expectNoRetry: true,
      },
      {
        dfsCode: 40200,
        expectedHttp: 503,
        expectedCode: 'UPSTREAM_AUTH_OR_QUOTA',
        expectedRetryable: false,
        expectNoRetry: true,
      },
      {
        dfsCode: 42900,
        expectedHttp: 429,
        expectedCode: 'RATE_LIMITED',
        expectedRetryable: true,
        expectNoRetry: false,
      },
      {
        dfsCode: 40000,
        expectedHttp: 400,
        expectedCode: 'INVALID_REQUEST',
        expectedRetryable: false,
        expectNoRetry: true,
      },
      {
        dfsCode: 50000,
        expectedHttp: 502,
        expectedCode: 'UPSTREAM_BAD_RESPONSE',
        expectedRetryable: true,
        expectNoRetry: false,
      },
    ];

    for (const tc of dfsErrorCases) {
      it(`maps DataForSEO top-level status_code=${tc.dfsCode} to HTTP ${tc.expectedHttp} ${tc.expectedCode}`, async () => {
        harness = createE2EHarness({ MAX_UPSTREAM_RETRIES: '1', RETRY_BASE_DELAY_MS: '50' });
        harness.upstreams.mockEngineReply(
          'chatgpt',
          200,
          buildDataForSeoTopLevelErrorPayload(tc.dfsCode, `DFS top-level ${tc.dfsCode}`),
          { persist: true },
        );

        const res = await harness.collect({
          engine: 'chatgpt',
          prompt: `dfs top-level ${tc.dfsCode} test`,
        });

        expect(res.statusCode).toBe(tc.expectedHttp);
        const envelope = errorEnvelopeSchema.parse(res.json());
        expect(envelope.error.code).toBe(tc.expectedCode);
        expect(envelope.error.retryable).toBe(tc.expectedRetryable);
        if (tc.expectNoRetry) {
          expect(harness.upstreams.getHitCount('chatgpt')).toBe(1);
        }
      });

      it(`maps DataForSEO task-level status_code=${tc.dfsCode} to HTTP ${tc.expectedHttp} ${tc.expectedCode}`, async () => {
        harness = createE2EHarness({ MAX_UPSTREAM_RETRIES: '1', RETRY_BASE_DELAY_MS: '50' });
        harness.upstreams.mockEngineReply(
          'perplexity',
          200,
          buildDataForSeoTaskErrorPayload(tc.dfsCode, `DFS task-level ${tc.dfsCode}`),
          { persist: true },
        );

        const res = await harness.collect({
          engine: 'perplexity',
          prompt: `dfs task-level ${tc.dfsCode} test`,
        });

        expect(res.statusCode).toBe(tc.expectedHttp);
        const envelope = errorEnvelopeSchema.parse(res.json());
        expect(envelope.error.code).toBe(tc.expectedCode);
        expect(envelope.error.retryable).toBe(tc.expectedRetryable);
        if (tc.expectNoRetry) {
          expect(harness.upstreams.getHitCount('perplexity')).toBe(1);
        }
      });
    }
  });

  describe('Empty answerText & non-JSON upstream responses', () => {
    const emptyAnswerCases: Array<{ label: string; answerText: string }> = [
      { label: 'empty string', answerText: '' },
      { label: 'whitespace only', answerText: '   \n\t  ' },
      { label: 'control characters only', answerText: '\u0000\u0007\u001f' },
    ];

    for (const tc of emptyAnswerCases) {
      it(`returns 502 UPSTREAM_BAD_RESPONSE when upstream answerText is ${tc.label}`, async () => {
        harness = createE2EHarness({ MAX_UPSTREAM_RETRIES: '0' });
        harness.upstreams.mockEngineSuccess(
          'deepseek',
          buildDeepseekPayload({ answerText: tc.answerText }),
        );

        const res = await harness.collect({
          engine: 'deepseek',
          prompt: `empty answer test: ${tc.label}`,
        });

        expect(res.statusCode).toBe(502);
        const envelope = errorEnvelopeSchema.parse(res.json());
        expect(envelope.error.code).toBe('UPSTREAM_BAD_RESPONSE');
        expect(envelope.error.retryable).toBe(true);
      });
    }

    it('returns 502 UPSTREAM_BAD_RESPONSE when upstream returns non-JSON HTML body', async () => {
      harness = createE2EHarness({ MAX_UPSTREAM_RETRIES: '0' });
      harness.upstreams.mockEngineReply('deepseek', 200, '<html><body>Bad Gateway</body></html>', {
        headers: { 'content-type': 'text/html' },
      });

      const res = await harness.collect({
        engine: 'deepseek',
        prompt: 'non-json upstream body test',
      });

      expect(res.statusCode).toBe(502);
      const envelope = errorEnvelopeSchema.parse(res.json());
      expect(envelope.error.code).toBe('UPSTREAM_BAD_RESPONSE');
      expect(envelope.error.retryable).toBe(true);
    });
  });
});
