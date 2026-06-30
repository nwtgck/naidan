/**
 * Simple semaphore to limit concurrent execution of asynchronous tasks.
 */
export class Semaphore {
  private activeCount = 0;
  private queue: (() => void)[] = [];

  private maxConcurrency: number;

  constructor({ maxConcurrency }: { maxConcurrency: number }) {
    this.maxConcurrency = maxConcurrency;
  }

  async acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    } else {
      this.activeCount--;
    }
  }

  /**
   * Helper to wrap a function with semaphore acquisition and release.
   */
  async run<T>({ task }: { task: () => Promise<T> }): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
