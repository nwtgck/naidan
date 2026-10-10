import { requireValue } from '@/features/naidan-piping-duplex/bytes';
export type AttemptKind = 'waiting-sender' | 'waiting-receiver' | 'established' | 'transient' | 'fatal';
export class AttemptError extends Error {
  readonly kind: AttemptKind;

  constructor({ kind }: {
        kind: AttemptKind;
    }) {
    super(`Piping attempt: ${kind}`); this.kind = kind;
  }
}
export class Deadline {
  readonly signal: AbortSignal;
  private internalController = new AbortController();
  private internalParent: AbortSignal;
  private internalListener: () => void;
  private internalTimer: ReturnType<typeof setTimeout>;

  constructor({ parent, milliseconds }: {
        parent: AbortSignal;
        milliseconds: number;
    }) {
    requireValue({ condition: Number.isInteger(milliseconds) && milliseconds > 0 && milliseconds <= 2147483647, message: 'Deadline duration' });
    this.internalParent = parent;
    this.signal = this.internalController.signal;
    this.internalListener = () => this.internalController.abort(parent.reason);
    this.internalTimer = setTimeout(() => this.internalController.abort(new Error('Attempt deadline')), milliseconds);
    parent.addEventListener('abort', this.internalListener, { once: true });
    if (parent.aborted)
      this.internalListener();
  }

  dispose(): void {
    clearTimeout(this.internalTimer); this.internalParent.removeEventListener('abort', this.internalListener); this.internalController.abort();
  }
}

export async function sleep({ milliseconds, signal }: {
    milliseconds: number;
    signal: AbortSignal;
}): Promise<void> {
  requireValue({ condition: Number.isInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 2147483647, message: 'Timer duration' });
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup(); reject(signal.reason);
    };
    const timer = setTimeout(() => {
      cleanup(); resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export const TEST_ONLY = {
};
