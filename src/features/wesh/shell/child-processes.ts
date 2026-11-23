import type { WeshCommandResult, WeshWaitStatus } from '@/features/wesh/types';

const COMPLETED_CHILD_LIMIT = 256;

export interface WeshShellChild {
  readonly pid: number,
  readonly waitStatus: WeshWaitStatus | undefined,
  subscribe({ notify }: { notify: () => void }): () => void,
}

class WeshShellChildRecord implements WeshShellChild {
  readonly pid: number;
  readonly jobId: number | undefined;
  private status: WeshWaitStatus | undefined;
  private waiters: Set<() => void> | undefined;

  constructor({ pid, jobId }: { pid: number, jobId: number | undefined }) {
    this.pid = pid;
    this.jobId = jobId;
  }

  get waitStatus(): WeshWaitStatus | undefined {
    return this.status;
  }

  subscribe({ notify }: { notify: () => void }): () => void {
    if (this.status !== undefined) {
      return () => {};
    }
    const waiters = this.waiters ??= new Set();
    waiters.add(notify);
    return () => {
      if (waiters.delete(notify) && waiters.size === 0 && this.waiters === waiters) {
        this.waiters = undefined;
      }
    };
  }

  finish({ status }: { status: WeshWaitStatus }): void {
    this.status = status;
    const waiters = this.waiters;
    this.waiters = undefined;
    if (waiters !== undefined) {
      for (const notify of waiters) {
        waiters.delete(notify);
        notify();
      }
    }
  }
}

export class WeshShellChildren {
  private active: Map<number, WeshShellChildRecord> | undefined;
  private completed: Map<number, WeshShellChildRecord> | undefined;
  private mostRecentPid: number | undefined;
  private nextJobId = 1;

  constructor({ lastPid }: { lastPid: number | undefined }) {
    this.mostRecentPid = lastPid;
  }

  get lastPid(): number | undefined {
    return this.mostRecentPid;
  }

  register({ pid, job, task }: {
    pid: number,
    job: 'background' | 'process-substitution',
    task: Promise<WeshCommandResult>,
  }): void {
    if (this.get({ pid }) !== undefined) {
      throw new Error(`Child process PID already registered: ${pid}`);
    }
    let jobId: number | undefined;
    switch (job) {
    case 'background':
      jobId = this.nextJobId++;
      break;
    case 'process-substitution':
      break;
    default: {
      const _ex: never = job;
      throw new Error(`Unhandled waitable child: ${_ex}`);
    }
    }
    const child = new WeshShellChildRecord({ pid, jobId });
    (this.active ??= new Map()).set(pid, child);
    this.mostRecentPid = pid;

    const finish = ({ status }: { status: WeshWaitStatus }): void => {
      if (this.active?.get(pid) === child) {
        this.active.delete(pid);
        this.remember({ child });
      }
      child.finish({ status });
    };
    // The task settles after the child has released its descriptors and has been reaped.
    void task.then(
      ({ exitCode, waitStatus }) => finish({ status: waitStatus ?? { kind: 'exited', exitCode } }),
      () => finish({ status: { kind: 'exited', exitCode: 1 } }),
    );
  }

  private remember({ child }: { child: WeshShellChildRecord }): void {
    const completed = this.completed ??= new Map();
    completed.set(child.pid, child);
    if (completed.size > COMPLETED_CHILD_LIMIT) {
      for (const pid of completed.keys()) {
        if (pid !== this.mostRecentPid) {
          completed.delete(pid);
          break;
        }
      }
    }
  }

  get({ pid }: { pid: number }): WeshShellChild | undefined {
    return this.active?.get(pid) ?? this.completed?.get(pid);
  }

  snapshot(): WeshShellChild[] {
    return [...(this.active?.values() ?? []), ...(this.completed?.values() ?? [])];
  }

  forgetBackgroundJobs({ children }: { children: readonly WeshShellChild[] }): void {
    const completed = this.completed;
    if (completed === undefined) {
      return;
    }
    for (const child of children) {
      const remembered = completed.get(child.pid);
      if (remembered === child && remembered.jobId !== undefined) {
        completed.delete(child.pid);
      }
    }
  }

  listJobs(): { id: number, command: string, status: 'running' }[] {
    const jobs: { id: number, command: string, status: 'running' }[] = [];
    if (this.active !== undefined) {
      for (const { jobId } of this.active.values()) {
        if (jobId !== undefined) {
          jobs.push({ id: jobId, command: 'Background Job', status: 'running' });
        }
      }
    }
    return jobs;
  }

  clear(): void {
    this.active = undefined;
    this.completed = undefined;
    this.mostRecentPid = undefined;
    this.nextJobId = 1;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
