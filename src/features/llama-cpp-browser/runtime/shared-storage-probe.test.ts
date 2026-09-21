// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDirectory } from '@/features/llama-cpp-browser/hugging-face/test-opfs';
import { verifySharedStorage, verifyStorage } from './shared-storage-probe';

let root: ReturnType<typeof memoryDirectory>;
beforeEach(() => {
  root = memoryDirectory({ name: '' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals();
});
describe('window and Blob Worker OPFS agreement', () => {
  it('round-trips a nonce without touching model directories', async () => {
    const model = await root.getDirectoryHandle('existing-model', { create: true });
    await verifySharedStorage({ verify: verifyStorage, signal: undefined });
    expect([...root.children.keys()]).toEqual(['existing-model']);
    expect(root.children.get('existing-model')).toBe(model);
  });
  it('rejects a different worker storage key and cleans up the window probe', async () => {
    await expect(verifySharedStorage({ verify: async () => false, signal: undefined })).rejects.toThrow('unavailable');
    expect(root.children.size).toBe(0);
  });
  it('rejects arbitrary paths at the worker endpoint', async () => {
    await expect(verifyStorage({ probeId: '../model.gguf' })).rejects.toThrow();
  });
  it('removes the temporary file when cancellation interrupts a stalled worker', async () => {
    const entered = Promise.withResolvers<void>(); const controller = new AbortController();
    const operation = verifySharedStorage({ verify: () => {
      entered.resolve(); return new Promise(() => {});
    }, signal: controller.signal });
    const rejection = expect(operation).rejects.toThrow('aborted');
    await entered.promise; controller.abort(); await rejection;
    expect(root.children.size).toBe(0);
  });
  it('bounds an unresponsive storage verification without misclassifying it as unsupported', async () => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    const operation = verifySharedStorage({ verify: () => {
      entered.resolve(); return new Promise(() => {});
    }, signal: undefined });
    const rejection = expect(operation).rejects.toThrow('worker-failed');
    await entered.promise; await vi.advanceTimersByTimeAsync(10_000); await rejection;
    expect(root.children.size).toBe(0);
  });
});
