import { GatewayError } from './errors.js';

export const DEFAULT_SEMAPHORE_WAIT_MS = 15_000;

export interface SemaphoreOptions {
  maxConcurrency: number;
  waitTimeoutMs?: number | undefined;
  name?: string | undefined;
}

export interface AcquireOptions {
  waitTimeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  engine?: string | undefined;
}

export interface SemaphoreStats {
  maxConcurrency: number;
  active: number;
  queued: number;
}

interface Waiter {
  settled: boolean;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

export class Semaphore {
  private readonly maxConcurrency: number;
  private readonly defaultWaitTimeoutMs: number;
  private readonly name: string;
  private activeCount = 0;
  private readonly queue: Waiter[] = [];

  constructor(options: SemaphoreOptions) {
    if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
      throw new Error(
        `Semaphore maxConcurrency must be an integer >= 1, got ${options.maxConcurrency}`,
      );
    }
    this.maxConcurrency = options.maxConcurrency;
    this.defaultWaitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_SEMAPHORE_WAIT_MS;
    this.name = options.name ?? 'semaphore';
  }

  acquire(options: AcquireOptions = {}): Promise<() => void> {
    if (options.signal?.aborted) {
      return Promise.reject(
        new GatewayError(
          408,
          'UPSTREAM_TIMEOUT',
          'Request aborted before acquiring concurrency slot',
          {
            retryable: false,
            engine: options.engine,
          },
        ),
      );
    }

    if (this.activeCount < this.maxConcurrency) {
      this.activeCount += 1;
      return Promise.resolve(this.createReleaseFn());
    }

    const waitTimeoutMs = options.waitTimeoutMs ?? this.defaultWaitTimeoutMs;

    return new Promise<() => void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const waiter: Waiter = {
        settled: false,
        resolve,
        reject,
        cleanup: () => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          if (options.signal !== undefined) {
            options.signal.removeEventListener('abort', onAbort);
          }
        },
      };

      const removeFromQueue = (): void => {
        const idx = this.queue.indexOf(waiter);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }
      };

      const onAbort = (): void => {
        if (waiter.settled) {
          return;
        }
        waiter.settled = true;
        waiter.cleanup();
        removeFromQueue();
        reject(
          new GatewayError(
            408,
            'UPSTREAM_TIMEOUT',
            `Request aborted while waiting for ${this.name} concurrency slot`,
            {
              retryable: false,
              engine: options.engine,
            },
          ),
        );
      };

      timer = setTimeout(() => {
        if (waiter.settled) {
          return;
        }
        waiter.settled = true;
        waiter.cleanup();
        removeFromQueue();
        reject(
          new GatewayError(
            429,
            'RATE_LIMITED',
            `Timed out waiting ${waitTimeoutMs}ms for ${this.name} concurrency slot`,
            {
              retryable: true,
              engine: options.engine,
            },
          ),
        );
      }, waitTimeoutMs);

      if (options.signal !== undefined) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.queue.push(waiter);
    });
  }

  async run<T>(fn: () => Promise<T>, options: AcquireOptions = {}): Promise<T> {
    const release = await this.acquire(options);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  getStats(): SemaphoreStats {
    return {
      maxConcurrency: this.maxConcurrency,
      active: this.activeCount,
      queued: this.queue.length,
    };
  }

  private createReleaseFn(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.releasePermit();
    };
  }

  private releasePermit(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next === undefined || next.settled) {
        continue;
      }
      next.settled = true;
      next.cleanup();
      // Transfer permit directly to next waiter; activeCount stays unchanged
      next.resolve(this.createReleaseFn());
      return;
    }

    this.activeCount = Math.max(0, this.activeCount - 1);
  }
}
