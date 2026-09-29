// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as artifacts from './artifacts';
import { attachCore, createCore, type Core } from './core';

describe('native call adaptation', () => {
  let core: Core;
  beforeAll(async () => {
    const baseURL = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/profiles') + '/');
    core = await createCore({ profile: 'cpu-wasm32', baseURL, moduleOptions: {
      wasmBinary: await readFile(new URL('cpu-wasm32/browser/core.wasm', baseURL)), print() {}, printErr() {},
    } });
  });
  afterEach(() => vi.restoreAllMocks());

  it('allows optional allocations to decline without hiding native traps', () => {
    let allocate = (): bigint => 0n;
    const module = new Proxy(core.module, { get(target, property) {
      return property === '_lcb_malloc' ? allocate : Reflect.get(target, property, target);
    } });
    const optionalCore = attachCore({ module, callMode: 'direct' });
    expect(optionalCore.tryAlloc({ bytes: 8 })).toBeUndefined();
    expect(() => optionalCore.alloc({ bytes: 8 })).toThrow('Native allocation failed');
    const trap = new WebAssembly.RuntimeError('fixture allocation trap');
    allocate = () => {
      throw trap;
    };
    expect(() => optionalCore.tryAlloc({ bytes: 8 })).toThrow(trap);
    expect(() => optionalCore.tryAlloc({ bytes: 0 })).toThrow('Allocation must be nonempty');
    const pointer = core.tryAlloc({ bytes: 8 });
    expect(pointer).toBeDefined();
    if (pointer !== undefined) core.free({ pointer });
  });

  it('uses direct Promise calls and bigint pointers for the wasm32 JSPI profile', async () => {
    const original = artifacts.loadCoreModule;
    // Substitute the real CPU32 module only at loading so this test also runs
    // without host JSPI. Exercise its call-mode selection and the wasm32 ABI.
    const load = vi.spyOn(artifacts, 'loadCoreModule').mockImplementationOnce(args => original({ ...args, profile: 'cpu-wasm32' }));
    const baseURL = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/profiles') + '/');
    const jspiCore = await createCore({ profile: 'webgpu-wasm32-jspi', baseURL, moduleOptions: {
      wasmBinary: await readFile(new URL('cpu-wasm32/browser/core.wasm', baseURL)), print() {}, printErr() {},
    } });
    const ccall = vi.spyOn(jspiCore.module, 'ccall');
    const pointer = jspiCore.allocRecord({ name: 'llama_model_params' });
    try {
      expect(load.mock.calls[0]?.[0].profile).toBe('webgpu-wasm32-jspi');
      expect(jspiCore.pointerBytes).toBe(4);
      await jspiCore.api.llama_model_default_params(pointer);
      expect(typeof pointer).toBe('bigint');
      expect(typeof await jspiCore.api.ggml_backend_dev_count()).toBe('bigint');
      expect(ccall).not.toHaveBeenCalled();
    } finally {
      jspiCore.free({ pointer });
    }
  });

  it('passes bigint pointers and record results through ccall on the existing wasm32 ABI', async () => {
    const asyncCore = attachCore({ module: core.module, callMode: 'asyncify' });
    const ccall = vi.spyOn(core.module, 'ccall');
    const params = asyncCore.allocRecord({ name: 'llama_model_params' });
    try {
      await asyncCore.api.llama_model_default_params(params);
      expect(ccall).toHaveBeenCalledWith('lcb_llama_model_default_params', undefined, ['bigint'], [params], { async: true });
      expect(asyncCore.bytes({ pointer: params, length: asyncCore.recordSize({ name: 'llama_model_params' }) }).some(byte => byte !== 0)).toBe(true);
      expect(typeof await asyncCore.api.ggml_backend_dev_count()).toBe('bigint');
      expect(ccall).toHaveBeenLastCalledWith('lcb_ggml_backend_dev_count', 'bigint', [], [], { async: true });
    } finally {
      asyncCore.free({ pointer: params });
    }
  });

  it('keeps native access serialized until suspension settles and releases the guard after rejection', async () => {
    const asyncCore = attachCore({ module: core.module, callMode: 'asyncify' });
    let finish: ((value: bigint) => void) | undefined;
    const ccall = vi.spyOn(core.module, 'ccall').mockImplementationOnce(() => new Promise<bigint>(resolve => {
      finish = resolve;
    }));
    const pending = asyncCore.api.ggml_backend_dev_count();
    await expect(asyncCore.api.ggml_backend_dev_count()).rejects.toThrow('Serialize access');
    expect(() => asyncCore.alloc({ bytes: 8 })).toThrow('Serialize access');
    expect(ccall).toHaveBeenCalledOnce();
    if (!finish) throw new Error('Expected a pending native call');
    finish(7n);
    await expect(pending).resolves.toBe(7n);
    ccall.mockRejectedValueOnce(new Error('native suspension failed'));
    await expect(asyncCore.api.ggml_backend_dev_count()).rejects.toThrow('native suspension failed');
    expect(() => asyncCore.assertIdle()).not.toThrow();
    expect(typeof await asyncCore.api.ggml_backend_dev_count()).toBe('bigint');
  });
});
