// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRuntimeProfile, TEST_ONLY } from './detect-profile-standalone';
import { installBrotliDecoderForTest } from '@/features/file-protocol-standalone/embedded-binary.test-support';

const actualWasm = WebAssembly;
function platform() {
  let bytes = new Uint8Array();
  const close = vi.fn();
  const read = vi.fn((destination: Uint8Array) => {
    destination.set(bytes); return bytes.length;
  });
  const sync = vi.fn(async () => ({ getSize: () => bytes.length, read, close }));
  const write = vi.fn(async (value: Uint8Array) => {
    bytes = value.slice();
  });
  const abort = vi.fn();
  const writableClose = vi.fn();
  const file = { createWritable: vi.fn(async () => ({ write, close: writableClose, abort })), createSyncAccessHandle: sync };
  const root = { getFileHandle: vi.fn(async (_name: string) => file), removeEntry: vi.fn(async () => {}) };
  const request = vi.fn(async (_name: string, operation: () => Promise<void>) => operation());
  const nav = { storage: { getDirectory: vi.fn(async () => root) }, locks: { request }, gpu: { requestAdapter: vi.fn(async () => ({ features: new Set(['shader-f16']) })) } };
  const wasm = { validate: vi.fn(() => true), instantiate: vi.fn(async () => ({ instance: { exports: { run: () => 7 } } })),
    Suspending: class {
      constructor(_callback: () => Promise<number>) {}
    }, promising: vi.fn(() => async () => 7) };
  return { nav, wasm, root, file, close, read, sync, write, abort, writableClose };
}
let environment: ReturnType<typeof platform>;
beforeEach(() => {
  installBrotliDecoderForTest();
  environment = platform(); vi.stubGlobal('navigator', environment.nav); vi.stubGlobal('WebAssembly', environment.wasm);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
describe('standalone Worker capability detection', () => {
  it('validates the actual small suspension probe independently of mocked capabilities', async () => {
    expect(actualWasm.validate(TEST_ONLY.suspensionProbe)).toBe(true);
    const probe = await actualWasm.instantiate(TEST_ONLY.suspensionProbe, { e: { f: () => 7 } });
    const run = probe.instance.exports.run;
    if (typeof run !== 'function') throw new Error('Missing probe export');
    expect(run()).toBe(7);
  });
  it('checks JSPI suspension and actual OPFS operations without reading User-Agent', async () => {
    Object.defineProperty(environment.nav, 'userAgent', { get() {
      throw new Error('Do not sniff browsers');
    } });
    await expect(resolveRuntimeProfile({ profile: 'webgpu-wasm64-jspi' })).resolves.toBe('webgpu-wasm64-jspi');
    expect(environment.wasm.promising).toHaveBeenCalledOnce();
    expect(environment.write).toHaveBeenCalledOnce();
    expect(environment.writableClose).toHaveBeenCalledOnce();
    expect(environment.close).toHaveBeenCalledOnce();
    expect(environment.nav.locks.request).toHaveBeenCalledOnce();
    const name = environment.root.getFileHandle.mock.calls[0]?.[0];
    expect(environment.root.removeEntry).toHaveBeenCalledWith(name);
  });
  it.each(['auto', 'cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm32-jspi', 'webgpu-wasm32-asyncify'] as const)('rejects non-embedded profile %s without probes', async profile => {
    await expect(resolveRuntimeProfile({ profile })).rejects.toThrow('unavailable');
    expect(environment.wasm.validate).not.toHaveBeenCalled();
  });
  it('rejects getDirectory even when its method exists', async () => {
    environment.nav.storage.getDirectory.mockRejectedValueOnce(new DOMException('blocked', 'SecurityError'));
    await expect(resolveRuntimeProfile({ profile: 'webgpu-wasm64-jspi' })).rejects.toThrow('unavailable');
    expect(environment.root.getFileHandle).not.toHaveBeenCalled();
  });
  it.each(['memory64', 'JSPI', 'suspension', 'adapter', 'f16', 'compression-api', 'brotli-format', 'brotli-data', 'hash', 'sync', 'locks'] as const)('does not silently fall back when %s is unavailable', async capability => {
    switch (capability) {
    case 'memory64': environment.wasm.validate.mockReturnValue(false); break;
    case 'JSPI': vi.stubGlobal('WebAssembly', { ...environment.wasm, promising: undefined }); break;
    case 'suspension': environment.wasm.promising.mockReturnValue(async () => 6); break;
    case 'adapter': environment.nav.gpu.requestAdapter.mockRejectedValue(new Error('no adapter')); break;
    case 'f16': environment.nav.gpu.requestAdapter.mockResolvedValue({ features: new Set() }); break;
    case 'compression-api': vi.stubGlobal('DecompressionStream', undefined); break;
    case 'brotli-format': vi.stubGlobal('DecompressionStream', class {
      constructor(format: string) {
        expect(format).toBe('brotli'); throw new TypeError('Unsupported format');
      }
    }); break;
    case 'brotli-data': vi.stubGlobal('DecompressionStream', class {
      // Accepts the format but decodes the known probe to the wrong byte.
      readonly readable = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new Uint8Array([72])); controller.close();
      } });
      readonly writable = new WritableStream();
    }); break;
    case 'hash': vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('denied')); break;
    case 'sync': environment.sync.mockRejectedValue(new Error('sync denied')); break;
    case 'locks': environment.nav.locks.request.mockRejectedValue(new Error('locks denied')); break;
    default: { const exhaustive: never = capability; throw new Error(exhaustive); }
    }
    await expect(resolveRuntimeProfile({ profile: 'webgpu-wasm64-jspi' })).rejects.toThrow('unavailable');
    if (capability === 'sync' || capability === 'locks') expect(environment.root.removeEntry).toHaveBeenCalledOnce();
  });
  it('closes sync handles after a read failure and removes only its own probe', async () => {
    environment.read.mockImplementationOnce(() => {
      throw new Error('read failed');
    });
    await expect(resolveRuntimeProfile({ profile: 'webgpu-wasm64-jspi' })).rejects.toThrow('unavailable');
    expect(environment.close).toHaveBeenCalledOnce();
    expect(environment.root.removeEntry).toHaveBeenCalledOnce();
  });
  it('aborts a failed writable before removing its temporary file', async () => {
    environment.write.mockRejectedValueOnce(new Error('write denied'));
    await expect(resolveRuntimeProfile({ profile: 'webgpu-wasm64-jspi' })).rejects.toThrow('unavailable');
    expect(environment.abort).toHaveBeenCalledOnce();
    expect(environment.sync).not.toHaveBeenCalled();
    expect(environment.root.removeEntry).toHaveBeenCalledOnce();
  });
});
