import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION, READABLE_STREAM_TRANSFER_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION } from './worker-transport-capabilities';
import { prepareWorkerCapability, workerCapability, TEST_ONLY } from './worker-transport';
import { installHandleCloneProbe, probeHandle } from './worker-capability-probe.test-support';

beforeEach(() => TEST_ONLY.resetCapabilitySupport());

afterEach(() => vi.useRealTimers());

const capability: typeof FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION = FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION;

describe('checked worker capabilities', () => {
  it('waits for successful receipt and identity verification before issuing a marker', async () => {
    using probe = installHandleCloneProbe();
    const handle = probeHandle(), gate = Promise.withResolvers<boolean>();
    handle.isSameEntry = () => gate.promise;
    const value = { nested: { files: [handle, handle] } };
    const settled = vi.fn();
    const pending = workerCapability({ value, capability }).then(result => {
      settled();
      return result;
    });
    await vi.waitFor(() => expect(probe.probes).toHaveLength(1));
    expect(settled).not.toHaveBeenCalled();
    gate.resolve(true);
    await expect(pending).resolves.toBe(value);
    expect(Object.getOwnPropertySymbols(value)).toEqual([]);
    expect(probe.closedPorts).toBe(2);
  });

  it('does not let a handle-free or directory-only request certify a file handle', async () => {
    using probe = installHandleCloneProbe({ mode: ({ handle }) => handle.kind === 'file' ? 'unsupported' : 'supported' });
    await workerCapability({ value: {}, capability });
    const directory = probeHandle({ kind: 'directory' }), file = probeHandle();
    await workerCapability({ value: { directory }, capability });
    await expect(workerCapability({ value: { file }, capability })).rejects.toThrow('capability is unavailable');
    expect(probe.probes).toEqual([directory, file]);
    expect(probe.closedPorts).toBe(4);
  });

  it('deduplicates concurrent checks without reusing another handle’s failure', async () => {
    const bad = probeHandle(), good = probeHandle();
    using probe = installHandleCloneProbe({ mode: ({ handle }) => handle === bad ? 'unsupported' : 'supported' });
    const fallback = vi.fn(async () => 'portable');
    const prepare = () => prepareWorkerCapability({ value: { bad }, capability, fallback });
    await Promise.all([prepare(), prepare()]);
    await workerCapability({ value: { good }, capability });
    expect(probe.probes).toEqual([bad, good]);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it.each(['messageerror', 'malformed'] as const)('does not certify %s receipt and releases both ports', async mode => {
    using probe = installHandleCloneProbe({ mode: () => mode });
    await expect(workerCapability({ value: { handle: probeHandle() }, capability })).rejects.toThrow('capability is unavailable');
    expect(probe.closedPorts).toBe(2);
  });

  it.each(['different-entry', 'rejected-identity', 'throwing-identity'] as const)('does not certify %s', async mode => {
    using probe = installHandleCloneProbe();
    const handle = probeHandle();
    handle.isSameEntry = () => {
      switch (mode) {
      case 'different-entry': return Promise.resolve(false);
      case 'rejected-identity': return Promise.reject(new Error('permission denied'));
      case 'throwing-identity': throw new Error('unusable handle');
      default: {
        const exhaustive: never = mode;
        throw new Error(String(exhaustive));
      }
      }
    };
    await expect(prepareWorkerCapability({ value: { handle }, capability, fallback: async () => 'portable' })).resolves.toBe('portable');
    expect(probe.closedPorts).toBe(2);
  });

  it('bounds a stalled probe and closes its ports', async () => {
    vi.useFakeTimers();
    using probe = installHandleCloneProbe({ mode: () => 'timeout' });
    const pending = prepareWorkerCapability({ value: { handle: probeHandle() }, capability, fallback: async () => 'portable' });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toBe('portable');
    expect(probe.closedPorts).toBe(2);
  });

  it('finds handles inside cyclic arrays, maps and sets without copying binary data', async () => {
    using probe = installHandleCloneProbe();
    const handle = probeHandle();
    const value: { map: Map<unknown, unknown>, set: Set<unknown>, file: File, bytes: Uint8Array, cycle?: object } = {
      map: new Map([[handle, [handle]]]),
      set: new Set([handle]),
      file: new File(['bytes'], 'model.gguf'),
      bytes: new Uint8Array(16),
    };
    value.cycle = value;
    await expect(workerCapability({ value, capability })).resolves.toBe(value);
    expect(probe.probes).toEqual([handle]);
    expect(value.bytes.byteLength).toBe(16);
  });

  it('does not consume the actual stream while detecting transfer support', async () => {
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(new Uint8Array([7]));
        controller.close();
      },
    });
    const result = await workerCapability({ value: stream, capability: READABLE_STREAM_TRANSFER_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION });
    expect(result).toBe(stream);
    expect(stream.locked).toBe(false);
    const reader = stream.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([7]));
    reader.releaseLock();
  });
});
