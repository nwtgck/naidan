// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCoreModule as loadHostedModule, preloadCoreModule as preloadHostedModule } from './artifacts';
import { loadCoreModule as loadStandaloneModule, preloadCoreModule as preloadStandaloneModule } from './artifacts-standalone';

const host = vi.hoisted(() => ({
  factories: {
    'cpu-wasm32': vi.fn(),
    'cpu-wasm64': vi.fn(),
    'webgpu-wasm32-asyncify': vi.fn(),
    'webgpu-wasm32-jspi': vi.fn(),
    'webgpu-wasm64-jspi': vi.fn(),
  },
  bind: vi.fn(),
}));
vi.mock('virtual:llama-cpp-browser-core/cpu-wasm32', () => ({ default: host.factories['cpu-wasm32'] }));
vi.mock('virtual:llama-cpp-browser-core/cpu-wasm64', () => ({ default: host.factories['cpu-wasm64'] }));
vi.mock('virtual:llama-cpp-browser-core/webgpu-wasm32-asyncify', () => ({ default: host.factories['webgpu-wasm32-asyncify'] }));
vi.mock('virtual:llama-cpp-browser-core/webgpu-wasm32-jspi', () => ({ default: host.factories['webgpu-wasm32-jspi'] }));
vi.mock('virtual:llama-cpp-browser-core/webgpu-wasm64-jspi', () => ({ default: host.factories['webgpu-wasm64-jspi'] }));
vi.mock('./chat-bindings', () => ({ bindNativeChat: host.bind }));
const module = { fixture: 'native module' };
const chat = { fixture: 'chat bindings' };
const moduleOptions = { wasmBinary: new Uint8Array([0, 97, 115, 109]), print() {}, printErr() {} };
beforeEach(() => {
  for (const factory of Object.values(host.factories)) factory.mockReset().mockResolvedValue(module);
  host.bind.mockReset().mockReturnValue(chat);
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Factory preload must not fetch Wasm');
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('factory-only runtime preloads', () => {
  it.each(['cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm32-asyncify', 'webgpu-wasm32-jspi', 'webgpu-wasm64-jspi'] as const)('imports hosted %s without instantiation and passes options only when requested', async profile => {
    const baseURL = 'https://example.invalid/runtime/';
    await preloadHostedModule({ profile, baseURL });
    await preloadHostedModule({ profile, baseURL });
    for (const factory of Object.values(host.factories)) expect(factory).not.toHaveBeenCalled();
    expect(host.bind).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(await loadHostedModule({ profile, baseURL, moduleOptions })).toEqual({ module, chat });
    expect(host.factories[profile]).toHaveBeenCalledExactlyOnceWith(moduleOptions);
    for (const [key, factory] of Object.entries(host.factories)) if (key !== profile) expect(factory).not.toHaveBeenCalled();
    expect(host.bind).toHaveBeenCalledExactlyOnceWith({ native: module });
  });
  it.each(['webgpu-wasm32-jspi', 'webgpu-wasm64-jspi'] as const)('keeps %s standalone loading lazy and local', async profile => {
    await preloadStandaloneModule({ profile, baseURL: undefined });
    for (const factory of Object.values(host.factories)) expect(factory).not.toHaveBeenCalled();
    expect(host.bind).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(await loadStandaloneModule({ profile, baseURL: undefined, moduleOptions })).toEqual({ module, chat });
    expect(host.factories[profile]).toHaveBeenCalledExactlyOnceWith(moduleOptions);
    for (const [key, factory] of Object.entries(host.factories)) if (key !== profile) expect(factory).not.toHaveBeenCalled();
  });
  it.each(['cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm32-asyncify'] as const)('rejects non-embedded standalone %s without instantiating or fetching', async profile => {
    await expect(preloadStandaloneModule({ profile, baseURL: undefined })).rejects.toThrow('unavailable');
    for (const factory of Object.values(host.factories)) expect(factory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['webgpu-wasm32-jspi', 'webgpu-wasm64-jspi'] as const)('does not let an external URL override standalone %s', async profile => {
    await expect(preloadStandaloneModule({ profile, baseURL: 'https://example.invalid/runtime/' })).rejects.toThrow('unavailable');
    for (const factory of Object.values(host.factories)) expect(factory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects an absent hosted base URL before acquisition', async () => {
    await expect(preloadHostedModule({ profile: 'cpu-wasm32', baseURL: undefined })).rejects.toThrow('runtime-error');
    for (const factory of Object.values(host.factories)) expect(factory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
