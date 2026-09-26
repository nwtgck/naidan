import { afterEach, expect, it, vi } from 'vitest';
import { initialProfile, supportsMemory64 } from './capabilities';
afterEach(() => vi.unstubAllGlobals());
it('selects a local capability profile without creating a Worker or requesting an adapter', () => {
  const worker = vi.fn(), fetch = vi.fn(); vi.stubGlobal('Worker', worker); vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('WebAssembly', { validate: () => true, Suspending: class {}, promising: () => undefined });
  expect(initialProfile()).toBe('webgpu-wasm64-jspi'); expect(worker).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  vi.stubGlobal('WebAssembly', { validate: () => false, Suspending: class {}, promising: () => undefined });
  expect(initialProfile()).toBe('webgpu-wasm32-jspi');
  vi.stubGlobal('WebAssembly', { validate: () => true }); expect(initialProfile()).toBe('webgpu-wasm32-asyncify');
});
it('handles a disabled WebAssembly implementation', () => {
  vi.stubGlobal('WebAssembly', undefined); expect(initialProfile()).toBe('webgpu-wasm32-asyncify'); expect(supportsMemory64()).toBe(false);
});
