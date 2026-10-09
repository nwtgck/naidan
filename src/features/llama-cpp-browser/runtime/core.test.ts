// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as artifacts from './artifacts';
import { readGpuRequests } from './webgpu-request-diagnostics';
import { attachCore, createCore, type Core } from './core';

describe('native call adaptation', () => {
  let core: Core;

  beforeAll(async () => {
    const baseURL = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/llama-cpp-browser-core/profiles') + '/');
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
    let allocate = (): bigint => 0n;
    const module = new Proxy(core.module, {
      get(target, property) {
        return property === '_lcb_malloc' ? allocate : Reflect.get(target, property, target);
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
    if (pointer !== undefined) core.free({ pointer });
  });

  it.each([
    { profile: 'webgpu-wasm32-jspi', bindings: false },
    { profile: 'webgpu-wasm32-jspi', bindings: true },
    { profile: 'webgpu-wasm64-jspi', bindings: false },
    { profile: 'webgpu-wasm64-jspi', bindings: true },
  ] as const)('keeps Promise calls, callback metadata and GPU observation for $profile (bindings: $bindings)', async ({ profile, bindings }) => {
    const original = artifacts.loadCoreModule;
    // Substitute the real CPU32 module only at loading so this test also runs
    // without host JSPI. Exercise profile routing against a real wasm32 ABI,
    // not execution of either WebGPU or a wasm64 binary.
    const load = vi.spyOn(artifacts, 'loadCoreModule').mockImplementationOnce(async args => {
      const loaded = await original({ ...args, profile: 'cpu-wasm32' });
      // Model old/new contracts explicitly, independently of installed exports.
      const module = new Proxy(loaded.module, {
        get(target, property) {
          if (property === '_lcb_callback_metadata_version') return bindings ? () => 1 : undefined;
          if (typeof property === 'string' && property.startsWith('_lcb_callback_')) return bindings ? Reflect.get(target, property.replace('_lcb_callback_', '_lcb_'), target) : undefined;
          return Reflect.get(target, property, target);
        },
      });
      return new Proxy(loaded, {
        get(target, property) {
          return property === 'module' ? module : Reflect.get(target, property, target);
        },
      });
    });
    const baseURL = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/llama-cpp-browser-core/profiles') + '/');
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
    try {
      expect(load.mock.calls[0]?.[0].profile).toBe(profile);
      expect(jspiCore.createTensorPlacementReader().capability).toBe(bindings ? 'synchronous-leaf-bindings-v1' : 'tensor-layout-only');
      expect(readGpuRequests({ core: jspiCore })).toEqual({ bufferCount: 0, bufferBytes: 0, writeCount: 0, writeBytes: 0, largestWriteBytes: 0, writesAtLeast4MiB: 0 });
      expect(readGpuRequests({ core })).toBeUndefined();
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

  it.each(['direct', 'asyncify', 'jspi'] as const)('validates every call with cached metadata in %s mode', async callMode => {
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
    const module = new Proxy(core.module, {
      get(target, property) {
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
      },
    });
    const bound = attachCore({ module, callMode: 'direct' });
    const run = () => kind === 'string' ? bound.utf8({ text: 'owned native string' }) : bound.allocRecord({ name: 'llama_batch' });
    expect(run).toThrow('out of bounds'); expect(freed).toHaveLength(1); expect(freed[0]).not.toBe(0n);
    truncated = false;
  });

  it.each([false, true])('reads callback metadata safely with Promise-wrapped exports (new bindings: %s)', async bindings => {
    const invoked = vi.fn();
    const module = new Proxy(core.module, {
      get(target, property) {
        if (property === '_lcb_callback_metadata_version') return bindings ? () => 1 : undefined;
        if (typeof property === 'string' && property.startsWith('_lcb_callback_')) return bindings ? Reflect.get(target, property.replace('_lcb_callback_', '_lcb_'), target) : undefined;
        const value: unknown = Reflect.get(target, property, target);
        if (typeof property === 'string' && property.startsWith('_lcb_ggml_') && typeof value === 'function') return (...args: unknown[]) => {
          invoked(property); return Promise.resolve(Reflect.apply(value, target, args));
        };
        return value;
      },
    });
    if (!bindings) {
      // 022 classified JSPI as direct and called this Promise-returning export
      // as a scalar during reader setup, before creating a diagnostic context.
      const legacyContract = attachCore({ module, callMode: 'direct' });
      expect(() => legacyContract.createTensorPlacementReader()).toThrow('Expected synchronous scalar: _lcb_ggml_backend_dev_count');
      expect(invoked).toHaveBeenCalledWith('_lcb_ggml_backend_dev_count');
      invoked.mockClear();
    }
    const bound = attachCore({ module, callMode: 'jspi' });
    const params = core.allocRecord({ name: 'ggml_init_params' });
    core.setField({ name: 'ggml_init_params', pointer: params, field: 'mem_size', value: 1024n * 1024n });
    core.setField({ name: 'ggml_init_params', pointer: params, field: 'no_alloc', value: 1 });
    let context = 0n, buffer = 0n;
    try {
      context = await core.api.ggml_init(params);
      const tensor = await core.api.ggml_new_tensor_1d(context, core.constant({ name: 'GGML_TYPE_F32' }), 16n);
      const buft = await core.api.ggml_backend_dev_buffer_type(await core.api.ggml_backend_dev_get(0n));
      buffer = await core.api.ggml_backend_alloc_ctx_tensors_from_buft(context, buft);
      expect(buffer).not.toBe(0n);
      const reader = bound.createTensorPlacementReader();
      const metadata = reader.read({ tensor });
      expect(invoked).not.toHaveBeenCalled(); // No ordinary export enters the callback/setup.
      expect(reader.capability).toBe(bindings ? 'synchronous-leaf-bindings-v1' : 'tensor-layout-only');
      expect(metadata).toMatchObject({
        op: 'GGML_OP_NONE',
        type: 'GGML_TYPE_F32',
        shape: [16, 1, 1, 1],
        storage: bindings ? 'host' : 'unknown',
        webgpuSupport: 'unavailable',
      });
      expect(await bound.api.ggml_backend_dev_count()).toBeGreaterThan(0n);
      expect(invoked).toHaveBeenCalledWith('_lcb_ggml_backend_dev_count');
      // General reentrant access remains prohibited while any API call is pending.
      const pending = bound.api.ggml_backend_dev_count();
      expect(() => bound.createTensorPlacementReader()).toThrow('Serialize');
      await pending;
    } finally {
      if (buffer) await core.api.ggml_backend_buffer_free(buffer);
      if (context) await core.api.ggml_free(context);
      core.free({ pointer: params });
    }
  });

  it('rejects an incompatible or incomplete declared callback surface during setup', () => {
    for (const version of [2, 1]) {
      const module = new Proxy(core.module, {
        get(target, property) {
          if (property === '_lcb_callback_metadata_version') return () => version;
          // Keep the incomplete fixture incomplete after updating the package.
          if (property === '_lcb_callback_ggml_op_desc') return undefined;
          return Reflect.get(target, property, target);
        },
      });
      const bound = attachCore({ module, callMode: 'jspi' });
      expect(() => bound.createTensorPlacementReader()).toThrow(version === 2 ? 'Unsupported callback metadata binding version' : 'Missing native export');
    }
  });
});
