import { createHash, timingSafeEqual } from 'node:crypto';
import type { preHandlerHookHandler } from 'fastify';
import { unauthorizedError } from '../core/errors.js';

const BEARER_HEADER_RE = /^Bearer[ \t]+(\S+)$/;

function sha256Digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function extractBearerToken(authHeader: string | string[] | undefined): string | null {
  if (typeof authHeader !== 'string') {
    return null;
  }
  const match = BEARER_HEADER_RE.exec(authHeader.trim());
  const token = match?.[1];
  if (token === undefined || token.length === 0) {
    return null;
  }
  return token;
}

function verifyTokenAgainstDigests(token: string, validDigests: readonly Buffer[]): boolean {
  if (validDigests.length === 0) {
    return false;
  }

  const candidateDigest = sha256Digest(token);
  let matched = false;
  for (const keyDigest of validDigests) {
    const isEqual = timingSafeEqual(candidateDigest, keyDigest);
    if (isEqual) {
      matched = true;
    }
  }
  return matched;
}

export function verifyBearerToken(
  authHeader: string | string[] | undefined,
  validKeys: readonly string[],
): boolean {
  if (validKeys.length === 0) {
    return false;
  }
  const token = extractBearerToken(authHeader);
  if (token === null) {
    return false;
  }
  const validDigests = validKeys.map(sha256Digest);
  return verifyTokenAgainstDigests(token, validDigests);
}

export function createAuthPreHandler(validKeys: readonly string[]): preHandlerHookHandler {
  const validDigests = validKeys.map(sha256Digest);

  return async (request): Promise<void> => {
    const token = extractBearerToken(request.headers.authorization);
    if (token === null || !verifyTokenAgainstDigests(token, validDigests)) {
      throw unauthorizedError();
    }
  };
}
