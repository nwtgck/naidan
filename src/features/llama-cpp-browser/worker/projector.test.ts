import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import type { ModelFile } from '@/features/llama-cpp-browser/runtime/model-directory';
import * as modelReadModule from '@/features/llama-cpp-browser/runtime/model-read-cache';
import * as modelFileModule from './model-file-access';
import * as readOnlyModule from '@/features/llama-cpp-browser/runtime/read-only-file';
import type { ModelFileSource } from '@/features/llama-cpp-browser/runtime/model-file-source';
import { createVisionMeasurement } from './vision-measurement';
import { visionBf16Metadata } from '@/features/llama-cpp-browser/runtime/vision-bf16-storage.test-support';
import { loadProjector, loadProjectorForBackend } from './projector';

const metadata = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('llama-cpp-browser-core/api/schema.mjs', async importOriginal => {
  const original = await importOriginal<{ default: unknown }>();
  return {
    get default() {
      return metadata.value ?? original.default;
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  metadata.value = undefined;
});

const mount = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock('../runtime/read-only-file', () => ({ mountReadOnlyFile: () => ({ remove: mount.remove }) }));

afterEach(() => vi.restoreAllMocks());

function fixture({ pointerBytes }: { pointerBytes: 4 | 8 }) {
  const fields = new Map<string, number | bigint>();
  const order: string[] = [];
  let allocation = 100n;
  const api = {
    mtmd_context_params_default: vi.fn(async () => {}),
    mtmd_init_from_file: vi.fn(async () => 500n),
    mtmd_free: vi.fn(async () => {
      order.push('native-free');
    }),
  };
  const addFunction = vi.fn(() => 7);
  const removeFunction = vi.fn(() => {
    order.push('callback-free');
  });
  const close = vi.fn();
  const free = vi.fn();
  const core = {
    pointerBytes,
    api,
    module: { addFunction, removeFunction },
    fieldLayout: ({ field }: { field: string }) => ({ offset: 0n, size: field === 'ne' ? 32 : field === 'src' ? pointerBytes * 10 : 4, kind: field === 'ne' || field === 'src' ? 'array' : 'signed' }),
    enumValues: () => [{ name: 'GGML_OP_ADD', value: 2 }],
    allocRecord: () => ++allocation,
    utf8: () => ++allocation,
    free,
    setField: ({ field, value }: { field: string, value: number | bigint }) => fields.set(field, value),
  } as unknown as Core;
  const file = { storageKind: 'opfs', relativePath: 'mmproj.gguf', file: new File(['x'], 'mmproj.gguf'), handle: { createSyncAccessHandle: async () => ({ getSize: () => 1, read: () => 0, close }) } } as unknown as ModelFile;
  return { core, file, api, fields, addFunction, removeFunction, order, close, free };
}

describe('projector callback ownership', () => {
  it('forwards a host tail capability during loading and disposes its cache afterward', async () => {
    const f = fixture({ pointerBytes: 4 });
    const size = 100000;
    f.file.file = new File([new Uint8Array(size)], 'mmproj.gguf');
    const read = vi.fn(() => {
      throw new Error('Tail should satisfy the second read');
    });
    const readWithTail = vi.fn<NonNullable<ModelFileSource['readWithTail']>>(({ destination, tail }) => {
      destination.fill(31);
      tail.fill(47);
      return destination.length + tail.length;
    });
    using _access = vi.spyOn(modelFileModule, 'openModelFileAccess').mockResolvedValue({ getSize: () => size, read, readWithTail, close: f.close });
    let source: ModelFileSource | undefined;
    using _mount = vi.spyOn(readOnlyModule, 'mountReadOnlyFile').mockImplementation(args => {
      source = args.source;
      return { path: args.path, remove: mount.remove };
    });
    f.api.mtmd_init_from_file.mockImplementationOnce(async () => {
      expect(f.close).not.toHaveBeenCalled();
      const body = new Uint8Array(65536), tail = new Uint8Array(1024);
      expect(source!.read({ destination: body, offset: 0 })).toBe(65536);
      expect(source!.read({ destination: tail, offset: 65536 })).toBe(1024);
      expect(body.every(value => value === 31)).toBe(true);
      expect(tail.every(value => value === 47)).toBe(true);
      return 500n;
    });
    const loaded = await loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'cpu-wasm32', debug: 'off', signal: undefined, visionBf16Storage: undefined, observation: 'disabled' });
    await using _projector = { [Symbol.asyncDispose]: () => loaded.release() };
    expect(readWithTail).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
    expect(() => source!.read({ destination: new Uint8Array(1), offset: 65536 })).toThrow('disposed');
  });

  it.each([4, 8] as const)('keeps the %i-byte callback alive until native projector release', async pointerBytes => {
    const f = fixture({ pointerBytes });
    const projector = await loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'cpu-wasm32', debug: 'on', signal: undefined, visionBf16Storage: undefined, observation: 'disabled' });
    expect(f.addFunction).toHaveBeenCalledWith(expect.any(Function), pointerBytes === 8 ? 'ijij' : 'iiii');
    expect(f.fields.get('cb_eval')).toBe(7n);
    expect(f.fields.get('cb_eval_user_data')).toBe(0n);
    expect(f.removeFunction).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
    await projector.release();
    await projector.release();
    expect(f.order).toEqual(['native-free', 'callback-free']);
  });

  it('installs no callback with debugging off', async () => {
    const f = fixture({ pointerBytes: 4 });
    const projector = await loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'cpu-wasm32', debug: 'off', signal: undefined, visionBf16Storage: undefined, observation: 'disabled' });
    expect(f.fields.get('cb_eval')).toBe(0n);
    expect(f.addFunction).not.toHaveBeenCalled();
    await projector.release();
    expect(f.removeFunction).not.toHaveBeenCalled();
  });

  it('releases a callback when native initialization fails', async () => {
    const f = fixture({ pointerBytes: 8 });
    f.api.mtmd_init_from_file.mockResolvedValue(0n);
    await expect(loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'cpu-wasm32', debug: 'on', signal: undefined, visionBf16Storage: undefined, observation: 'disabled' })).rejects.toThrow('unsupported-input');
    expect(f.order).toEqual(['callback-free']);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.free).toHaveBeenCalledTimes(2);
  });

  it('frees a newly initialized projector before its callback when cancellation arrives during loading', async () => {
    const f = fixture({ pointerBytes: 8 });
    const controller = new AbortController();
    f.api.mtmd_init_from_file.mockImplementation(async () => {
      controller.abort();
      return 500n;
    });
    await expect(loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'cpu-wasm32', debug: 'on', signal: controller.signal, visionBf16Storage: undefined, observation: 'disabled' })).rejects.toThrow('aborted');
    expect(f.order).toEqual(['native-free', 'callback-free']);
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('does not remove a callback if native projector release fails', async () => {
    const f = fixture({ pointerBytes: 8 });
    const projector = await loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'cpu-wasm32', debug: 'on', signal: undefined, visionBf16Storage: undefined, observation: 'disabled' });
    f.api.mtmd_free.mockRejectedValueOnce(new Error('native release failed'));
    await expect(projector.release()).rejects.toThrow();
    expect(f.removeFunction).not.toHaveBeenCalled();
  });

  it('preserves a native cleanup failure instead of reporting a reusable cancellation', async () => {
    const f = fixture({ pointerBytes: 8 });
    const controller = new AbortController();
    f.api.mtmd_init_from_file.mockImplementation(async () => {
      controller.abort();
      return 500n;
    });
    f.api.mtmd_free.mockRejectedValueOnce(new Error('native cleanup failed'));
    await expect(loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'cpu-wasm32', debug: 'on', signal: controller.signal, visionBf16Storage: undefined, observation: 'disabled' })).rejects.toThrow('native cleanup failed');
    expect(f.removeFunction).not.toHaveBeenCalled();
  });

  it('does not transfer an initialized projector if closing its temporary file fails', async () => {
    const f = fixture({ pointerBytes: 8 });
    f.close.mockImplementationOnce(() => {
      throw new Error('close failed');
    });
    await expect(loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'cpu-wasm32', debug: 'on', signal: undefined, visionBf16Storage: undefined, observation: 'disabled' })).rejects.toThrow('close failed');
    expect(f.order).toEqual(['native-free', 'callback-free']);
  });
});

it.each(['cpu', 'profile'] as const)('applies the explicit %s audio backend independently of a WebGPU backbone', async backend => {
  const f = fixture({ pointerBytes: 8 });
  const projector = await loadProjectorForBackend({ core: f.core, model: 1n, file: f.file, profile: 'webgpu-wasm64-jspi', debug: 'off', signal: undefined, backend, visionBf16Storage: undefined, observation: 'disabled', purpose: 'audio' });
  expect(f.fields.get('use_gpu')).toBe(backend === 'profile' ? 1 : 0);
  expect(f.fields.get('n_threads')).toBe(1);
  await projector.release();
  expect(f.api.mtmd_free).toHaveBeenCalledExactlyOnceWith(500n);
});

it.each(['success', 'native-failure', 'close-failure'] as const)('owns and clears a projector read window on %s', async outcome => {
  const f = fixture({ pointerBytes: 4 });
  const original = modelReadModule.createModelReadCache;
  const caches: ReturnType<typeof original>[] = [];
  vi.spyOn(modelReadModule, 'createModelReadCache').mockImplementation(args => {
    const cache = original(args);
    caches.push(cache);
    const dispose = cache.dispose;
    cache.dispose = vi.fn(() => {
      expect(f.close).toHaveBeenCalledOnce();
      dispose();
    });
    return cache;
  });
  switch (outcome) {
  case 'success': break;
  case 'native-failure': f.api.mtmd_init_from_file.mockRejectedValueOnce(new Error('native failure'));
    break;
  case 'close-failure': f.close.mockImplementationOnce(() => {
    throw new Error('close failure');
  });
    break;
  default: {
    const exhaustive: never = outcome;
    throw new Error(exhaustive);
  }
  }
  const loading = loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'cpu-wasm32', debug: 'off', signal: undefined, visionBf16Storage: undefined, observation: 'disabled' });
  if (outcome === 'success') {
    await (await loading).release();
  } else {
    await expect(loading).rejects.toThrow(outcome === 'native-failure' ? 'native failure' : 'close failure');
  }
  expect(caches).toHaveLength(1);
  expect(caches[0]!.dispose).toHaveBeenCalledOnce();
  expect(() => caches[0]!.wrap({ source: { size: 0, read: () => 0 } })).toThrow('disposed');
});

function modern({ pointerBytes, requested }: { pointerBytes: 4 | 8, requested: number }) {
  metadata.value = structuredClone(visionBf16Metadata);
  const f = fixture({ pointerBytes });
  const initialize = vi.fn(async () => 500n), version = vi.fn(async () => 1), query = vi.fn(async () => requested);
  Object.assign(f.core.api, { mtmd_init_from_file_with_vision_bf16_storage: initialize, mtmd_vision_bf16_storage_version: version, mtmd_context_vision_bf16_storage: query });
  Object.assign(f.core.module, { _lcb_mtmd_init_from_file_with_vision_bf16_storage: initialize, _lcb_mtmd_vision_bf16_storage_version: version, _lcb_mtmd_context_vision_bf16_storage: query });
  Object.assign(f.core, {
    constant: ({ name }: { name: string }) => {
      const values: Record<string, number> = { MTMD_VISION_BF16_STORAGE_INVALID: -1, MTMD_VISION_BF16_STORAGE_LEGACY_EXPAND: 0, MTMD_VISION_BF16_STORAGE_RETAIN_CHECKED: 1 };
      return values[name];
    },
  });
  return { ...f, initialize, version, query };
}

it.each([4, 8] as const)('captures and confirms the retained policy before handing off a %i-byte projector', async pointerBytes => {
  const f = modern({ pointerBytes, requested: 1 });
  const loaded = await loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'webgpu-wasm64-jspi', debug: 'off', signal: undefined, visionBf16Storage: undefined, observation: 'enabled' });
  expect(loaded.visionStorage).toMatchObject({ preference: 'default', selectedMode: 'retain-checked', contextRequestedMode: 'retain-checked', apiVersion: 1, evidence: 'requested-policy-only', status: 'initialized' });
  expect(f.initialize).toHaveBeenCalledWith(expect.any(BigInt), 1n, expect.any(BigInt), 1);
  expect(f.api.mtmd_init_from_file).not.toHaveBeenCalled();
  expect(f.fields.get('use_gpu')).toBe(1);
  expect(f.addFunction).not.toHaveBeenCalled();
  await loaded.release();
  expect(f.api.mtmd_free).toHaveBeenCalledExactlyOnceWith(500n);
});

it('cleans an owned projector on getter mismatch without legacy retry', async () => {
  const f = modern({ pointerBytes: 8, requested: 0 });
  await expect(loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'cpu-wasm32', debug: 'off', signal: undefined, visionBf16Storage: 'retain-checked', observation: 'enabled' })).rejects.toThrow('mismatch');
  expect(f.api.mtmd_free).toHaveBeenCalledExactlyOnceWith(500n);
  expect(f.api.mtmd_init_from_file).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledOnce();
});

it('does not query a newly loaded context after cancellation, and frees it after init settles', async () => {
  const f = modern({ pointerBytes: 8, requested: 1 }), control = new AbortController();
  const pending = Promise.withResolvers<bigint>();
  f.initialize.mockReturnValueOnce(pending.promise);
  const load = loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'cpu-wasm32', debug: 'off', signal: control.signal, visionBf16Storage: 'retain-checked', observation: 'disabled' });
  await vi.waitFor(() => expect(f.initialize).toHaveBeenCalledOnce());
  control.abort();
  expect(f.api.mtmd_free).not.toHaveBeenCalled();
  pending.resolve(500n);
  await expect(load).rejects.toThrow('aborted');
  expect(f.query).not.toHaveBeenCalled();
  expect(f.api.mtmd_free).toHaveBeenCalledExactlyOnceWith(500n);
});

it('leaves audio projector loading on the existing entry even when retained APIs exist', async () => {
  const f = modern({ pointerBytes: 8, requested: 1 });
  const loaded = await loadProjectorForBackend({ core: f.core, model: 1n, file: f.file, profile: 'webgpu-wasm64-jspi', debug: 'off', signal: undefined, backend: 'cpu', purpose: 'audio', visionBf16Storage: undefined, observation: 'disabled' });
  expect(loaded.purpose).toBe('audio');
  expect(loaded.visionStorage).toBeUndefined();
  expect(f.version).not.toHaveBeenCalled();
  expect(f.initialize).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
  expect(f.api.mtmd_init_from_file).toHaveBeenCalledOnce();
  await loaded.release();
});

it('keeps cleanup failure priority, both bounded diagnostics and the callback on confirm plus free failure', async () => {
  const f = modern({ pointerBytes: 8, requested: 0 });
  f.api.mtmd_free.mockRejectedValueOnce(new Error('native cleanup failed'));
  const observation = createVisionMeasurement({ directory: { files: [f.file], primaryFile: f.file, projectorFile: f.file }, now: () => 0 });
  using _cleanup = {
    [Symbol.dispose]() {
      observation.finish({ outcome: 'failed' });
    },
  };
  await expect(loadProjector({ core: f.core, model: 1n, file: f.file, profile: 'cpu-wasm32', debug: 'on', signal: undefined, visionBf16Storage: 'retain-checked', observation: 'enabled' })).rejects.toThrow('native cleanup failed');
  const diagnostic = observation.finish({ outcome: 'failed' });
  expect(diagnostic.storage).toMatchObject({ status: 'unavailable', reason: 'context-request-mismatch', contextRequestedMode: 'legacy-expand', evidence: 'requested-policy-only' });
  expect(diagnostic.nativeFailures).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: 'failed', stage: 'projector-load' }),
    expect.objectContaining({ event: 'failed', stage: 'cleanup' }),
  ]));
  expect(f.removeFunction).not.toHaveBeenCalled();
  expect(f.api.mtmd_free).toHaveBeenCalledOnce();
  expect(f.api.mtmd_init_from_file).not.toHaveBeenCalled();
});
