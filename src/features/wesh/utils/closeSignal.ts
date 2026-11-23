const closedRaceResult = Symbol('closedRaceResult');

export class WeshHandleCloseSignal {
  private waiters: Set<() => void> | undefined;
  private isClosed = false;

  get closed(): boolean {
    return this.isClosed;
  }

  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    const waiters = this.waiters;
    this.waiters = undefined;
    if (waiters === undefined || waiters.size === 0) {
      return;
    }
    // Deliver close after the I/O reactions queued in this turn, as with
    // the previous race against a Promise derived from the close request.
    queueMicrotask(() => queueMicrotask(() => {
      for (const notify of waiters) {
        notify();
      }
      waiters.clear();
    }));
  }

  async raceWithClose<T>({ operation, buildClosedResult }: {
    operation: Promise<T>,
    buildClosedResult: () => T,
  }): Promise<T> {
    if (this.isClosed) {
      void operation.catch(() => {});
      return buildClosedResult();
    }

    // Racing every operation against one pending Promise retains all of its
    // reactions until close. Release each notification when its I/O settles.
    const waiters = this.waiters ??= new Set();
    const result = await new Promise<T | typeof closedRaceResult>((resolve, reject) => {
      const notify = () => resolve(closedRaceResult);
      waiters.add(notify);
      void operation.then(
        value => {
          waiters.delete(notify);
          resolve(value);
        },
        error => {
          waiters.delete(notify);
          reject(error);
        },
      );
    });
    if (result === closedRaceResult) {
      return buildClosedResult();
    }
    return result;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
