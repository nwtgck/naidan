import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertOpfsFileLease, OpfsResourceBusyError, withOpfsFileLease, withOpfsModelDeletion, withOpfsRootDeletion, type OpfsFileLease } from './opfs-access';
import { createOpfsModelCache } from './opfs-model-cache';
import { createMemoryFiles } from '@/features/transformers-js/replay-models/support/download-memory-files';
import { writeToOpfs } from '@/features/transformers-js/utils';

import { createLockQueue } from '@/features/transformers-js/replay-models/support/opfs-lock-test-platform';

const path = 'models/huggingface.co/fixture/model/resolve/revision/onnx/model.onnx';
afterEach(() => vi.unstubAllGlobals());

describe('Cooperative OPFS access', () => {
  it('makes an actual offline cache lookup busy rather than absent while a file writer owns it', async () => {
    const q = createLockQueue();
    const fs = createMemoryFiles();
    fs.enter({ nextPhase: 'seed', mutationPolicy: 'read-write' });
    vi.stubGlobal('navigator', { locks: q.locks, storage: { getDirectory: async () => fs.root } });
    vi.stubGlobal('self', { location: new URL('http://localhost') });
    await writeToOpfs({ path, response: new Response(Uint8Array.of(1, 2, 3, 4)) });
    fs.enter({ nextPhase: 'offline', mutationPolicy: 'read-only' });
    const observations = vi.fn();
    const cache = createOpfsModelCache({ revisionAliases: [], mutationPolicy: 'read-only', onMatchObservation: observations });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = withOpfsFileLease({ path, mode: 'exclusive', availability: 'wait', signal: undefined, run: async () => {
      entered.resolve();
      await release.promise;
    } });
    await entered.promise;
    const url = 'https://huggingface.co/fixture/model/resolve/revision/onnx/model.onnx';
    try {
      await expect(cache.match(url)).rejects.toBeInstanceOf(OpfsResourceBusyError);
      expect(observations).not.toHaveBeenCalled();
      expect(fs.activity.filter(item => item.phase === 'offline')).toEqual([]);
    } finally {
      release.resolve();
      await writer;
    }
    const result = await cache.match(url);
    expect([...new Uint8Array(await result!.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect(observations).toHaveBeenCalledExactlyOnceWith({ observation: { requestedPath: 'huggingface.co/fixture/model/resolve/revision/onnx/model.onnx', result: 'hit', bytes: 4 } });
    expect(fs.activity.filter(item => item.phase === 'offline').map(item => item.operation)).toEqual(['stat', 'body-read']);
  });

  it('holds same-file writers and parent deletion until actual cleanup settles', async () => {
    const q = createLockQueue();
    vi.stubGlobal('navigator', { locks: q.locks });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    const first = withOpfsFileLease({ path, mode: 'exclusive', availability: 'wait', signal: undefined, run: async () => {
      entered.resolve();
      await release.promise;
      events.push('cleanup-complete');
    } });
    await entered.promise;
    const second = withOpfsFileLease({ path, mode: 'exclusive', availability: 'wait', signal: undefined, run: async () => {
      events.push('second');
    } });
    const deletion = withOpfsRootDeletion({ run: async () => {
      events.push('delete');
    } });
    await Promise.resolve();
    expect(events).toEqual([]);
    expect(q.held.size).toBe(3);
    release.resolve();
    await Promise.all([first, second, deletion]);
    expect(events[0]).toBe('cleanup-complete');
    expect(events).toContain('second');
    expect(events).toContain('delete');
    expect(q.held.size).toBe(0);
    expect(q.queued).toEqual([]);
  });

  it('allows simultaneous shared completed-file snapshots and independent file writers', async () => {
    const q = createLockQueue();
    vi.stubGlobal('navigator', { locks: q.locks });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = withOpfsFileLease({ path, mode: 'shared', availability: 'immediate', signal: undefined, run: async () => {
      entered.resolve();
      await release.promise;
    } });
    await entered.promise;
    const snapshot = await withOpfsFileLease({ path, mode: 'shared', availability: 'immediate', signal: undefined, run: async () => 4 });
    const other = await withOpfsFileLease({ path: `${path}_data`, mode: 'exclusive', availability: 'wait', signal: undefined, run: async () => 8 });
    expect(snapshot).toBe(4);
    expect(other).toBe(8);
    await expect(withOpfsFileLease({ path, mode: 'exclusive', availability: 'immediate', signal: undefined, run: async () => 0 })).rejects.toBeInstanceOf(OpfsResourceBusyError);
    release.resolve();
    await first;
  });

  it('does not downgrade a lock API failure to uncoordinated access', async () => {
    const failure = new DOMException('Synthetic denied lock', 'SecurityError');
    vi.stubGlobal('navigator', { locks: { request: () => {
      throw failure;
    } } });
    const run = vi.fn(async () => 4);
    await expect(withOpfsFileLease({ path, mode: 'exclusive', availability: 'wait', signal: undefined, run })).rejects.toBe(failure);
    expect(run).not.toHaveBeenCalled();
  });

  it('shares the model namespace across file access and deletion without blocking unrelated models', async () => {
    const q = createLockQueue();
    vi.stubGlobal('navigator', { locks: q.locks });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let deleted = false;
    const reader = withOpfsFileLease({ path, mode: 'shared', availability: 'wait', signal: undefined, run: async () => {
      entered.resolve();
      await release.promise;
    } });
    await entered.promise;
    const deletion = withOpfsModelDeletion({ modelPath: 'models/huggingface.co/fixture/model', run: async () => {
      deleted = true;
    } });
    const unrelated = await withOpfsFileLease({ path: 'models/huggingface.co/fixture/other/resolve/revision/onnx/model.onnx', mode: 'exclusive', availability: 'wait', signal: undefined, run: async () => 4 });
    expect(unrelated).toBe(4);
    expect(deleted).toBe(false);
    release.resolve();
    await Promise.all([reader, deletion]);
    expect(deleted).toBe(true);
  });

  it('rejects pre-aborted access even without the lock API', async () => {
    vi.stubGlobal('navigator', {});
    const controller = new AbortController();
    const reason = new Error('Synthetic canceled access');
    controller.abort(reason);
    const run = vi.fn(async () => 4);
    await expect(withOpfsFileLease({ path, mode: 'exclusive', availability: 'wait', signal: controller.signal, run })).rejects.toBe(reason);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects parent paths at the model-only deletion boundary before invoking the callback', async () => {
    const q = createLockQueue();
    vi.stubGlobal('navigator', { locks: q.locks });
    const run = vi.fn(async () => undefined);
    for (const modelPath of ['models', 'models/huggingface.co', 'models/huggingface.co/fixture', 'models/user', 'models/local']) {
      await expect(withOpfsModelDeletion({ modelPath, run })).rejects.toThrow('complete model directory');
    }
    expect(run).not.toHaveBeenCalled();
    expect(q.events).toEqual([]);
  });

  it('keeps unsupported legacy access explicit and revokes escaped file leases', async () => {
    vi.stubGlobal('navigator', {});
    let escaped: OpfsFileLease | undefined;
    const result = await withOpfsFileLease({ path, mode: 'exclusive', availability: 'wait', signal: undefined, run: async ({ lease }) => {
      escaped = lease;
      assertOpfsFileLease({ path, mode: 'exclusive', lease });
      return lease.coordinated;
    } });
    expect(result).toBe(false);
    expect(escaped).toBeDefined();
    expect(() => assertOpfsFileLease({ path, mode: 'exclusive', lease: escaped! })).toThrow('active matching lease');
  });
});
