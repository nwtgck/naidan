import { LlamaCppBrowserError, type LlamaCppProfile, type RuntimeOptions } from '@/features/llama-cpp-browser/types';
import { parseRuntimeOptions } from './profile-policy-standalone';
import { decodeEmbeddedBrotli } from '@/features/file-protocol-standalone/embedded-binary';

const memory64Probe = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1]);
// Imports e.f(): i32 and exports run(): i32, which calls it. No model memory.
const suspensionProbe = new Uint8Array([
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

async function checkStorage(): Promise<void> {
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

export async function resolveRuntimeProfile({ profile }: { profile: RuntimeOptions['profile'] }): Promise<LlamaCppProfile> {
  parseRuntimeOptions({ options: { profile } });
  try {
    if (typeof WebAssembly === 'undefined' || !WebAssembly.validate(memory64Probe)) throw new Error('memory64');
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
    if (typeof navigator === 'undefined' || !navigator.gpu) throw new Error('WebGPU');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter?.features.has('shader-f16')) throw new Error('shader-f16');
    // Standalone intentionally ships only Brotli to reduce distribution size;
    // browser-side DecompressionStream('brotli') must remain standalone-only.
    // Hosted browser paths must not run this probe and retain gzip decoding.
    // Exercise a tiny known payload in the actual Worker, not User-Agent or
    // constructor presence. This also probes the integrity checker
    // without loading the multi-megabyte runtime chunk. The expected byte is 71.
    await decodeEmbeddedBrotli({
      base64: 'CwCARwM=', byteLength: 1,
      sha256: '333e0a1e27815d0ceee55c473fe3dc93d56c63e3bee2b3b4aee8eed6d70191a3',
    });
    await checkStorage();
    return 'webgpu-wasm64-jspi';
  } catch {
    // No browser-name rules or alternate profiles. Native initialization still
    // has the final say, including the pinned core's upstream version checks.
    throw new LlamaCppBrowserError({ code: 'unavailable' });
  }
}
export const TEST_ONLY = {
  memory64Probe,
  suspensionProbe,
  checkStorage,
};
