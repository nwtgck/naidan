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
    const baseURL = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/llama-cpp-browser-core/profiles') + '/');
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
    const baseURL = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/llama-cpp-browser-core/profiles') + '/');
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
  it('reuses only signature metadata while keeping call values independent', async () => {
    const asyncCore = attachCore({ module: core.module, callMode: 'asyncify' });
    const ccall = vi.spyOn(core.module, 'ccall').mockReturnValue(0);
    await asyncCore.api.llama_tokenize(0n, 0n, 1, 0n, 2, 0, 1);
    await asyncCore.api.llama_tokenize(0n, 0n, 3, 0n, 4, 1, 1);
    expect(ccall).toHaveBeenNthCalledWith(1, 'lcb_llama_tokenize', 'number',
      ['bigint', 'bigint', 'number', 'bigint', 'number', 'number', 'number'], [0n, 0n, 1, 0n, 2, 0, 1], { async: true });
    expect(ccall.mock.calls[0]![2]).toBe(ccall.mock.calls[1]![2]);
    expect(ccall.mock.calls[0]![3]).not.toBe(ccall.mock.calls[1]![3]);
    await asyncCore.api.llama_batch_get_one(0n, 0n, 1);
    await asyncCore.api.llama_batch_get_one(0n, 0n, 2);
    expect(ccall.mock.calls[2]![2]).toEqual(['bigint', 'bigint', 'number']);
    expect(ccall.mock.calls[2]![1]).toBeUndefined(); // Hidden record destination.
    expect(ccall.mock.calls[2]![2]).toBe(ccall.mock.calls[3]![2]);
    expect(ccall.mock.calls[0]![2]).not.toBe(ccall.mock.calls[2]![2]);
  });

  it.each(['direct', 'asyncify'] as const)('validates every call with cached metadata in %s mode', async callMode => {
    const bound = attachCore({ module: core.module, callMode });
    const ccall = vi.spyOn(core.module, 'ccall');
    const invalid: unknown[][] = [
      [], [0n, 0n, 0, 0n, 0, 0, 1, 0],
      [0, 0n, 0, 0n, 0, 0, 1], [-1n, 0n, 0, 0n, 0, 0, 1],
      [1n << 64n, 0n, 0, 0n, 0, 0, 1], [0n, 0n, NaN, 0n, 0, 0, 1],
      [0n, 0n, 0.5, 0n, 0, 0, 1], [0n, 0n, 2147483648, 0n, 0, 0, 1],
      [0n, 0n, 0, 0n, 0, 2, 1],
    ];
    for (const args of invalid) {
      await expect(Reflect.apply(bound.api.llama_tokenize, undefined, args)).rejects.toThrow();
      expect(() => bound.assertIdle()).not.toThrow();
    }
    expect(ccall).not.toHaveBeenCalled();
    expect(typeof await bound.api.ggml_backend_dev_count()).toBe('bigint');
  });

  it.each(['string', 'record'] as const)('releases an unpublished %s allocation when the current heap rejects initialization', kind => {
    let truncated = false; const freed: bigint[] = [];
    const module = new Proxy(core.module, { get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property === 'HEAPU8' && truncated) return new Uint8Array(0);
      if (property === '_lcb_malloc') return (...args: bigint[]) => {
        if (typeof value !== 'function') throw new Error('Missing fixture allocation');
        const pointer: unknown = Reflect.apply(value, target, args); truncated = true; return pointer;
      };
      if (property === '_lcb_free') return (pointer: bigint) => {
        if (typeof value !== 'function') throw new Error('Missing fixture release');
        freed.push(pointer); return Reflect.apply(value, target, [pointer]);
      };
      return value;
    } });
    const bound = attachCore({ module, callMode: 'direct' });
    const run = () => kind === 'string' ? bound.utf8({ text: 'owned native string' }) : bound.allocRecord({ name: 'llama_batch' });
    expect(run).toThrow('out of bounds'); expect(freed).toHaveLength(1); expect(freed[0]).not.toBe(0n);
    truncated = false;
  });

});
