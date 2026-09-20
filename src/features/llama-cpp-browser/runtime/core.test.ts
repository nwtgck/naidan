// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { attachCore, createCore, type Core } from './core';

describe('Asyncify native call adaptation', () => {
  let core: Core;
  beforeAll(async () => {
    const baseURL = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/profiles') + '/');
    core = await createCore({ profile: 'cpu-wasm32', baseURL, moduleOptions: {
      wasmBinary: await readFile(new URL('cpu-wasm32/core.wasm', baseURL)), print() {}, printErr() {},
    } });
  });
  afterEach(() => vi.restoreAllMocks());

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
