import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import type { ProfileUnavailableReason } from './profile-capabilities';

export const memory64Probe = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1]);
// Imports e.f(): i32 and exports run(): i32, which calls it. No model memory.
export const suspensionProbe = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 5, 1, 96, 0, 1, 127,
  2, 7, 1, 1, 101, 1, 102, 0, 0,
  3, 2, 1, 0,
  7, 7, 1, 3, 114, 117, 110, 0, 1,
  10, 6, 1, 4, 0, 16, 0, 11,
]);
type PromiseIntegration = {

  Suspending: new (callback: () => Promise<number>) => WebAssembly.ImportValue,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Browser JSPI API signature.
  promising: (callback: WebAssembly.ExportValue) => () => Promise<number>,
};

export async function checkStorage(): Promise<void> {
  // Run in the actual inference Worker. Property presence alone is insufficient
  // on file://; opening the directory or its sync handle can still be denied.
  const root = await navigator.storage.getDirectory();
  const name = `.naidan-llama-probe-${crypto.randomUUID()}`;
  let created = false;
  try {
    const file = await root.getFileHandle(name, { create: true });
    created = true;
    const writable = await file.createWritable();
    try {
      await writable.write(new Uint8Array([71]));
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
    const syncFile = file as FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<{
      getSize(): number,
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Native OPFS signature.
      read(destination: Uint8Array, options: { at: number }): number,
      close(): void,
    }> };
    if (typeof syncFile.createSyncAccessHandle !== 'function') throw new Error('OPFS sync access');
    const handle = await syncFile.createSyncAccessHandle();
    try {
      const bytes = new Uint8Array(1);
      if (handle.getSize() !== 1 || handle.read(bytes, { at: 0 }) !== 1 || bytes[0] !== 71) {
        throw new LlamaCppBrowserError({ code: 'unavailable' });
      }
    } finally {
      handle.close();
    }
    await navigator.locks.request(name, async () => {});
  } finally {
    if (created) await root.removeEntry(name);
  }
}

export function supportsMemory64(): boolean {
  try {
    return typeof WebAssembly !== 'undefined' && WebAssembly.validate(memory64Probe);
  } catch {
    return false;
  }
}
export async function checkJspi(): Promise<void> {
  if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly');
  const wasm: object = WebAssembly;
  if (!('promising' in wasm) || typeof wasm.promising !== 'function'
    || !('Suspending' in wasm) || typeof wasm.Suspending !== 'function') throw new Error('JSPI');
  const integration = wasm as PromiseIntegration;
  const probe = await WebAssembly.instantiate(suspensionProbe, { e: { f: new integration.Suspending(async () => {
    await Promise.resolve();
    return 7;
  }) } });
  const run = probe.instance.exports.run;
  if (typeof run !== 'function' || await integration.promising(run)() !== 7) throw new Error('JSPI suspension');
}
export async function gpuUnavailableReason(): Promise<Extract<ProfileUnavailableReason, 'webgpu' | 'shader-f16'> | undefined> {
  if (typeof navigator === 'undefined' || !navigator.gpu) return 'webgpu';
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return 'webgpu';
    return adapter.features.has('shader-f16') ? undefined : 'shader-f16';
  } catch {
    return 'webgpu';
  }
}
export const TEST_ONLY = {
};
