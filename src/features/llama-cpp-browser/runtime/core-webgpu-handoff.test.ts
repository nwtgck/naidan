import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCore } from './core';
import type { CoreModuleOptions } from './artifacts';

const host = vi.hoisted(() => ({ load: vi.fn<typeof import('./artifacts').loadCoreModule>() }));
vi.mock('./artifacts', () => ({ loadCoreModule: host.load }));
// Stop at the native-loader handoff: this suite does not need a native ABI or
// tensor fixture, and must not accidentally initialize Wasm or a GPU device.
vi.mock('llama-cpp-browser-core/api/schema.mjs', () => ({
  default: {
    abiVersion: 1,
    schemaSha256: 'factory-handoff-fixture',
    constants: [],
    records: [],
    functions: [],
  },
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe('core-factory WebGPU scope', () => {
  it.each(['cpu-wasm32', 'webgpu-wasm64-jspi-gpu-profile', 'webgpu-wasm32-asyncify', 'webgpu-wasm32-jspi', 'webgpu-wasm64-jspi'] as const)(
    'scopes the GPU facade to the %s factory without probing or altering browser globals', async profile => {
      const requestAdapter = vi.fn();
      const navigator = { gpu: { requestAdapter } };
      vi.stubGlobal('navigator', navigator);
      const handoff = new Error('loader handoff fixture');
      host.load.mockRejectedValueOnce(handoff);
      const moduleOptions = { wasmBinary: new Uint8Array([0]), print() {}, printErr() {} };
      await expect(createCore({ profile, baseURL: 'https://fixture.invalid/', moduleOptions })).rejects.toBe(handoff);
      const options = host.load.mock.calls[0]![0].moduleOptions;
      expect(options.wasmBinary).toBe(moduleOptions.wasmBinary.buffer);
      expect(globalThis.navigator).toBe(navigator);
      expect(requestAdapter).not.toHaveBeenCalled();
      if (profile.startsWith('webgpu-')) {
        expect(options.hostNavigator).toBeDefined();
        expect(options.hostNavigator).not.toBe(navigator);
      } else {
        expect(options.print).toBe(moduleOptions.print);
        expect(options.printErr).toBe(moduleOptions.printErr);
        expect(options).not.toHaveProperty('hostNavigator');
      }
    },
  );

  it('preserves a supplied complete ArrayBuffer without another payload copy', async () => {
    const wasmBinary = new Uint8Array([0, 97, 115, 109]).buffer;
    const handoff = new Error('loader handoff fixture');
    host.load.mockRejectedValueOnce(handoff);
    await expect(createCore({ profile: 'cpu-wasm32', baseURL: 'https://fixture.invalid/', moduleOptions: { wasmBinary, print() {}, printErr() {} } })).rejects.toBe(handoff);
    expect(host.load.mock.calls[0]![0].moduleOptions.wasmBinary).toBe(wasmBinary);
  });

  it('copies only the selected span of a partial view into the factory buffer', async () => {
    const storage = new Uint8Array([255, 0, 97, 115, 109, 255]);
    const wasmBinary = storage.subarray(1, 5);
    const handoff = new Error('loader handoff fixture');
    host.load.mockRejectedValueOnce(handoff);
    await expect(createCore({ profile: 'cpu-wasm32', baseURL: 'https://fixture.invalid/', moduleOptions: { wasmBinary, print() {}, printErr() {} } })).rejects.toBe(handoff);
    const supplied = host.load.mock.calls[0]![0].moduleOptions.wasmBinary;
    if (!(supplied instanceof ArrayBuffer)) {
      throw new Error('Expected an exact factory buffer');
    }
    expect(supplied).not.toBe(storage.buffer);
    expect(new Uint8Array(supplied)).toEqual(new Uint8Array([0, 97, 115, 109]));
  });

  it('copies a shared byte view into an ordinary factory buffer', async () => {
    const wasmBinary = new Uint8Array(new SharedArrayBuffer(4));
    wasmBinary.set([0, 97, 115, 109]);
    const handoff = new Error('loader handoff fixture');
    host.load.mockRejectedValueOnce(handoff);
    await expect(createCore({ profile: 'cpu-wasm32', baseURL: 'https://fixture.invalid/', moduleOptions: { wasmBinary, print() {}, printErr() {} } })).rejects.toBe(handoff);
    const supplied = host.load.mock.calls[0]![0].moduleOptions.wasmBinary;
    if (!(supplied instanceof ArrayBuffer)) {
      throw new Error('Expected an ordinary factory buffer');
    }
    expect(new Uint8Array(supplied)).toEqual(wasmBinary);
  });

  it.each([undefined, new Uint8Array(), new ArrayBuffer(0)])('rejects missing or empty Wasm input before loading a factory: %s', async wasmBinary => {
    await expect(createCore({
      profile: 'cpu-wasm32',
      baseURL: 'https://fixture.invalid/',
      moduleOptions: { wasmBinary, print() {}, printErr() {} } as CoreModuleOptions,
    })).rejects.toThrow('Browser core requires supplied wasmBinary');
    expect(host.load).not.toHaveBeenCalled();
  });
});
