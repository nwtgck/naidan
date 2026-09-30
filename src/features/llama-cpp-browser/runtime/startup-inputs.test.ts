// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Core } from './core';
import type { loadWasmBinary, preloadCoreModule } from './artifacts';
import { loadRuntime } from './load-runtime';
import type { LlamaCppProfile } from '@/features/llama-cpp-browser/types';

const host = vi.hoisted(() => ({ binary: vi.fn<typeof loadWasmBinary>(), factory: vi.fn<typeof preloadCoreModule>(), create: vi.fn() }));
vi.mock('./artifacts', () => ({ loadWasmBinary: host.binary, preloadCoreModule: host.factory }));
vi.mock('./core', () => ({ createCore: host.create }));
let core: Core;
const profile: LlamaCppProfile = 'cpu-wasm32';
const assetBaseURL = 'https://example.invalid/runtime/';
const bytes = new Uint8Array([0, 97, 115, 109]);
async function turn(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}
beforeEach(() => {
  host.binary.mockReset().mockResolvedValue(bytes);
  host.factory.mockReset().mockResolvedValue(undefined);
  core = { api: { llama_backend_init: vi.fn(async () => {}), ggml_backend_dev_by_type: vi.fn(async () => 1n) }, constant: vi.fn(() => 2) } as unknown as Core;
  host.create.mockReset().mockResolvedValue(core);
  vi.stubGlobal('navigator', { gpu: {} });
  vi.stubGlobal('WebAssembly', { promising() {}, Suspending() {} });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('selected runtime startup inputs', () => {
  it.each(['binary', 'factory'] as const)('starts both inputs without waiting for %s and instantiates only after both finish', async first => {
    const binary = Promise.withResolvers<Uint8Array>(); const factory = Promise.withResolvers<void>();
    host.binary.mockReturnValueOnce(binary.promise); host.factory.mockReturnValueOnce(factory.promise);
    const pending = loadRuntime({ profile, assetBaseURL });
    expect(host.binary).toHaveBeenCalledExactlyOnceWith({ profile, assetBaseURL });
    expect(host.factory).toHaveBeenCalledExactlyOnceWith({ profile, baseURL: assetBaseURL });
    expect(host.create).not.toHaveBeenCalled();
    switch (first) {
    case 'binary': binary.resolve(bytes); break;
    case 'factory': factory.resolve(); break;
    default: { const exhaustive: never = first; throw new Error(String(exhaustive)); }
    }
    await turn(); expect(host.create).not.toHaveBeenCalled(); expect(core.api.llama_backend_init).not.toHaveBeenCalled();
    binary.resolve(bytes); factory.resolve();
    expect(await pending).toBe(core);
    expect(host.create).toHaveBeenCalledOnce();
    expect(host.create.mock.calls[0]![0].moduleOptions.wasmBinary).toBe(bytes);
    expect(core.api.llama_backend_init).toHaveBeenCalledOnce();
  });

  it.each(['binary', 'factory'] as const)('drains the other input when %s fails and never creates native state', async branch => {
    const binary = Promise.withResolvers<Uint8Array>(); const factory = Promise.withResolvers<void>();
    host.binary.mockReturnValueOnce(binary.promise); host.factory.mockReturnValueOnce(factory.promise);
    const failure = new Error('fixture failure'); let settled = false;
    const pending = loadRuntime({ profile, assetBaseURL }).then(() => ({ status: 'ready' as const }), error => ({ status: 'failed' as const, error })).finally(() => {
      settled = true;
    });
    switch (branch) {
    case 'binary': binary.reject(failure); break;
    case 'factory': factory.reject(failure); break;
    default: { const exhaustive: never = branch; throw new Error(String(exhaustive)); }
    }
    await turn(); expect(settled).toBe(false); expect(host.create).not.toHaveBeenCalled();
    binary.resolve(bytes); factory.resolve();
    expect(await pending).toEqual({ status: 'failed', error: failure });
    expect(host.create).not.toHaveBeenCalled(); expect(core.api.llama_backend_init).not.toHaveBeenCalled();
  });

  it.each(['binary', 'factory'] as const)('keeps binary error precedence when %s rejects first', async first => {
    const binary = Promise.withResolvers<Uint8Array>(); const factory = Promise.withResolvers<void>();
    host.binary.mockReturnValueOnce(binary.promise); host.factory.mockReturnValueOnce(factory.promise);
    const binaryFailure = new Error('binary'); const factoryFailure = new Error('factory');
    const pending = loadRuntime({ profile, assetBaseURL }).catch(error => error);
    if (first === 'binary') binary.reject(binaryFailure); else factory.reject(factoryFailure);
    await turn(); binary.reject(binaryFailure); factory.reject(factoryFailure);
    expect(await pending).toBe(binaryFailure); expect(host.create).not.toHaveBeenCalled();
  });

  it.each(['binary', 'factory'] as const)('observes a synchronous %s throw and still drains the other started input', async branch => {
    const failure = new Error('synchronous fixture failure');
    const binary = Promise.withResolvers<Uint8Array>(); const factory = Promise.withResolvers<void>();
    host.binary.mockReturnValueOnce(binary.promise); host.factory.mockReturnValueOnce(factory.promise);
    if (branch === 'binary') host.binary.mockReset().mockImplementation(() => {
      throw failure;
    });
    else host.factory.mockReset().mockImplementation(() => {
      throw failure;
    });
    let settled = false;
    const pending = loadRuntime({ profile, assetBaseURL }).catch(error => error).finally(() => {
      settled = true;
    });
    await turn(); expect(settled).toBe(false);
    expect(host.binary).toHaveBeenCalledOnce(); expect(host.factory).toHaveBeenCalledOnce();
    binary.resolve(bytes); factory.resolve();
    expect(await pending).toBe(failure); expect(host.create).not.toHaveBeenCalled();
  });

  it.each(['cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm32-jspi', 'webgpu-wasm64-jspi', 'webgpu-wasm32-asyncify'] as const)('acquires only %s and keeps module options and backend checks', async selected => {
    expect(await loadRuntime({ profile: selected, assetBaseURL })).toBe(core);
    expect(host.binary).toHaveBeenCalledExactlyOnceWith({ profile: selected, assetBaseURL });
    expect(host.factory).toHaveBeenCalledExactlyOnceWith({ profile: selected, baseURL: assetBaseURL });
    expect(host.create.mock.calls[0]![0]).toMatchObject({ profile: selected, baseURL: assetBaseURL, moduleOptions: { wasmBinary: bytes } });
    expect(core.api.ggml_backend_dev_by_type).toHaveBeenCalledTimes(selected.startsWith('webgpu') ? 1 : 0);
  });

  it('retains the standalone undefined URL for both acquisition paths', async () => {
    await loadRuntime({ profile: 'webgpu-wasm64-jspi', assetBaseURL: undefined });
    expect(host.factory).toHaveBeenCalledExactlyOnceWith({ profile: 'webgpu-wasm64-jspi', baseURL: undefined });
    expect(host.binary).toHaveBeenCalledExactlyOnceWith({ profile: 'webgpu-wasm64-jspi', assetBaseURL: undefined });
  });

  it.each(['webgpu-missing', 'jspi-missing'] as const)('checks %s before either startup input is acquired', async missing => {
    if (missing === 'webgpu-missing') vi.stubGlobal('navigator', {});
    else vi.stubGlobal('WebAssembly', {});
    await expect(loadRuntime({ profile: 'webgpu-wasm64-jspi', assetBaseURL })).rejects.toThrow('unavailable');
    expect(host.binary).not.toHaveBeenCalled(); expect(host.factory).not.toHaveBeenCalled(); expect(host.create).not.toHaveBeenCalled();
  });

  it('does not cache a failed acquisition or reuse a native instance on a later attempt', async () => {
    host.factory.mockRejectedValueOnce(new Error('temporary import error'));
    await expect(loadRuntime({ profile, assetBaseURL })).rejects.toThrow('temporary import error');
    await loadRuntime({ profile, assetBaseURL });
    expect(host.binary).toHaveBeenCalledTimes(2); expect(host.factory).toHaveBeenCalledTimes(2); expect(host.create).toHaveBeenCalledOnce();
  });

  it('does not suppress a factory or backend initialization failure', async () => {
    host.create.mockRejectedValueOnce(new Error('factory failed'));
    await expect(loadRuntime({ profile, assetBaseURL })).rejects.toThrow('factory failed');
    expect(core.api.llama_backend_init).not.toHaveBeenCalled();
    vi.mocked(core.api.llama_backend_init).mockRejectedValueOnce(new Error('backend failed'));
    await expect(loadRuntime({ profile, assetBaseURL })).rejects.toThrow('backend failed');
  });
});
