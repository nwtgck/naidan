const closedRaceResult = Symbol('closedRaceResult');

export class WeshHandleCloseSignal {
  private readonly closePromise: Promise<void>;
  private readonly closeRacePromise: Promise<typeof closedRaceResult>;
  private resolveClosePromise: (() => void) | undefined;
  private isClosed = false;

  constructor() {
    this.closePromise = new Promise<void>(resolve => {
      this.resolveClosePromise = resolve;
    });
    this.closeRacePromise = this.closePromise.then(() => closedRaceResult);
  }

  get closed(): boolean {
    return this.isClosed;
  }

  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.resolveClosePromise?.();
    this.resolveClosePromise = undefined;
  }

  async raceWithClose<T>({ operation, buildClosedResult }: {
    operation: Promise<T>,
    buildClosedResult: () => T,
  }): Promise<T> {
    if (this.isClosed) {
      return buildClosedResult();
    }

    const result = await Promise.race([
      operation as Promise<T | typeof closedRaceResult>,
      this.closeRacePromise as Promise<T | typeof closedRaceResult>,
    ]);
    if (result === closedRaceResult) {
      return buildClosedResult();
    }
    return result;
  }
}
