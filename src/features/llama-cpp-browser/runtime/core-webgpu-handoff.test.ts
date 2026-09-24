import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCore } from './core';

const host = vi.hoisted(() => ({ load: vi.fn<typeof import('./artifacts').loadCoreModule>() }));
vi.mock('./artifacts', () => ({ loadCoreModule: host.load }));
// Stop at the native-loader handoff: this suite does not need a native ABI or
// tensor fixture, and must not accidentally initialize Wasm or a GPU device.
vi.mock('llama-cpp-browser-core/api/schema.mjs', () => ({ default: {
  abiVersion: 1, schemaSha256: 'factory-handoff-fixture', constants: [], records: [], functions: [],
} }));
afterEach(() => {
  vi.resetAllMocks(); vi.unstubAllGlobals();
});

describe('core-factory WebGPU scope', () => {
  it.each(['cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm32-asyncify', 'webgpu-wasm32-jspi', 'webgpu-wasm64-jspi'] as const)(
    'scopes the GPU facade to the %s factory without probing or altering browser globals', async profile => {
      const requestAdapter = vi.fn();
      const navigator = { gpu: { requestAdapter } };
      vi.stubGlobal('navigator', navigator);
      const handoff = new Error('loader handoff fixture');
      host.load.mockRejectedValueOnce(handoff);
      const moduleOptions = { wasmBinary: new Uint8Array([0]), print() {}, printErr() {} };
      await expect(createCore({ profile, baseURL: 'https://fixture.invalid/', moduleOptions })).rejects.toBe(handoff);
      const options = host.load.mock.calls[0]![0].moduleOptions;
      expect(options.wasmBinary).toBe(moduleOptions.wasmBinary);
      expect(globalThis.navigator).toBe(navigator);
      expect(requestAdapter).not.toHaveBeenCalled();
      if (profile.startsWith('webgpu-')) {
        expect(options.naidanNavigator).toBeDefined();
        expect(options.naidanNavigator).not.toBe(navigator);
      } else {
        expect(options).toBe(moduleOptions);
        expect(options).not.toHaveProperty('naidanNavigator');
      }
    },
  );
});
