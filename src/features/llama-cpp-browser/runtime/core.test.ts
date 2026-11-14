// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import catalog from 'llama-cpp-browser-core/llama-cpp/api/schema.mjs';
import { createAbiCaller } from 'llama-cpp-browser-core/llama-cpp/host/abi';
import * as artifacts from './artifacts';
import { readGpuRequests } from './webgpu-request-diagnostics';
import { attachCore, createCore, type Core } from './core';

describe('native call adaptation', () => {
  let core: Core;

  beforeAll(async () => {
    const baseURL = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/runtimes/llama-cpp-browser-core/profiles') + '/');
    core = await createCore({
      profile: 'cpu-wasm32',
      baseURL,
      moduleOptions: {
        wasmBinary: await readFile(new URL('cpu-wasm32/browser/core.wasm', baseURL)),
        print() {},
        printErr() {},
      },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('allows optional allocations to decline without hiding native traps', () => {
    let allocate = (): number => 0;
    const module = new Proxy(core.module, {
      get(target, property) {
        return property === '_malloc' ? allocate : Reflect.get(target, property, target);
      },
    });
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
    if (pointer !== undefined) {
      core.free({ pointer });
    }
  });

  it.each(['webgpu-wasm32-jspi', 'webgpu-wasm64-jspi'] as const)('keeps direct synchronous metadata and GPU observation for %s', async profile => {
    const original = artifacts.loadCoreModule;
    // Substitute the real CPU32 module only at loading so this test also runs
    // without host JSPI. Exercise profile routing against a real wasm32 ABI,
    // not execution of either WebGPU or a wasm64 binary.
    const load = vi.spyOn(artifacts, 'loadCoreModule').mockImplementationOnce(args => original({ ...args, profile: 'cpu-wasm32' }));
    const baseURL = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/runtimes/llama-cpp-browser-core/profiles') + '/');
    const jspiCore = await createCore({
      profile,
      baseURL,
      moduleOptions: {
        wasmBinary: await readFile(new URL('cpu-wasm32/browser/core.wasm', baseURL)),
        print() {},
        printErr() {},
      },
    });
    const ccall = vi.spyOn(jspiCore.module, 'ccall');
    const pointer = jspiCore.allocRecord({ name: 'llama_model_params' });
    using _cleanupResource = {
      [Symbol.dispose]() {
        jspiCore.free({ pointer });
      },
    };
    expect(load.mock.calls[0]?.[0].profile).toBe(profile);
    expect(jspiCore.createTensorPlacementReader().capability).toBe('synchronous_direct_exports_v3');
    expect(readGpuRequests({ core: jspiCore })).toEqual({ bufferCount: 0, bufferBytes: 0, writeCount: 0, writeBytes: 0, largestWriteBytes: 0, writesAtLeast4MiB: 0 });
    expect(readGpuRequests({ core })).toBeUndefined();
    expect(jspiCore.pointerBytes).toBe(4);
    await jspiCore.api.llama_model_default_params(pointer);
    expect(typeof pointer).toBe('bigint');
    expect(typeof await jspiCore.api.ggml_backend_dev_count()).toBe('bigint');
    expect(ccall).not.toHaveBeenCalled();
  });

  it('lowers public bigint pointers to native-width ccall arguments and preserves record results', async () => {
    const asyncCore = attachCore({ module: core.module, callMode: 'asyncify' });
    const ccall = vi.spyOn(core.module, 'ccall');
    const params = asyncCore.allocRecord({ name: 'llama_model_params' });
    using _cleanupResource = {
      [Symbol.dispose]() {
        asyncCore.free({ pointer: params });
      },
    };
    await asyncCore.api.llama_model_default_params(params);
    expect(ccall).toHaveBeenCalledWith('bicore_llama_model_default_params', undefined, ['number'], [Number(params)], { async: true });
    expect(asyncCore.bytes({ pointer: params, length: asyncCore.recordSize({ name: 'llama_model_params' }) }).some(byte => byte !== 0)).toBe(true);
    expect(typeof await asyncCore.api.ggml_backend_dev_count()).toBe('bigint');
    expect(ccall).toHaveBeenLastCalledWith('ggml_backend_dev_count', 'number', [], [], { async: true });
  });

  it('keeps native access serialized until suspension settles and releases the guard after rejection', async () => {
    const asyncCore = attachCore({ module: core.module, callMode: 'asyncify' });
    let finish: ((value: number) => void) | undefined;
    const ccall = vi.spyOn(core.module, 'ccall').mockImplementationOnce(() => new Promise<number>(resolve => {
      finish = resolve;
    }));
    const pending = asyncCore.api.ggml_backend_dev_count();
    await expect(asyncCore.api.ggml_backend_dev_count()).rejects.toThrow('Serialize access');
    expect(() => asyncCore.alloc({ bytes: 8 })).toThrow('Serialize access');
    expect(ccall).toHaveBeenCalledOnce();
    if (!finish) {
      throw new Error('Expected a pending native call');
    }
    finish(7);
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
    expect(ccall).toHaveBeenNthCalledWith(1, 'llama_tokenize', 'number',
      ['number', 'number', 'number', 'number', 'number', 'number', 'number'], [0, 0, 1, 0, 2, 0, 1], { async: true });
    expect(ccall.mock.calls[0]![2]).toBe(ccall.mock.calls[1]![2]);
    expect(ccall.mock.calls[0]![3]).not.toBe(ccall.mock.calls[1]![3]);
    const batch = asyncCore.allocRecord({ name: 'llama_batch' });
    using _cleanupBatch = {
      [Symbol.dispose]() {
        asyncCore.free({ pointer: batch });
      },
    };
    ccall.mockReturnValue(undefined);
    await asyncCore.api.llama_batch_get_one(batch, 0n, 1);
    await asyncCore.api.llama_batch_get_one(batch, 0n, 2);
    expect(ccall.mock.calls[2]![2]).toEqual(['number', 'number', 'number']);
    expect(ccall.mock.calls[2]![1]).toBeUndefined(); // Hidden record destination.
    expect(ccall.mock.calls[2]![2]).toBe(ccall.mock.calls[3]![2]);
    expect(ccall.mock.calls[0]![2]).not.toBe(ccall.mock.calls[2]![2]);
  });

  it.each(['direct', 'asyncify', 'jspi'] as const)('validates every call with cached metadata in %s mode', async callMode => {
    const bound = attachCore({ module: core.module, callMode });
    const ccall = vi.spyOn(core.module, 'ccall');
    const invalid: unknown[][] = [
      [],
      [0, 0n, 0, 0n, 0, 0, 1], [-1n, 0n, 0, 0n, 0, 0, 1],
      [1n << 64n, 0n, 0, 0n, 0, 0, 1], [0n, 0n, NaN, 0n, 0, 0, 1],
      [0n, 0n, 0.5, 0n, 0, 0, 1], [0n, 0n, 2147483648, 0n, 0, 0, 1],
      [0n, 0n, 0, 0n, 0, 2, 1],
    ];
    for (const args of invalid) {
      await expect(Reflect.apply(bound.api.llama_tokenize, undefined, args)).rejects.toThrow();
      expect(() => bound.assertIdle()).not.toThrow();
    }
    // Generated public functions have fixed JS parameters. Check excess arity
    // at the metadata caller boundary, where the complete argument list arrives.
    const caller = createAbiCaller({ module: core.module, schema: catalog, suspension: callMode, gate: undefined });
    await expect(caller.call({ name: 'llama_tokenize', args: [0n, 0n, 0, 0n, 0, 0, 1, 0] })).rejects.toThrow('argument count');
    expect(ccall).not.toHaveBeenCalled();
    expect(typeof await bound.api.ggml_backend_dev_count()).toBe('bigint');
  });

  it.each(['string', 'record'] as const)('releases an unpublished %s allocation when the current heap rejects initialization', kind => {
    let truncated = false;
    const freed: bigint[] = [];
    const module = new Proxy(core.module, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (property === 'HEAPU8' && truncated) {
          return new Uint8Array(0);
        }
        if (property === '_malloc') {
          return (...args: (number | bigint)[]) => {
            if (typeof value !== 'function') {
              throw new Error('Missing fixture allocation');
            }
            const pointer: unknown = Reflect.apply(value, target, args);
            truncated = true;
            return pointer;
          };
        }
        if (property === '_free') {
          return (pointer: number | bigint) => {
            if (typeof value !== 'function') {
              throw new Error('Missing fixture release');
            }
            freed.push(BigInt(pointer));
            return Reflect.apply(value, target, [pointer]);
          };
        }
        return value;
      },
    });
    const bound = attachCore({ module, callMode: 'direct' });
    const run = () => kind === 'string' ? bound.utf8({ text: 'owned native string' }) : bound.allocRecord({ name: 'llama_batch' });
    expect(run).toThrow('out of bounds');
    expect(freed).toHaveLength(1);
    expect(freed[0]).not.toBe(0n);
    truncated = false;
  });

  it.each([false, true])('requires direct synchronous callback getters while ordinary API calls remain asynchronous (%s)', async synchronous => {
    const invoked = vi.fn();
    const getters = new Set(['_ggml_op_desc', '_ggml_backend_buffer_name', '_ggml_backend_buffer_is_host', '_ggml_backend_dev_supports_op', '_ggml_backend_dev_count', '_ggml_backend_dev_get', '_ggml_backend_dev_name']);
    const module = new Proxy(core.module, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof property === 'string' && getters.has(property) && typeof value === 'function') {
          return (...args: unknown[]) => {
            invoked(property);
            const result: unknown = Reflect.apply(value, target, args);
            return synchronous ? result : Promise.resolve(result);
          };
        }
        return value;
      },
    });
    if (!synchronous) {
      const invalid = attachCore({ module, callMode: 'jspi' });
      expect(() => invalid.createTensorPlacementReader()).toThrow(/synchronous/iu);
      expect(invoked).toHaveBeenCalledWith('_ggml_backend_dev_count');
      return;
    }
    const bound = attachCore({ module, callMode: 'jspi' });
    const params = core.allocRecord({ name: 'ggml_init_params' });
    core.setField({ name: 'ggml_init_params', pointer: params, field: 'mem_size', value: 1024n * 1024n });
    core.setField({ name: 'ggml_init_params', pointer: params, field: 'no_alloc', value: 1 });
    let context = 0n, buffer = 0n;
    await using _cleanupResource = {
      async [Symbol.asyncDispose]() {
        if (buffer) {
          await core.api.ggml_backend_buffer_free(buffer);
        }
        if (context) {
          await core.api.ggml_free(context);
        }
        core.free({ pointer: params });
      },
    };
    context = await core.api.ggml_init(params);
    const tensor = await core.api.ggml_new_tensor_1d(context, core.constant({ name: 'GGML_TYPE_F32' }), 16n);
    const buft = await core.api.ggml_backend_dev_buffer_type(await core.api.ggml_backend_dev_get(0n));
    buffer = await core.api.ggml_backend_alloc_ctx_tensors_from_buft(context, buft);
    expect(buffer).not.toBe(0n);
    const reader = bound.createTensorPlacementReader();
    const metadata = reader.read({ tensor });
    expect(invoked).toHaveBeenCalledWith('_ggml_backend_dev_count');
    expect(invoked).toHaveBeenCalledWith('_ggml_op_desc');
    expect(reader.capability).toBe('synchronous_direct_exports_v3');
    expect(metadata).toMatchObject({
      op: 'GGML_OP_NONE',
      type: 'GGML_TYPE_F32',
      shape: [16, 1, 1, 1],
      storage: 'host',
      webgpuSupport: 'unavailable',
    });
    expect(await bound.api.ggml_backend_dev_count()).toBeGreaterThan(0n);
    expect(invoked).toHaveBeenCalledWith('_ggml_backend_dev_count');
    // General reentrant access remains prohibited while any API call is pending.
    const pending = bound.api.ggml_backend_dev_count();
    expect(() => bound.createTensorPlacementReader()).toThrow('Serialize');
    await pending;
  });

  it('rejects missing or suspending direct callback exports during setup', () => {
    for (const failure of ['suspending', 'missing'] as const) {
      const module = new Proxy(core.module, {
        get(target, property) {
          if (failure === 'suspending' && property === '_ggml_backend_dev_count') {
            return () => Promise.resolve(1);
          }
          if (failure === 'missing' && property === '_ggml_op_desc') {
            return undefined;
          }
          return Reflect.get(target, property, target);
        },
      });
      expect(() => attachCore({ module, callMode: 'jspi' }).createTensorPlacementReader()).toThrow(failure === 'suspending' ? /synchronous/iu : /Missing.*export/iu);
    }
  });
});
