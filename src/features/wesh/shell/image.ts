import type { WeshWaitStatus } from '@/features/wesh/types';
import { WeshShellChildren } from './child-processes';

type WeshShellTermination = {
  readonly status: Extract<WeshWaitStatus, { kind: 'signaled' }>,
  readonly lastExitCode: number,
  /** A self-signal finishes at the source boundary of the evaluation that sent it. */
  readonly unwindOwner: object | undefined,
};

export class WeshShellImage {
  readonly children: WeshShellChildren;
  cwd: string;
  private retirement?: AbortController;
  private retiredWith?: WeshWaitStatus;
  private pendingSignals?: Set<number>;
  private signalWaiters?: Set<() => void>;
  private runningSignalTrap = false;
  private ending?: WeshShellTermination;
  private terminationWaiters?: Set<() => void>;
  private exitTrapClaimed = false;

  constructor({ cwd, lastPid }: { cwd: string, lastPid: number | undefined }) {
    this.cwd = cwd;
    this.children = new WeshShellChildren({ lastPid });
  }

  get retirementStatus(): WeshWaitStatus | undefined {
    return this.retiredWith;
  }

  get termination(): WeshShellTermination | undefined {
    return this.ending;
  }

  terminate({ status, lastExitCode, unwindOwner }: {
    status: WeshShellTermination['status'],
    lastExitCode: number,
    unwindOwner: object | undefined,
  }): void {
    if (this.ending !== undefined && (this.ending.status.signal === 9 || status.signal !== 9)) {
      return;
    }
    this.ending = { status, lastExitCode, unwindOwner };
    if (this.terminationWaiters !== undefined) {
      for (const notify of this.terminationWaiters) {
        notify();
      }
    }
  }

  subscribeTermination({ notify }: { notify: () => void }): () => void {
    const waiters = this.terminationWaiters ??= new Set();
    waiters.add(notify);
    return () => {
      waiters.delete(notify);
    };
  }

  claimExitTrap(): boolean {
    if (this.exitTrapClaimed) {
      return false;
    }
    this.exitTrapClaimed = true;
    return true;
  }

  get hasPendingSignal(): boolean {
    return !this.runningSignalTrap && (this.pendingSignals?.size ?? 0) !== 0;
  }

  hasQueuedSignal({ signal }: { signal: number }): boolean {
    return this.pendingSignals?.has(signal) === true;
  }

  queueSignal({ signal }: { signal: number }): void {
    if (this.retiredWith !== undefined) {
      return;
    }
    (this.pendingSignals ??= new Set()).add(signal);
    if (this.hasPendingSignal) {
      this.notifySignalWaiters();
    }
  }

  claimSignal(): number | undefined {
    const pending = this.pendingSignals;
    if (this.runningSignalTrap || pending === undefined) {
      return undefined;
    }
    let signal: number | undefined;
    for (const candidate of pending) {
      if (signal === undefined || candidate < signal) {
        signal = candidate;
      }
    }
    if (signal !== undefined) {
      pending.delete(signal);
      this.runningSignalTrap = true;
    }
    return signal;
  }

  finishSignal(): void {
    this.runningSignalTrap = false;
    if (this.hasPendingSignal) {
      this.notifySignalWaiters();
    }
  }

  subscribeSignals({ notify }: { notify: () => void }): () => void {
    const waiters = this.signalWaiters ??= new Set();
    waiters.add(notify);
    return () => {
      waiters.delete(notify);
    };
  }

  private notifySignalWaiters(): void {
    if (this.signalWaiters !== undefined) {
      for (const notify of this.signalWaiters) {
        notify();
      }
    }
  }

  subscribeRetirement({ notify }: { notify: () => void }): () => void {
    if (this.retiredWith !== undefined) {
      return () => {};
    }
    const { signal } = this.retirement ??= new AbortController();
    signal.addEventListener('abort', notify, { once: true });
    return () => signal.removeEventListener('abort', notify);
  }

  retire({ status }: { status: WeshWaitStatus }): void {
    if (this.retiredWith !== undefined) {
      return;
    }
    this.retiredWith = status;
    this.children.clear();
    this.pendingSignals?.clear();
    this.retirement?.abort();
    this.retirement = undefined;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
