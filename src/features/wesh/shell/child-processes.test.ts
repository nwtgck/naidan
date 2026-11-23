import { assert, describe, expect, it, vi } from 'vitest';
import type { WeshCommandResult } from '@/features/wesh/types';
import { WeshShellChildren } from './child-processes';

describe('Wesh shell children', () => {
  it('initializes a fork with only the inherited last PID', () => {
    const children = new WeshShellChildren({ lastPid: 12 });

    expect(children.lastPid).toBe(12);
    expect(children.get({ pid: 12 })).toBeUndefined();
    expect(children.snapshot()).toEqual([]);
    expect(children.listJobs()).toEqual([]);
  });

  it('lists active background jobs and retains the final wait status for both child types', async () => {
    const children = new WeshShellChildren({ lastPid: undefined });
    const background = Promise.withResolvers<WeshCommandResult>();
    const substitution = Promise.withResolvers<WeshCommandResult>();
    children.register({ pid: 2, job: 'background', task: background.promise });
    children.register({ pid: 3, job: 'process-substitution', task: substitution.promise });
    const anotherBackground = Promise.resolve({ exitCode: 0 });
    children.register({ pid: 4, job: 'background', task: anotherBackground });

    expect(children.lastPid).toBe(4);
    expect(children.listJobs()).toEqual([
      { id: 1, command: 'Background Job', status: 'running' },
      { id: 2, command: 'Background Job', status: 'running' },
    ]);
    expect(children.get({ pid: 2 })?.waitStatus).toBeUndefined();
    expect(children.get({ pid: 3 })?.waitStatus).toBeUndefined();

    background.resolve({ exitCode: 143, waitStatus: { kind: 'signaled', signal: 15 } });
    substitution.resolve({ exitCode: 7 });
    await Promise.all([background.promise, substitution.promise, anotherBackground]);

    expect(children.listJobs()).toEqual([]);
    expect(children.lastPid).toBe(4);
    expect(children.get({ pid: 2 })?.waitStatus).toEqual({ kind: 'signaled', signal: 15 });
    expect(children.get({ pid: 3 })?.waitStatus).toEqual({ kind: 'exited', exitCode: 7 });
  });

  it('uses a single task reaction and removes interrupted observers', async () => {
    const children = new WeshShellChildren({ lastPid: undefined });
    const task = Promise.withResolvers<WeshCommandResult>();
    const then = vi.spyOn(task.promise, 'then');
    children.register({ pid: 2, job: 'background', task: task.promise });
    const child = children.get({ pid: 2 });
    assert(child !== undefined);
    const interrupted = vi.fn();
    for (let index = 0; index < 1_000; index += 1) {
      const unsubscribe = child.subscribe({ notify: interrupted });
      unsubscribe();
    }
    const first = vi.fn(() => child.waitStatus);
    const second = vi.fn(() => child.waitStatus);
    const unsubscribeFirst = child.subscribe({ notify: first });
    const unsubscribeSecond = child.subscribe({ notify: second });

    expect(then).toHaveBeenCalledTimes(1);
    task.resolve({ exitCode: 9 });
    await task.promise;

    expect(interrupted).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveReturnedWith({ kind: 'exited', exitCode: 9 });
    expect(second).toHaveBeenCalledTimes(1);
    unsubscribeFirst();
    unsubscribeSecond();
    const afterCompletion = vi.fn();
    child.subscribe({ notify: afterCompletion })();
    expect(afterCompletion).not.toHaveBeenCalled();
  });

  it('forgets completed background jobs selected by a wait and preserves other records', async () => {
    const children = new WeshShellChildren({ lastPid: undefined });
    const background = Promise.withResolvers<WeshCommandResult>();
    const substitution = Promise.withResolvers<WeshCommandResult>();
    children.register({ pid: 2, job: 'background', task: background.promise });
    children.register({ pid: 3, job: 'process-substitution', task: substitution.promise });
    const selected = children.snapshot();
    const later = Promise.resolve({ exitCode: 8 });
    children.register({ pid: 4, job: 'background', task: later });

    background.resolve({ exitCode: 6 });
    substitution.resolve({ exitCode: 7 });
    await Promise.all([background.promise, substitution.promise, later]);
    children.forgetBackgroundJobs({ children: selected });

    expect(children.lastPid).toBe(4);
    expect(children.get({ pid: 2 })).toBeUndefined();
    expect(children.get({ pid: 3 })?.waitStatus).toEqual({ kind: 'exited', exitCode: 7 });
    expect(children.get({ pid: 4 })?.waitStatus).toEqual({ kind: 'exited', exitCode: 8 });
    expect(selected[0]?.waitStatus).toEqual({ kind: 'exited', exitCode: 6 });

    children.forgetBackgroundJobs({ children: children.snapshot() });
    expect(children.lastPid).toBe(4);
    expect(children.get({ pid: 4 })).toBeUndefined();
  });

  it('bounds completed history, keeps active children and the last PID, and leaves snapshots usable', async () => {
    const completedChildLimit = 256;
    const children = new WeshShellChildren({ lastPid: undefined });
    const older = Promise.withResolvers<WeshCommandResult>();
    const lastPid = completedChildLimit + 5;
    for (let pid = 1; pid < lastPid; pid += 1) {
      children.register({ pid, job: 'background', task: older.promise });
    }
    const selected = children.get({ pid: 1 });
    const newest = Promise.resolve({ exitCode: 7 });
    children.register({ pid: lastPid, job: 'process-substitution', task: newest });
    await newest;

    expect(children.snapshot()).toHaveLength(lastPid);
    expect(children.get({ pid: 1 })?.waitStatus).toBeUndefined();
    older.resolve({ exitCode: 6 });
    await older.promise;

    expect(children.snapshot()).toHaveLength(completedChildLimit);
    expect(children.get({ pid: 1 })).toBeUndefined();
    expect(selected?.waitStatus).toEqual({ kind: 'exited', exitCode: 6 });
    expect(children.lastPid).toBe(lastPid);
    expect(children.get({ pid: lastPid })?.waitStatus).toEqual({ kind: 'exited', exitCode: 7 });

    const next = Promise.resolve({ exitCode: 0 });
    children.register({ pid: lastPid + 1, job: 'background', task: next });
    await next;
    expect(children.snapshot()).toHaveLength(completedChildLimit);
    expect(children.get({ pid: lastPid })).toBeUndefined();
  });

  it('records a failed child task as a nonzero exit', async () => {
    const children = new WeshShellChildren({ lastPid: undefined });
    const task = Promise.withResolvers<WeshCommandResult>();
    children.register({ pid: 2, job: 'background', task: task.promise });
    task.reject(new Error('Mock child cleanup failure'));
    await expect(task.promise).rejects.toThrow('Mock child cleanup failure');

    expect(children.listJobs()).toEqual([]);
    expect(children.get({ pid: 2 })?.waitStatus).toEqual({ kind: 'exited', exitCode: 1 });
  });

  it('does not restore cleared entries when an earlier child finishes', async () => {
    const children = new WeshShellChildren({ lastPid: 1 });
    const stale = Promise.withResolvers<WeshCommandResult>();
    const untracked = Promise.withResolvers<WeshCommandResult>();
    children.register({ pid: 2, job: 'background', task: stale.promise });
    children.register({ pid: 3, job: 'background', task: untracked.promise });
    const selected = children.snapshot();
    children.clear();

    expect(children.lastPid).toBeUndefined();
    expect(children.snapshot()).toEqual([]);
    const replacement = Promise.withResolvers<WeshCommandResult>();
    children.register({ pid: 2, job: 'background', task: replacement.promise });
    stale.resolve({ exitCode: 6 });
    untracked.resolve({ exitCode: 7 });
    await Promise.all([stale.promise, untracked.promise]);

    expect(children.listJobs()).toEqual([{ id: 1, command: 'Background Job', status: 'running' }]);
    expect(children.get({ pid: 2 })?.waitStatus).toBeUndefined();
    expect(children.get({ pid: 3 })).toBeUndefined();
    expect(selected[0]?.waitStatus).toEqual({ kind: 'exited', exitCode: 6 });
    replacement.resolve({ exitCode: 8 });
    await replacement.promise;
    children.forgetBackgroundJobs({ children: selected });
    expect(children.get({ pid: 2 })?.waitStatus).toEqual({ kind: 'exited', exitCode: 8 });
  });
});
