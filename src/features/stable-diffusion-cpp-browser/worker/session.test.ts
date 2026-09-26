import { expect, it, vi } from 'vitest';
import { runImageGeneration } from './session';
import type { Core, CoreModule, HostHelpers, NativeApi } from './core-types';
import { requestFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import { fixtureReader, ggufFixture } from '@/features/stable-diffusion-cpp-browser/test-utils/weights';

/** This is a mocked native boundary, not a model or WebGPU inference test. */
function harness({ pointerBytes, outcome, channels }: {
  pointerBytes: 4 | 8, outcome: 'success' | 'load-failure' | 'generation-failure' | 'trap', channels: 3 | 4,
}) {
  const events: string[] = [];
  const fields = new Map<string, number | bigint>();
  const recordPointers = new Map<string, bigint>();
  const strings = new Map<bigint, string>();
  const callbacks = new Map<number, (...args: (number | bigint)[]) => void>();
  const registrations = { log: 0, progress: 0 };
  let cursor = 64;
  const allocate = ({ bytes }: { bytes: number | bigint }) => {
    const pointer = BigInt(cursor); cursor += Math.ceil(Number(bytes) / 16) * 16; return pointer;
  };
  const module: CoreModule = {
    HEAPU8: new Uint8Array(2 * 1024 * 1024), FS: { mkdir: vi.fn() }, _sdc_abi_version: () => 2,
    addFunction: vi.fn((callback, signature) => {
      events.push('callback:' + signature); const pointer = callbacks.size + 10; callbacks.set(pointer, callback); return pointer;
    }),
    removeFunction: vi.fn(pointer => {
      events.push('remove-function'); callbacks.delete(Number(pointer));
    }),
  };
  const api: NativeApi = {
    sd_ctx_params_init: vi.fn(async () => {
      events.push('ctx-defaults');
    }),
    sd_img_gen_params_init: vi.fn(async () => {
      events.push('image-defaults');
    }),
    new_sd_ctx: vi.fn(async () => {
      callbacks.get(registrations.progress)?.(901, 901, 0.125, 0);
      return outcome === 'load-failure' ? 0n : 200000n;
    }),
    free_sd_ctx: vi.fn(async () => {
      events.push('free-context');
    }),
    sd_ctx_supports_image_generation: vi.fn(async () => 1),
    sd_get_model_version_name: vi.fn(async () => {
      strings.set(1n, 'mock model (no inference)'); return 1n;
    }),
    sd_get_default_sample_method: vi.fn(async () => 2),
    sd_get_default_scheduler: vi.fn(async () => 3),
    str_to_sample_method: vi.fn(async () => 4), str_to_scheduler: vi.fn(async () => 5),
    sd_set_log_callback: vi.fn(async pointer => {
      registrations.log = Number(pointer); if (!pointer) events.push('clear-log');
    }),
    sd_set_progress_callback: vi.fn(async pointer => {
      registrations.progress = Number(pointer);
    }),
    sd_set_preview_callback: vi.fn(async () => undefined), sd_list_devices: vi.fn(async () => 0n),
    generate_image: vi.fn(async (_ctx, _params, imagesOut, countOut) => {
      if (outcome === 'trap') throw new Error('mocked Wasm trap');
      // Deliberately replace the heap to verify views are acquired after await.
      const old = module.HEAPU8; module.HEAPU8 = new Uint8Array(old.length * 2); module.HEAPU8.set(old);
      const view = new DataView(module.HEAPU8.buffer);
      if (pointerBytes === 8) view.setBigUint64(Number(imagesOut), 300000n, true);
      else view.setUint32(Number(imagesOut), 300000, true);
      view.setInt32(Number(countOut), 1, true);
      fields.set('sd_image_t:300000:width', 256); fields.set('sd_image_t:300000:height', 256);
      fields.set('sd_image_t:300000:channel', channels); fields.set('sd_image_t:300000:data', 400000n);
      module.HEAPU8.fill(71, 400000, 400000 + 256 * 256 * channels);
      strings.set(2n, 'native progress diagnostic');
      callbacks.get(registrations.log)?.(1, 2, 0); callbacks.get(registrations.progress)?.(1, 4, 0.125, 0);
      return outcome === 'generation-failure' ? 0 : 1;
    }),
    free_sd_images: vi.fn(async () => {
      events.push('free-images'); module.HEAPU8.fill(0, 400000);
    }),
  };
  const core: Core = {
    module, api, pointerBytes, busy: false,
    constant: vi.fn(() => 100),
    alloc: vi.fn(bytes => allocate({ bytes })),
    free: vi.fn(() => {
      events.push('free-allocation');
    }),
    recordSize: vi.fn(() => 1024),
    allocRecord: vi.fn(name => {
      const pointer = allocate({ bytes: 1024 }); recordPointers.set(name, pointer); return pointer;
    }),
    fieldAddress: vi.fn((name, pointer, field) => {
      const key = name + ':' + pointer + ':' + field;
      const nested = recordPointers.get(key); if (nested) return nested;
      const address = allocate({ bytes: 1024 }); recordPointers.set(key, address); return address;
    }),
    getField: vi.fn((name, pointer, field) => fields.get(name + ':' + pointer + ':' + field) ?? 0),
    setField: vi.fn((name, pointer, field, value) => {
      fields.set(name + ':' + pointer + ':' + field, value); events.push('field:' + field);
    }),
    bytes: vi.fn((pointer, bytes) => new Uint8Array(module.HEAPU8.buffer, Number(pointer), Number(bytes))),
    utf8: vi.fn(text => {
      const pointer = allocate({ bytes: text.length * 4 + 1 }); strings.set(pointer, text); return pointer;
    }),
    readUtf8: vi.fn(pointer => strings.get(pointer) ?? null),
  };
  const helpers: Pick<HostHelpers, 'mountReadOnlyFile'> = {
    mountReadOnlyFile: vi.fn((_core, path, source, options) => {
      expect(source.size).toBe(24); expect(options.maxChunkBytes).toBe(8 * 1024 * 1024);
      events.push('mount:' + path);
      return { path, remove: vi.fn(() => {
        events.push('unmount');
      }) };
    }),
  };
  const reader = { readAsArrayBuffer: vi.fn((_blob: Blob) => {
    const header = new ArrayBuffer(24), view = new DataView(header); view.setUint32(0, 0x46554747, true); view.setUint32(4, 3, true); return header;
  }) };
  return { core, api, helpers, reader, fields, recordPointers, strings, events, callbacks, registrations };
}

it.each([4, 8] as const)('uses public records and caller policy with %i-byte pointers; releases all native resources before files', async pointerBytes => {
  const h = harness({ pointerBytes, outcome: 'success', channels: 3 });
  const request = requestFixture(); request.parameters.seed = '9223372036854775807'; request.parameters.sampler = 'heun'; request.parameters.scheduler = 'karras';
  request.parameters.vaeTiling = false; request.parameters.modelArguments = 'qwen_image_2_1_prefix_cache=false';
  const onProgress = vi.fn(), onLog = vi.fn();
  const output = await runImageGeneration({ ...h, request, onProgress, onLog });
  expect(output.pixels.subarray(0, 4)).toEqual(new Uint8ClampedArray([71, 71, 71, 255]));
  expect(output.width).toBe(256); expect(output.modelVersion).toContain('mock');
  const ctx = h.recordPointers.get('sd_ctx_params_t')!, image = h.recordPointers.get('sd_img_gen_params_t')!;
  expect(h.fields.get(`sd_img_gen_params_t:${image}:seed`)).toBe(9223372036854775807n);
  const modelPath = h.fields.get(`sd_ctx_params_t:${ctx}:model_path`);
  expect(h.strings.get(BigInt(modelPath!))).toBe('/models/model/model.gguf');
  expect(h.fields.get(`sd_ctx_params_t:${ctx}:enable_mmap`)).toBe(0);
  expect(h.fields.get(`sd_ctx_params_t:${ctx}:disable_prefetch`)).toBe(0);
  expect(h.strings.get(BigInt(h.fields.get(`sd_ctx_params_t:${ctx}:backend`)!))).toBe('WebGPU');
  expect(h.strings.get(BigInt(h.fields.get(`sd_ctx_params_t:${ctx}:params_backend`)!))).toBe('WebGPU');
  expect(h.fields.get(`sd_ctx_params_t:${ctx}:eager_load`)).toBe(1);
  expect(h.fields.get(`sd_ctx_params_t:${ctx}:auto_fit`)).toBe(0);
  expect(h.fields.get(`sd_ctx_params_t:${ctx}:max_vram`)).toBe(0n);
  expect(h.api.str_to_sample_method).toHaveBeenCalledTimes(1); expect(h.api.sd_get_default_sample_method).not.toHaveBeenCalled();
  expect(onProgress).toHaveBeenCalledWith({ event: { phase: 'sampling', step: 1, steps: 4 } });
  expect(h.events.indexOf('free-images')).toBeLessThan(h.events.indexOf('free-context'));
  expect(h.events.indexOf('free-context')).toBeLessThan(h.events.indexOf('unmount'));
  expect(h.events.indexOf('clear-log')).toBeLessThan(h.events.indexOf('remove-function'));
  expect(h.core.module.removeFunction).toHaveBeenCalledTimes(2);
});
it('uses upstream defaults and safely handles notification exceptions', async () => {
  const h = harness({ pointerBytes: 4, outcome: 'success', channels: 4 });
  const result = await runImageGeneration({ ...h, request: requestFixture(), onProgress: () => {
    throw new Error('listener');
  }, onLog: () => {
    throw new Error('listener');
  } });
  expect(result.pixels[3]).toBe(71); expect(h.api.sd_get_default_sample_method).toHaveBeenCalledOnce(); expect(h.api.sd_get_default_scheduler).toHaveBeenCalledWith(200000n, 2);
});
it.each(['load-failure', 'generation-failure'] as const)('releases the context and mounts after %s', async outcome => {
  const h = harness({ pointerBytes: 4, outcome, channels: 3 });
  await expect(runImageGeneration({ ...h, request: requestFixture(), onProgress: vi.fn(), onLog: vi.fn() })).rejects.toThrow();
  expect(h.events).toContain('unmount'); expect(h.events).toContain('clear-log');
  expect(h.api.free_sd_ctx).toHaveBeenCalledTimes(outcome === 'load-failure' ? 0 : 1);
  expect(h.api.free_sd_images).toHaveBeenCalledTimes(outcome === 'generation-failure' ? 1 : 0);
});
it('does not mount or initialize a native model when the selected file header is invalid', async () => {
  const h = harness({ pointerBytes: 4, outcome: 'success', channels: 3 });
  h.reader.readAsArrayBuffer.mockReturnValue(new ArrayBuffer(24));
  await expect(runImageGeneration({ ...h, request: requestFixture(), onProgress: vi.fn(), onLog: vi.fn() })).rejects.toThrow('Unrecognized weight format');
  expect(h.helpers.mountReadOnlyFile).not.toHaveBeenCalled(); expect(h.api.new_sd_ctx).not.toHaveBeenCalled();
});

it('keeps auto residency on WebGPU for a large original file without a model-size threshold', async () => {
  const h = harness({ pointerBytes: 4, outcome: 'success', channels: 3 });
  const request = requestFixture();
  request.models[0]!.file = ggufFixture({ name: 'model.gguf', tensors: [], metadata: {}, extraBytes: 13 * 1024 ** 3 }).file;
  h.reader.readAsArrayBuffer.mockImplementation(fixtureReader.readAsArrayBuffer);
  vi.mocked(h.helpers.mountReadOnlyFile).mockImplementation((_core, path, source) => {
    expect(source.size).toBeGreaterThan(13 * 1024 ** 3);
    return { path, remove: vi.fn() };
  });
  await runImageGeneration({ ...h, request, onProgress: vi.fn(), onLog: vi.fn() });
  const ctx = h.recordPointers.get('sd_ctx_params_t')!;
  expect(h.strings.get(BigInt(h.fields.get(`sd_ctx_params_t:${ctx}:params_backend`)!))).toBe('WebGPU');
  expect(h.fields.get(`sd_ctx_params_t:${ctx}:eager_load`)).toBe(1);
  expect(h.fields.get(`sd_ctx_params_t:${ctx}:max_vram`)).toBe(0n);
});

it.each([
  { weightResidency: 'cpu', paramsBackend: 'cpu' },
  { weightResidency: 'hybrid', paramsBackend: 'diffusion=disk,te=cpu,vae=cpu' },
  { weightResidency: 'disk', paramsBackend: 'disk' },
] as const)('preserves explicit $weightResidency placement and an optional managed budget', async ({ weightResidency, paramsBackend }) => {
  const h = harness({ pointerBytes: 8, outcome: 'success', channels: 3 });
  const request = requestFixture(); request.weightResidency = weightResidency; request.gpuBudgetMiB = 3072;
  await runImageGeneration({ ...h, request, onProgress: vi.fn(), onLog: vi.fn() });
  const ctx = h.recordPointers.get('sd_ctx_params_t')!;
  expect(h.strings.get(BigInt(h.fields.get(`sd_ctx_params_t:${ctx}:params_backend`)!))).toBe(paramsBackend);
  expect(h.fields.get(`sd_ctx_params_t:${ctx}:eager_load`)).toBe(0);
  expect(h.strings.get(BigInt(h.fields.get(`sd_ctx_params_t:${ctx}:max_vram`)!))).toBe('3');
});

it.each(['success', 'trap'] as const)('reports final logical and Blob read totals after %s', async outcome => {
  const h = harness({ pointerBytes: 8, outcome, channels: 3 });
  const mount = vi.mocked(h.helpers.mountReadOnlyFile);
  const originalMount = mount.getMockImplementation()!;
  mount.mockImplementation((...args) => {
    const source = args[2];
    for (let offset = 0; offset < 18; offset += 2) source.read(new Uint8Array(2), offset);
    return originalMount(...args);
  });
  const request = requestFixture(); request.debug = 'on';
  const onDiagnostic = vi.fn();
  const operation = runImageGeneration({ ...h, request, onProgress: vi.fn(), onLog: vi.fn(), onDiagnostic });
  if (outcome === 'trap') await expect(operation).rejects.toThrow('mocked Wasm trap');
  else await operation;
  expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: 'file-read', fields: expect.objectContaining({
    report: 'final', reads: 9, bytes: 18, blobReads: 1, blobBytes: 24, cacheHits: 8, cacheHitBytes: 16,
    cacheCapacityBytes: 64 * 1024 * 1024, cacheRetainedBytes: 24,
  }) }));
});

it.each([4, 8] as const)('does not re-enter a trapped native graph with %i-byte pointers', async pointerBytes => {
  const h = harness({ pointerBytes, outcome: 'success', channels: 3 });
  const error = new WebAssembly.RuntimeError('memory access out of bounds');
  error.stack = `\
RuntimeError: memory access out of bounds
    at wasm://wasm/abc:wasm-function[6740]:0xae1009`;
  vi.mocked(h.api.generate_image).mockRejectedValueOnce(error);
  const onDiagnostic = vi.fn(), onProgress = vi.fn();
  await expect(runImageGeneration({ ...h, request: requestFixture(), onProgress, onLog: vi.fn(), onDiagnostic })).rejects.toBe(error);
  expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: 'failed', stage: 'generation', fields: expect.objectContaining({
    errorType: 'wasm-trap', nativeCall: 'generate_image', wasmFrames: 'wasm-function[6740]:0xae1009', workerTerminationRequired: true,
  }) }));
  const failure = onDiagnostic.mock.calls.findIndex(([entry]) => entry.event === 'failed');
  const cleanup = onDiagnostic.mock.calls.findIndex(([entry]) => entry.stage === 'cleanup');
  expect(failure).toBeLessThan(cleanup);
  expect(onDiagnostic.mock.calls[cleanup]?.[0].fields.nativeCleanup).toBe('skipped');
  expect(h.api.generate_image).toHaveBeenCalledOnce();
  expect(h.api.free_sd_ctx).not.toHaveBeenCalled(); expect(h.api.free_sd_images).not.toHaveBeenCalled();
  expect(h.core.free).not.toHaveBeenCalled(); expect(h.core.module.removeFunction).not.toHaveBeenCalled();
  expect(h.api.sd_set_log_callback).toHaveBeenCalledTimes(1);
  expect(h.api.sd_set_progress_callback).toHaveBeenCalledTimes(1);
  expect(h.events).not.toContain('unmount');
  expect(onProgress).toHaveBeenCalledWith({ event: { phase: 'model', step: 901, steps: 901 } });
  expect(onProgress).not.toHaveBeenCalledWith({ event: { phase: 'sampling', step: 901, steps: 901 } });
  expect(onProgress).toHaveBeenCalledWith({ event: { phase: 'sampling', step: 0, steps: 20 } });
});
it.each(['load', 'generation'] as const)('treats a rejection from %s as uncertain native state, without guessing a different profile', async stage => {
  const h = harness({ pointerBytes: 8, outcome: 'success', channels: 3 });
  const error = new Error('Rejected suspending native call');
  if (stage === 'load') vi.mocked(h.api.new_sd_ctx).mockRejectedValueOnce(error);
  else vi.mocked(h.api.generate_image).mockRejectedValueOnce(error);
  const onDiagnostic = vi.fn();
  await expect(runImageGeneration({ ...h, request: requestFixture(), onProgress: vi.fn(), onLog: vi.fn(), onDiagnostic })).rejects.toBe(error);
  expect(h.api.new_sd_ctx).toHaveBeenCalledOnce();
  expect(h.api.generate_image).toHaveBeenCalledTimes(stage === 'load' ? 0 : 1);
  expect(h.api.free_sd_ctx).not.toHaveBeenCalled(); expect(h.core.free).not.toHaveBeenCalled();
  expect(h.events).not.toContain('unmount');
  expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: 'failed', stage: stage === 'load' ? 'model-load' : 'generation', fields: expect.objectContaining({
    errorType: 'error', workerTerminationRequired: true, nativeCall: stage === 'load' ? 'new_sd_ctx' : 'generate_image',
  }) }));
});
it('also skips native cleanup if a short native boundary traps', async () => {
  const h = harness({ pointerBytes: 4, outcome: 'success', channels: 3 });
  const error = new WebAssembly.RuntimeError('unreachable');
  vi.mocked(h.api.sd_img_gen_params_init).mockRejectedValueOnce(error);
  await expect(runImageGeneration({ ...h, request: requestFixture(), onProgress: vi.fn(), onLog: vi.fn() })).rejects.toBe(error);
  expect(h.api.free_sd_ctx).not.toHaveBeenCalled(); expect(h.core.free).not.toHaveBeenCalled();
  expect(h.api.generate_image).not.toHaveBeenCalled();
});
it('does not replace an ordinary generation failure when normal native teardown also fails', async () => {
  const h = harness({ pointerBytes: 4, outcome: 'generation-failure', channels: 3 });
  vi.mocked(h.api.free_sd_ctx).mockRejectedValueOnce(new WebAssembly.RuntimeError('cleanup trap'));
  const onDiagnostic = vi.fn();
  await expect(runImageGeneration({ ...h, request: requestFixture(), onProgress: vi.fn(), onLog: vi.fn(), onDiagnostic })).rejects.toThrow('Image generation did not return one complete image');
  expect(h.api.free_sd_images).toHaveBeenCalledOnce(); expect(h.api.free_sd_ctx).toHaveBeenCalledOnce();
  expect(h.core.free).not.toHaveBeenCalled(); expect(h.events).not.toContain('unmount');
  expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: 'failed', stage: 'cleanup', fields: expect.objectContaining({ errorType: 'wasm-trap' }) }));
});

it.each([4, 8] as const)('reports VAE tile progress and failures as decoding with %i-byte pointers', async pointerBytes => {
  const h = harness({ pointerBytes, outcome: 'success', channels: 4 });
  const onProgress = vi.fn(), onDiagnostic = vi.fn();
  vi.mocked(h.api.generate_image).mockImplementationOnce(async () => {
    h.callbacks.get(h.registrations.progress)?.(8, 8, 0.1, 0);
    h.strings.set(2n, 'bpe_tokenizer.cpp:245 - split prompt "image.cpp:547 - decoding 1 latents"');
    h.callbacks.get(h.registrations.log)?.(1, 2, 0);
    expect(onProgress).not.toHaveBeenCalledWith({ event: { phase: 'decoding', step: 0, steps: 0 } });
    h.strings.set(2n, 'image.cpp:547  - decoding 1 latents\n');
    h.callbacks.get(h.registrations.log)?.(2, 2, 0);
    h.callbacks.get(h.registrations.progress)?.(0, 1, 0.1, 0);
    throw new WebAssembly.RuntimeError('VAE failure');
  });
  await expect(runImageGeneration({ ...h, request: requestFixture(), onProgress, onLog: vi.fn(), onDiagnostic })).rejects.toThrow('VAE failure');
  expect(onProgress).toHaveBeenCalledWith({ event: { phase: 'sampling', step: 8, steps: 8 } });
  expect(onProgress).toHaveBeenCalledWith({ event: { phase: 'decoding', step: 0, steps: 1 } });
  expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: 'failed', stage: 'decoding' }));
  expect(h.api.free_sd_ctx).not.toHaveBeenCalled(); expect(h.core.free).not.toHaveBeenCalled();
});
