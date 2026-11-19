import { createHash } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import type { CollectResponse } from './contract.js';

export const NO_AIO_MAX_TTL_SECONDS = 300;

export function buildCacheKey(
  engine: string,
  prompt: string,
  locationCode: number,
  languageCode: string,
): string {
  return createHash('sha256')
    .update(`${engine}\0${prompt.trim()}\0${locationCode}\0${languageCode}`)
    .digest('hex');
}

export function computeResponseTtlMs(response: CollectResponse, defaultTtlSeconds: number): number {
  if (defaultTtlSeconds <= 0) {
    return 0;
  }
  if (response.rawMeta.engine === 'google_aio' && response.rawMeta.aiOverviewTriggered === false) {
    return Math.min(defaultTtlSeconds, NO_AIO_MAX_TTL_SECONDS) * 1000;
  }
  return defaultTtlSeconds * 1000;
}

export interface ResponseCacheOptions {
  ttlSeconds: number;
  maxEntries: number;
}

export interface GetOrExecuteOptions<T> {
  bypassCache?: boolean | undefined;
  getTtlMs?: ((value: T) => number) | undefined;
}

export interface CacheLookupResult<T> {
  value: T;
  cached: boolean;
}

export class ResponseCache<T extends object> {
  private readonly defaultTtlMs: number;
  private readonly lru?: LRUCache<string, T>;
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(options: ResponseCacheOptions) {
    this.defaultTtlMs = Math.max(0, options.ttlSeconds) * 1000;
    if (this.defaultTtlMs > 0) {
      this.lru = new LRUCache<string, T>({
        max: Math.max(1, options.maxEntries),
        ttl: this.defaultTtlMs,
        perf: { now: () => Date.now() },
      });
    }
  }

  get enabled(): boolean {
    return this.lru !== undefined;
  }

  get size(): number {
    return this.lru?.size ?? 0;
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  clear(): void {
    this.lru?.clear();
  }

  async getOrExecute(
    key: string,
    fetcher: () => Promise<T>,
    options: GetOrExecuteOptions<T> = {},
  ): Promise<CacheLookupResult<T>> {
    const bypass = options.bypassCache === true;

    if (!bypass) {
      if (this.lru !== undefined) {
        const cachedValue = this.lru.get(key);
        if (cachedValue !== undefined) {
          return { value: cachedValue, cached: true };
        }
      }

      const existingFlight = this.inflight.get(key);
      if (existingFlight !== undefined) {
        const value = await existingFlight;
        return { value, cached: false };
      }
    }

    const runAndStore = async (): Promise<T> => {
      const value = await fetcher();
      if (this.lru !== undefined) {
        const ttlMs = options.getTtlMs !== undefined ? options.getTtlMs(value) : this.defaultTtlMs;
        if (ttlMs > 0) {
          this.lru.set(key, value, { ttl: ttlMs });
        }
      }
      return value;
    };

    if (bypass) {
      const value = await runAndStore();
      return { value, cached: false };
    }

    const flight = runAndStore().finally(() => {
      if (this.inflight.get(key) === flight) {
        this.inflight.delete(key);
      }
    });

    this.inflight.set(key, flight);
    const value = await flight;
    return { value, cached: false };
  }
}
