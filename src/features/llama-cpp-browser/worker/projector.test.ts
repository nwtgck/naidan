import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import type { ModelFile } from '@/features/llama-cpp-browser/runtime/model-directory';
import { loadProjector, loadProjectorForBackend } from './projector';

const mount = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock('../runtime/read-only-file', () => ({ mountReadOnlyFile: () => ({ remove: mount.remove }) }));
afterEach(() => vi.restoreAllMocks());
function fixture({ pointerBytes }: { pointerBytes: 4 | 8 }) {
  const fields = new Map<string, number | bigint>(); const order: string[] = []; let allocation = 100n;
  const api = { mtmd_context_params_default: vi.fn(async () => {}), mtmd_init_from_file: vi.fn(async () => 500n), mtmd_free: vi.fn(async () => {
    order.push('native-free');
  }) };
  const addFunction = vi.fn(() => 7); const removeFunction = vi.fn(() => {
    order.push('callback-free');
  });
  const close = vi.fn(); const free = vi.fn();
  const core = { pointerBytes, api, module: { addFunction, removeFunction },
    fieldLayout: ({ field }: { field: string }) => ({ offset: 0n, size: field === 'ne' ? 32 : field === 'src' ? pointerBytes * 10 : 4, kind: field === 'ne' || field === 'src' ? 'array' : 'signed' }),
    enumValues: () => [{ name: 'GGML_OP_ADD', value: 2 }],
    allocRecord: () => ++allocation, utf8: () => ++allocation, free,
    setField: ({ field, value }: { field: string, value: number | bigint }) => fields.set(field, value),
  } as unknown as Core;
  const file = { path: 'mmproj.gguf', file: new File(['x'], 'mmproj.gguf'), handle: { createSyncAccessHandle: async () => ({ getSize: () => 1, read: () => 0, close }) } } as unknown as ModelFile;
  return { core, file, api, fields, addFunction, removeFunction, order, close, free };
}
describe('projector callback ownership', () => {
  it.each([4, 8] as const)('keeps the %i-byte callback alive until native projector release', async pointerBytes => {
    const f = fixture({ pointerBytes });
    const projector = await loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'cpu-wasm32', debug: 'on', signal: undefined });
    expect(f.addFunction).toHaveBeenCalledWith(expect.any(Function), pointerBytes === 8 ? 'ijij' : 'iiii');
    expect(f.fields.get('cb_eval')).toBe(7n); expect(f.fields.get('cb_eval_user_data')).toBe(0n);
    expect(f.removeFunction).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
    await projector.release(); await projector.release();
    expect(f.order).toEqual(['native-free', 'callback-free']);
  });
  it('installs no callback with debugging off', async () => {
    const f = fixture({ pointerBytes: 4 });
    const projector = await loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'cpu-wasm32', debug: 'off', signal: undefined });
    expect(f.fields.get('cb_eval')).toBe(0n); expect(f.addFunction).not.toHaveBeenCalled();
    await projector.release(); expect(f.removeFunction).not.toHaveBeenCalled();
  });
  it('releases a callback when native initialization fails', async () => {
    const f = fixture({ pointerBytes: 8 }); f.api.mtmd_init_from_file.mockResolvedValue(0n);
    await expect(loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'cpu-wasm64', debug: 'on', signal: undefined })).rejects.toThrow('unsupported-input');
    expect(f.order).toEqual(['callback-free']); expect(f.close).toHaveBeenCalledOnce(); expect(f.free).toHaveBeenCalledTimes(2);
  });
  it('frees a newly initialized projector before its callback when cancellation arrives during loading', async () => {
    const f = fixture({ pointerBytes: 8 }); const controller = new AbortController();
    f.api.mtmd_init_from_file.mockImplementation(async () => {
      controller.abort(); return 500n;
    });
    await expect(loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'cpu-wasm64', debug: 'on', signal: controller.signal })).rejects.toThrow('aborted');
    expect(f.order).toEqual(['native-free', 'callback-free']); expect(f.close).toHaveBeenCalledOnce();
  });
  it('does not remove a callback if native projector release fails', async () => {
    const f = fixture({ pointerBytes: 8 });
    const projector = await loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'cpu-wasm64', debug: 'on', signal: undefined });
    f.api.mtmd_free.mockRejectedValueOnce(new Error('native release failed'));
    await expect(projector.release()).rejects.toThrow(); expect(f.removeFunction).not.toHaveBeenCalled();
  });
  it('preserves a native cleanup failure instead of reporting a reusable cancellation', async () => {
    const f = fixture({ pointerBytes: 8 }); const controller = new AbortController();
    f.api.mtmd_init_from_file.mockImplementation(async () => {
      controller.abort(); return 500n;
    });
    f.api.mtmd_free.mockRejectedValueOnce(new Error('native cleanup failed'));
    await expect(loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'cpu-wasm64', debug: 'on', signal: controller.signal })).rejects.toThrow('native cleanup failed');
    expect(f.removeFunction).not.toHaveBeenCalled();
  });
  it('does not transfer an initialized projector if closing its temporary file fails', async () => {
    const f = fixture({ pointerBytes: 8 });
    f.close.mockImplementationOnce(() => {
      throw new Error('close failed');
    });
    await expect(loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'cpu-wasm64', debug: 'on', signal: undefined })).rejects.toThrow('close failed');
    expect(f.order).toEqual(['native-free', 'callback-free']);
  });
});


it.each(['cpu', 'profile'] as const)('applies the explicit %s audio backend independently of a WebGPU backbone', async backend => {
  const f = fixture({ pointerBytes: 8 });
  const projector = await loadProjectorForBackend({ core: f.core, model: 1n, file: f.file, profile: 'webgpu-wasm64-jspi', debug: 'off', signal: undefined, backend });
  expect(f.fields.get('use_gpu')).toBe(backend === 'profile' ? 1 : 0);
  expect(f.fields.get('n_threads')).toBe(1);
  await projector.release(); expect(f.api.mtmd_free).toHaveBeenCalledExactlyOnceWith(500n);
});
