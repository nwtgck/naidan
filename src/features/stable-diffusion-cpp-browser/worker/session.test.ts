import { expect, it, vi } from 'vitest';
import { runImageGeneration, createImageGenerationSession, effectiveVaeTile } from './session';
import type { Core, CoreModule, HostHelpers, NativeApi } from './core-types';
import { requestFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import { fixtureReader, ggufFixture } from '@/features/stable-diffusion-cpp-browser/test-utils/weights';
import { imageLoraRequests } from '@/features/stable-diffusion-cpp-browser/lora-form';
import type { ImageEngineInspection } from '@/features/stable-diffusion-cpp-browser/engine-state';

/** This is a mocked native boundary, not a model or WebGPU inference test. */
function harness({ pointerBytes, outcome, channels }: {
  pointerBytes: 4 | 8, outcome: 'success' | 'load-failure' | 'generation-failure' | 'trap', channels: 3 | 4,
}) {
  const events: string[] = [];
  const fields = new Map<string, number | bigint>();
  const recordPointers = new Map<string, bigint>();
  const strings = new Map<bigint, string>();
  const callbacks = new Map<number, (...args: (number | bigint)[]) => void>();
  const registrations = { log: 0, progress: 0, preview: 0 };
  const previewWrites: (number | bigint)[][] = [];
  let cursor = 64;
  const allocate = ({ bytes }: { bytes: number | bigint }) => {
    const pointer = BigInt(cursor); cursor += Math.ceil(Number(bytes) / 16) * 16; return pointer;
  };
  const module: CoreModule = {
    _sdc_sd_cancel_generation: vi.fn(),
    _sdc_sd_set_preview_callback: vi.fn((...args) => {
      previewWrites.push(args);
    }),
    HEAPU8: new Uint8Array(2 * 1024 * 1024), FS: { mkdir: vi.fn() }, _sdc_abi_version: () => 2,
    addFunction: vi.fn((callback, signature) => {
      events.push('callback:' + signature); const pointer = callbacks.size + 10; callbacks.set(pointer, callback); return pointer;
    }),
    removeFunction: vi.fn(pointer => {
      events.push('remove-function'); callbacks.delete(Number(pointer));
    }),
  };
  const api: NativeApi = {
    sd_set_graph_diagnostics: vi.fn(async enabled => {
      events.push('graph-diagnostics:' + enabled);
    }),
    sd_cancel_generation: vi.fn(async () => undefined),
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
    sd_set_preview_callback: vi.fn(async (...args) => {
      registrations.preview = Number(args[0]); previewWrites.push(args);
    }), sd_list_devices: vi.fn(async () => 0n),
    generate_image: vi.fn(async (_ctx, _params, imagesOut, countOut) => {
      if (outcome === 'trap') throw new Error('mocked Wasm trap');
      // Deliberately replace the heap to verify views are acquired after await.
      const old = module.HEAPU8; module.HEAPU8 = new Uint8Array(4 * 1024 * 1024); module.HEAPU8.set(old);
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
    constant: vi.fn(name => name === 'SD_TYPE_F32' ? 0 : name === 'SD_TYPE_F16' ? 1 : name === 'SD_CANCEL_ALL' ? 0 : name === 'SD_CANCEL_RESET' ? 2 : name === 'PREVIEW_PROJ' ? 1 : name === 'PREVIEW_VAE' ? 3 : name === 'PREVIEW_NONE' ? 0 : 100),
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
  return { core, api, helpers, reader, fields, recordPointers, strings, events, callbacks, registrations, previewWrites };
}

function enableSnapshotGetters({ h }: { h: ReturnType<typeof harness> }) {
  h.api.sd_ctx_get_runtime_info = vi.fn(async (_context: bigint, pointer: bigint) => {
    h.fields.set(`sd_runtime_info_t:${pointer}:version`, 1); h.fields.set(`sd_runtime_info_t:${pointer}:struct_size`, 1024); return 1;
  });
  h.api.sd_ctx_get_memory_info = vi.fn(async (_context: bigint, pointer: bigint) => {
    h.fields.set(`sd_memory_info_t:${pointer}:version`, 1); h.fields.set(`sd_memory_info_t:${pointer}:struct_size`, 1024); return 1;
  });
  h.api.sd_ctx_get_params = vi.fn(async () => 1);
}

it('observes only an idle loaded session, never native callbacks, closed sessions or an unobserved run', async () => {
  const h = harness({ pointerBytes: 8, outcome: 'success', channels: 3 }); enableSnapshotGetters({ h });
  const session = createImageGenerationSession(h), callbacks: Promise<ImageEngineInspection>[] = [];
  expect(await session.inspectEngine()).toEqual({ status: 'unavailable', reason: 'not-loaded' });
  await session.generate({ request: requestFixture(), onProgress: vi.fn(), onLog() {
    callbacks.push(session.inspectEngine());
  } });
  for (const pending of callbacks) expect(await pending).toEqual({ status: 'unavailable', reason: 'busy' });
  expect(h.api.sd_ctx_get_runtime_info).not.toHaveBeenCalled(); expect(h.api.sd_ctx_get_memory_info).not.toHaveBeenCalled();
  expect(await session.inspectEngine()).toMatchObject({ status: 'ready', snapshot: { modelVersion: 'mock model (no inference)' } });
  await session.close(); expect(await session.inspectEngine()).toEqual({ status: 'unavailable', reason: 'released' });
  expect(h.api.sd_ctx_get_runtime_info).toHaveBeenCalledOnce(); expect(h.api.sd_ctx_get_memory_info).toHaveBeenCalledOnce();
});
it('reserves the next run but waits for an in-flight idle observation before native generation', async () => {
  const h = harness({ pointerBytes: 4, outcome: 'success', channels: 3 }); enableSnapshotGetters({ h });
  const session = createImageGenerationSession(h), run = { request: requestFixture(), onProgress: vi.fn(), onLog: vi.fn() };
  await session.generate(run);
  const waiting = Promise.withResolvers<void>();
  const getter = vi.mocked(h.api.sd_ctx_get_runtime_info!), original = getter.getMockImplementation()!;
  getter.mockImplementationOnce(async (...args) => {
    await waiting.promise; return original(...args);
  });
  const observation = session.inspectEngine(), generation = session.generate(run);
  expect(h.api.generate_image).toHaveBeenCalledOnce();
  expect(await session.inspectEngine()).toEqual({ status: 'unavailable', reason: 'busy' });
  waiting.resolve(); await observation; await generation;
  expect(h.api.generate_image).toHaveBeenCalledTimes(2); await session.close();
});
it('keeps retryable observation failure separate from generation and forbids native cleanup after an observation trap', async () => {
  const h = harness({ pointerBytes: 8, outcome: 'success', channels: 3 }); enableSnapshotGetters({ h });
  const session = createImageGenerationSession(h), run = { request: requestFixture(), onProgress: vi.fn(), onLog: vi.fn() };
  await session.generate(run);
  vi.mocked(h.api.sd_ctx_get_memory_info!).mockRejectedValueOnce(new Error('Observation unavailable'));
  expect(await session.inspectEngine()).toMatchObject({ status: 'failed', disposition: 'retryable' });
  await session.generate(run); expect(h.api.generate_image).toHaveBeenCalledTimes(2);
  vi.mocked(h.api.sd_ctx_get_memory_info!).mockRejectedValueOnce(new WebAssembly.RuntimeError('memory access out of bounds'));
  const freed = vi.mocked(h.core.free).mock.calls.length;
  expect(await session.inspectEngine()).toMatchObject({ status: 'failed', disposition: 'retire-worker' });
  await expect(session.generate(run)).rejects.toThrow('failed'); await session.close();
  expect(h.api.generate_image).toHaveBeenCalledTimes(2); expect(h.api.free_sd_ctx).not.toHaveBeenCalled(); expect(h.core.free).toHaveBeenCalledTimes(freed);
});

it.each(['on', 'off', undefined] as const)('sets graph diagnostics from debug=%s before native work and disables them after success', async debug => {
  const h = harness({ pointerBytes: 4, outcome: 'success', channels: 3 });
  const request = requestFixture(); request.debug = debug;
  const onLog = vi.fn();
  await runImageGeneration({ ...h, request, onProgress: vi.fn(), onLog });
  expect(h.api.sd_set_graph_diagnostics).toHaveBeenNthCalledWith(1, Number(debug === 'on'));
  expect(h.api.sd_set_graph_diagnostics).toHaveBeenNthCalledWith(2, 0);
  expect(h.api.sd_set_graph_diagnostics).toHaveBeenCalledTimes(2);
  expect(h.events.indexOf('graph-diagnostics:' + Number(debug === 'on'))).toBeLessThan(h.events.indexOf('ctx-defaults'));
  expect(h.events.lastIndexOf('graph-diagnostics:0')).toBeLessThan(h.events.indexOf('free-images'));
  expect(onLog).toHaveBeenCalledWith({ message: 'native progress diagnostic', level: 1 });
});
it('opens a new graph diagnostic window per retained request and never toggles it from native callbacks', async () => {
  const h = harness({ pointerBytes: 8, outcome: 'success', channels: 3 });
  const request = requestFixture(); request.sessionId = 'retained';
  const session = createImageGenerationSession(h);
  const callsDuringCallbacks: number[][] = [];
  for (const [index, debug] of (['on', 'on', 'off'] as const).entries()) {
    const observed: number[] = []; callsDuringCallbacks.push(observed);
    await session.generate({ request: { ...request, runId: index, debug }, onProgress: vi.fn(), onLog() {
      observed.push(vi.mocked(h.api.sd_set_graph_diagnostics).mock.calls.length);
    } });
  }
  expect(callsDuringCallbacks.map(calls => [...new Set(calls)])).toEqual([[1], [3], [5]]);
  expect(vi.mocked(h.api.sd_set_graph_diagnostics).mock.calls).toEqual([[1], [0], [1], [0], [0], [0]]);
  expect(h.api.new_sd_ctx).toHaveBeenCalledOnce();
  await session.close();
});
it.each(['load-failure', 'generation-failure'] as const)('disables graph diagnostics after a safely returned %s', async outcome => {
  const h = harness({ pointerBytes: 4, outcome, channels: 3 });
  const request = requestFixture(); request.debug = 'on';
  await expect(runImageGeneration({ ...h, request, onProgress: vi.fn(), onLog: vi.fn() })).rejects.toThrow();
  expect(vi.mocked(h.api.sd_set_graph_diagnostics).mock.calls).toEqual([[1], [0]]);
});
it('preserves the generation error and stops native cleanup if disabling diagnostics traps', async () => {
  const h = harness({ pointerBytes: 4, outcome: 'generation-failure', channels: 3 });
  const request = requestFixture(); request.debug = 'on';
  vi.mocked(h.api.sd_set_graph_diagnostics).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new WebAssembly.RuntimeError('cleanup trap'));
  const onDiagnostic = vi.fn();
  await expect(runImageGeneration({ ...h, request, onProgress: vi.fn(), onLog: vi.fn(), onDiagnostic })).rejects.toThrow('Image generation did not return one complete image');
  expect(vi.mocked(h.api.sd_set_graph_diagnostics).mock.calls).toEqual([[1], [0]]);
  expect(h.api.free_sd_images).not.toHaveBeenCalled(); expect(h.api.free_sd_ctx).not.toHaveBeenCalled();
  expect(h.core.free).not.toHaveBeenCalled(); expect(h.events).not.toContain('unmount');
  expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: 'failed', stage: 'cleanup', message: 'Graph diagnostic cleanup failed; Worker termination required' }));
});

it.each(['f32', 'f16'] as const)('passes the explicit BF16 weight conversion to the native context: %s', async bf16WeightType => {
  const h = harness({ pointerBytes: 4, outcome: 'success', channels: 3 });
  const request = requestFixture(); request.parameters.bf16WeightType = bf16WeightType;
  await runImageGeneration({ core: h.core, helpers: h.helpers, reader: h.reader, request, onProgress: vi.fn(), onLog: vi.fn() });
  const ctx = h.recordPointers.get('sd_ctx_params_t')!;
  expect(h.fields.get(`sd_ctx_params_t:${ctx}:webgpu_bf16_type`)).toBe(bf16WeightType === 'f32' ? 0 : 1);
});
it.each([4, 8] as const)('keeps LoRA sources mounted while changing strengths and clearing adapters with %i-byte pointers', async pointerBytes => {
  const h = harness({ pointerBytes, outcome: 'success', channels: 3 });
  const request = requestFixture();
  request.loras = [
    { file: request.models[0]!.file, path: 'same.gguf', strength: 1 },
    { file: request.models[0]!.file, path: 'same.gguf', strength: -0.5 },
  ];
  const session = createImageGenerationSession({ core: h.core, helpers: h.helpers, reader: h.reader });
  const onDiagnostic = vi.fn();
  const run = () => session.generate({ request, onProgress: vi.fn(), onLog: vi.fn(), onDiagnostic });
  await run();
  const image = h.recordPointers.get('sd_img_gen_params_t')!;
  const records = BigInt(h.fields.get(`sd_img_gen_params_t:${image}:loras`)!);
  expect(h.fields.get(`sd_img_gen_params_t:${image}:lora_count`)).toBe(2);
  for (const [index, strength] of [1, -0.5].entries()) {
    const pointer = records + BigInt(index * h.core.recordSize('sd_lora_t'));
    expect(h.fields.get(`sd_lora_t:${pointer}:multiplier`)).toBe(strength);
    expect(h.fields.get(`sd_lora_t:${pointer}:is_high_noise`)).toBe(0);
    expect(h.strings.get(BigInt(h.fields.get(`sd_lora_t:${pointer}:path`)!))).toBe(`/models/lora-${index}/same.gguf`);
  }
  request.loras[0]!.strength = 0.25;
  request.loras[1]!.strength = 0;
  await run();
  const next = h.recordPointers.get('sd_img_gen_params_t')!;
  const nextRecords = BigInt(h.fields.get(`sd_img_gen_params_t:${next}:loras`)!);
  expect(h.fields.get(`sd_img_gen_params_t:${next}:lora_count`)).toBe(1);
  expect(h.fields.get(`sd_lora_t:${nextRecords}:multiplier`)).toBe(0.25);
  request.loras[0]!.strength = 0;
  await run();
  const cleared = h.recordPointers.get('sd_img_gen_params_t')!;
  expect(h.fields.get(`sd_img_gen_params_t:${cleared}:loras`)).toBe(0n);
  expect(h.fields.get(`sd_img_gen_params_t:${cleared}:lora_count`)).toBe(0);
  expect(h.api.new_sd_ctx).toHaveBeenCalledOnce();
  expect(h.helpers.mountReadOnlyFile).toHaveBeenCalledTimes(3);
  expect(h.events).not.toContain('unmount');
  expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ fields: expect.objectContaining({ metric: 'lora-request', strength: 0 }) }));
  await session.close();
  expect(h.events.indexOf('free-context')).toBeLessThan(h.events.indexOf('unmount'));
  expect(h.events.filter(event => event === 'unmount')).toHaveLength(3);
});
it('never inspects or mounts disabled unreadable adapters but still checks an enabled zero-strength adapter', async () => {
  const unavailable = new File([new Uint8Array(24)], 'unavailable.gguf');
  const read = vi.spyOn(unavailable, 'slice').mockImplementation(() => {
    throw new DOMException('Permission was revoked', 'NotReadableError');
  });
  const request = requestFixture();
  const selections = [
    { file: request.models[0]!.file, path: 'first.gguf', strength: 0.5, enabled: true },
    { file: unavailable, strength: -0.75, enabled: false },
    { file: request.models[0]!.file, path: 'last.gguf', strength: 1, enabled: true },
  ];
  const h = harness({ pointerBytes: 8, outcome: 'success', channels: 3 });
  request.loras = imageLoraRequests({ selections });
  await runImageGeneration({ core: h.core, helpers: h.helpers, reader: h.reader, request, onProgress: vi.fn(), onLog: vi.fn() });
  expect(read).not.toHaveBeenCalled();
  expect(h.events.filter(event => event.startsWith('mount:'))).toEqual([
    '/models/model/model.gguf', '/models/lora-0/first.gguf', '/models/lora-1/last.gguf',
  ].map(path => 'mount:' + path));
  selections[1]!.enabled = true;
  selections[1]!.strength = 0;
  request.loras = imageLoraRequests({ selections });
  const retry = harness({ pointerBytes: 8, outcome: 'success', channels: 3 });
  await expect(runImageGeneration({ core: retry.core, helpers: retry.helpers, reader: retry.reader, request, onProgress: vi.fn(), onLog: vi.fn() })).rejects.toThrow('Permission was revoked');
  expect(read).toHaveBeenCalled();
  expect(retry.api.new_sd_ctx).not.toHaveBeenCalled();
});

it('rejects an older artifact before mounting weights rather than ignoring BF16 conversion', async () => {
  const h = harness({ pointerBytes: 4, outcome: 'success', channels: 3 });
  const original = h.core.fieldAddress;
  vi.mocked(h.core.fieldAddress).mockImplementation((name, pointer, field) => {
    if (field === 'webgpu_bf16_type') throw new TypeError('Unknown field');
    return original(name, pointer, field);
  });
  await expect(runImageGeneration({ core: h.core, helpers: h.helpers, reader: h.reader, request: requestFixture(), onProgress: vi.fn(), onLog: vi.fn() })).rejects.toThrow('Update the image runtime');
  expect(h.helpers.mountReadOnlyFile).not.toHaveBeenCalled();
  expect(h.api.new_sd_ctx).not.toHaveBeenCalled();
  expect(h.api.generate_image).not.toHaveBeenCalled();
});
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
  expect(h.core.module.removeFunction).toHaveBeenCalledTimes(3);
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
  expect(h.api.sd_set_graph_diagnostics).toHaveBeenCalledExactlyOnceWith(0);
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
  expect(h.api.sd_set_graph_diagnostics).toHaveBeenCalledExactlyOnceWith(0);
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
  let freesAtTrap = 0;
  vi.mocked(h.api.free_sd_ctx).mockImplementationOnce(async () => {
    freesAtTrap = vi.mocked(h.core.free).mock.calls.length; throw new WebAssembly.RuntimeError('cleanup trap');
  });
  const onDiagnostic = vi.fn();
  await expect(runImageGeneration({ ...h, request: requestFixture(), onProgress: vi.fn(), onLog: vi.fn(), onDiagnostic })).rejects.toThrow('Image generation did not return one complete image');
  expect(h.api.free_sd_images).toHaveBeenCalledOnce(); expect(h.api.free_sd_ctx).toHaveBeenCalledOnce();
  expect(vi.mocked(h.core.free).mock.calls.length).toBe(freesAtTrap); expect(h.events).not.toContain('unmount');
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

it.each([4, 8] as const)('retains one context and mounts across different prompts with %i-byte pointers, freeing only per-image buffers', async pointerBytes => {
  const h = harness({ pointerBytes, outcome: 'success', channels: 3 });
  const session = createImageGenerationSession(h), request = requestFixture(); request.sessionId = 'retained';
  const args = { request, onProgress: vi.fn(), onLog: vi.fn(), onDiagnostic: vi.fn() };
  await session.generate(args);
  const ctxRecord = h.recordPointers.get('sd_ctx_params_t')!;
  expect(h.api.free_sd_ctx).not.toHaveBeenCalled(); expect(h.events).not.toContain('unmount');
  expect(h.core.free).not.toHaveBeenCalledWith(ctxRecord);
  const firstImage = h.recordPointers.get('sd_img_gen_params_t')!;
  expect(h.core.free).toHaveBeenCalledWith(firstImage);
  request.parameters.prompt = 'another image'; request.parameters.seed = '123'; request.runId++;
  await session.generate(args);
  expect(h.api.new_sd_ctx).toHaveBeenCalledTimes(1); expect(h.helpers.mountReadOnlyFile).toHaveBeenCalledTimes(1);
  expect(h.api.generate_image).toHaveBeenCalledTimes(2); expect(h.api.free_sd_images).toHaveBeenCalledTimes(2);
  expect(h.core.module.addFunction).toHaveBeenCalledTimes(3);
  expect(args.onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ fields: { reused: true } }));
  await session.close(); await session.close();
  expect(h.api.free_sd_ctx).toHaveBeenCalledTimes(1); expect(h.core.free).toHaveBeenCalledWith(ctxRecord);
  expect(h.events.filter(event => event === 'unmount')).toHaveLength(1);
});
it('rejects simultaneous generation/cleanup and cannot reuse a poisoned context', async () => {
  const h = harness({ pointerBytes: 8, outcome: 'success', channels: 3 });
  const pending = Promise.withResolvers<number>(), started = Promise.withResolvers<void>();
  vi.mocked(h.api.generate_image).mockImplementationOnce(() => {
    started.resolve(); return pending.promise;
  });
  const session = createImageGenerationSession(h), args = { request: requestFixture(), onProgress: vi.fn(), onLog: vi.fn() };
  const first = session.generate(args); await started.promise;
  await expect(session.generate(args)).rejects.toThrow('busy'); await expect(session.close()).rejects.toThrow('cleanup during generation');
  const failed = expect(first).rejects.toThrow('native trap'); pending.reject(new WebAssembly.RuntimeError('native trap')); await failed;
  await expect(session.generate(args)).rejects.toThrow('failed'); await session.close();
  expect(h.api.free_sd_ctx).not.toHaveBeenCalled(); expect(h.events).not.toContain('unmount');
});
it.each([4, 8] as const)('turns previews ON/OFF during native generation using only the reviewed scalar export (%i-byte pointers)', async pointerBytes => {
  const h = harness({ pointerBytes, outcome: 'success', channels: 3 });
  const request = requestFixture(); request.runId = 5; request.preview.interval = 1;
  const onPreview = vi.fn(), session = createImageGenerationSession(h);
  const original = vi.mocked(h.api.generate_image).getMockImplementation()!;
  vi.mocked(h.api.generate_image).mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    const previewPointer = h.registrations.preview;
    const updates = (revision: number, enabled: boolean) => ({ type: 'naidan-image-preview-control-v1' as const, runId: 5, revision, settings: { ...request.preview, enabled } });
    expect(session.updatePreview({ control: updates(1, true) })).toBe(true);
    h.callbacks.get(previewPointer)?.(1, 1, 300000n, 0, 0n);
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(session.updatePreview({ control: updates(2, false) })).toBe(true);
    h.callbacks.get(previewPointer)?.(2, 1, 300000n, 0, 0n);
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(session.updatePreview({ control: updates(3, true) })).toBe(true);
    h.callbacks.get(previewPointer)?.(3, 1, 300000n, 0, 0n);
    h.callbacks.get(previewPointer)?.(-3, 1, 300000n, 0, 0n); // intermediate multistep evaluation is not a new logical step
    expect(onPreview).toHaveBeenCalledTimes(2);
    expect(h.api.sd_set_preview_callback).toHaveBeenCalledTimes(1); // startup only, not generic busy API
    expect(h.core.module._sdc_sd_set_preview_callback).toHaveBeenCalledTimes(3);
    return result;
  });
  await session.generate({ request, onProgress: vi.fn(), onLog: vi.fn(), onPreview });
  expect(onPreview.mock.calls.map(([{ capture }]) => [capture.step, capture.revision])).toEqual([[1, 1], [3, 3]]);
  expect(onPreview.mock.calls[0]![0].capture.image.pixels[0]).toBe(71); // copy survived free_sd_images
  await session.close();
});
it('keeps raw preview control disabled after a native trap', async () => {
  const h = harness({ pointerBytes: 8, outcome: 'trap', channels: 3 }), session = createImageGenerationSession(h), request = requestFixture(); request.runId = 1;
  await expect(session.generate({ request, onProgress: vi.fn(), onLog: vi.fn() })).rejects.toThrow();
  const writes = h.previewWrites.length;
  expect(session.updatePreview({ control: { type: 'naidan-image-preview-control-v1', runId: 1, revision: 1, settings: { ...request.preview, enabled: true } } })).toBe(false);
  await session.close(); expect(h.previewWrites).toHaveLength(writes);
});
it.each([
  ['Qwen Image 2.1', 32, 'bounded', true, 16], ['Qwen Image 2.1', 64, 'native', true, 64],
  ['Qwen Image 2.1', 32, 'bounded', false, 32], ['Z-Image', 32, 'bounded', true, 32], ['Unknown', 64, 'bounded', true, 64],
] as const)('bounds VAE working tiles only for the exact native model and explicit policy: %s/%i/%s/%s', (modelVersion, requested, policy, enabled, expected) => {
  expect(effectiveVaeTile({ modelVersion, requested, policy, enabled })).toBe(expected);
});
it('does not automatically rerun intentional white output or change the user prompt, guidance, seed or dimensions', async () => {
  const h = harness({ pointerBytes: 8, outcome: 'success', channels: 4 }), request = requestFixture();
  const original = vi.mocked(h.api.generate_image).getMockImplementation()!;
  vi.mocked(h.api.generate_image).mockImplementationOnce(async (...args) => {
    const result = await original(...args); h.core.module.HEAPU8.fill(255, 400000, 400000 + 256 * 256 * 4); return result;
  });
  const output = await runImageGeneration({ ...h, request, onProgress: vi.fn(), onLog: vi.fn(), onDiagnostic: vi.fn() });
  expect(output.uniformOutput).toBe(true); expect(h.api.generate_image).toHaveBeenCalledTimes(1);
  expect(output.width).toBe(request.parameters.width); expect(output.height).toBe(request.parameters.height);
});
it('does not relabel detailed preview VAE tiles as denoising steps', async () => {
  const h = harness({ pointerBytes: 8, outcome: 'success', channels: 3 }), request = requestFixture();
  request.runId = 1; request.preview = { ...request.preview, mode: 'vae', enabled: true }; request.parameters.steps = 8;
  const onProgress = vi.fn(), onPreview = vi.fn();
  const original = vi.mocked(h.api.generate_image).getMockImplementation()!;
  vi.mocked(h.api.generate_image).mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    h.strings.set(2n, 'vae.hpp:285 - VAE Tile size: 16x16\n'); h.callbacks.get(h.registrations.log)?.(1, 2, 0);
    h.callbacks.get(h.registrations.progress)?.(0, 9, 0.1, 0);
    h.callbacks.get(h.registrations.progress)?.(9, 9, 0.1, 0);
    h.strings.set(2n, 'vae.hpp:319 - computing vae decode graph completed, taking 1.0s\n'); h.callbacks.get(h.registrations.log)?.(1, 2, 0);
    h.callbacks.get(h.registrations.preview)?.(1, 1, 300000n, 0, 0n);
    h.callbacks.get(h.registrations.progress)?.(1, 8, 0.1, 0);
    return result;
  });
  await runImageGeneration({ ...h, request, onProgress, onLog: vi.fn(), onPreview });
  expect(onProgress.mock.calls.some(([{ event }]) => event.phase === 'sampling' && event.steps === 9)).toBe(false);
  expect(onProgress).toHaveBeenCalledWith({ event: { phase: 'sampling', step: 1, steps: 8 } });
  expect(onPreview).toHaveBeenCalledTimes(1);
});

it('enables the threshold step before its preview and never copies a pre-threshold frame', async () => {
  const h = harness({ pointerBytes: 8, outcome: 'success', channels: 3 });
  const request = requestFixture(); request.runId = 1; request.parameters.steps = 8;
  request.preview = { ...request.preview, enabled: true, startStep: 4, interval: 2 };
  const onPreview = vi.fn(), onProgress = vi.fn();
  const original = vi.mocked(h.api.generate_image).getMockImplementation()!;
  vi.mocked(h.api.generate_image).mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    const progress = h.callbacks.get(h.registrations.progress)!;
    const preview = h.callbacks.get(h.registrations.preview)!;
    const enabled = () => h.previewWrites.at(-1)?.[3];
    expect(enabled()).toBe(0);
    // Preview occurs before the progress callback for its own denoising step.
    preview(2, 1, 300000n, 0, 0n);
    progress(2, 8, 0.1, 0n);
    expect(enabled()).toBe(0);
    // Ignore model/tile progress counters that aren't this sampling schedule.
    progress(900, 901, 0.1, 0n);
    expect(enabled()).toBe(0);
    progress(3, 8, 0.1, 0n);
    expect(enabled()).toBe(1);
    preview(4, 1, 300000n, 0, 0n);
    progress(4, 8, 0.1, 0n);
    return result;
  });
  await runImageGeneration({ ...h, request, onProgress, onLog: vi.fn(), onPreview });
  expect(onPreview.mock.calls.map(([{ capture }]) => capture.step)).toEqual([4]);
  expect(onPreview.mock.calls[0]![0].capture.image.pixels[0]).toBe(71);
});

it.each([4, 8] as const)('cooperatively cancels native sampling, cleans run memory and reuses weights (%i-byte pointers)', async pointerBytes => {
  const h = harness({ pointerBytes, outcome: 'success', channels: 3 });
  const session = createImageGenerationSession(h), request = requestFixture(); request.runId = 8; request.sessionId = 'one'; request.debug = 'on';
  const entered = Promise.withResolvers<void>(), native = Promise.withResolvers<number>();
  vi.mocked(h.api.generate_image).mockImplementationOnce(() => {
    entered.resolve(); return native.promise;
  });
  const task = session.generate({ request, onProgress: vi.fn(), onLog: vi.fn() });
  await entered.promise;
  expect(session.cancel({ control: { type: 'naidan-image-cancel-v1', runId: 9 } })).toBe(false);
  expect(session.cancel({ control: { type: 'naidan-image-cancel-v1', runId: 8 } })).toBe(true);
  session.cancel({ control: { type: 'naidan-image-cancel-v1', runId: 8 } });
  expect(h.core.module._sdc_sd_cancel_generation).toHaveBeenCalledExactlyOnceWith(200000n, 0);
  expect(h.api.free_sd_ctx).not.toHaveBeenCalled(); expect(h.api.sd_cancel_generation).not.toHaveBeenCalled();
  expect(h.api.sd_set_graph_diagnostics).toHaveBeenCalledExactlyOnceWith(1);
  native.resolve(0); expect(await task).toEqual({ cancelled: true, modelResident: true });
  expect(vi.mocked(h.api.sd_set_graph_diagnostics).mock.calls).toEqual([[1], [0]]);
  expect(h.api.sd_cancel_generation).toHaveBeenCalledWith(200000n, 2);
  expect(h.api.free_sd_ctx).not.toHaveBeenCalled();
  const next = await session.generate({ request: { ...request, runId: 9 }, onProgress: vi.fn(), onLog: vi.fn() });
  expect('pixels' in next).toBe(true); expect(h.api.new_sd_ctx).toHaveBeenCalledTimes(1);
  await session.close(); expect(h.api.free_sd_ctx).toHaveBeenCalledTimes(1);
});
it('waits for initialization to return and keeps the context when cancelled while loading', async () => {
  const h = harness({ pointerBytes: 8, outcome: 'success', channels: 3 });
  const entered = Promise.withResolvers<void>(), load = Promise.withResolvers<bigint>();
  vi.mocked(h.api.new_sd_ctx).mockImplementationOnce(() => {
    entered.resolve(); return load.promise;
  });
  const session = createImageGenerationSession(h), request = requestFixture(); request.runId = 1; request.debug = 'on';
  const task = session.generate({ request, onProgress: vi.fn(), onLog: vi.fn() }); await entered.promise;
  session.cancel({ control: { type: 'naidan-image-cancel-v1', runId: 1 } });
  expect(h.core.module._sdc_sd_cancel_generation).not.toHaveBeenCalled();
  expect(h.api.sd_set_graph_diagnostics).toHaveBeenCalledExactlyOnceWith(1);
  load.resolve(200000n); expect(await task).toEqual({ cancelled: true, modelResident: true });
  expect(vi.mocked(h.api.sd_set_graph_diagnostics).mock.calls).toEqual([[1], [0]]);
  expect(h.api.generate_image).not.toHaveBeenCalled();
  await session.generate({ request: { ...request, runId: 2 }, onProgress: vi.fn(), onLog: vi.fn() });
  expect(h.api.new_sd_ctx).toHaveBeenCalledOnce(); await session.close();
});
it('does not confuse a trap after a cancel request with successful cancellation', async () => {
  const h = harness({ pointerBytes: 8, outcome: 'success', channels: 3 }), session = createImageGenerationSession(h), request = requestFixture(); request.runId = 1;
  const entered = Promise.withResolvers<void>(), native = Promise.withResolvers<number>();
  vi.mocked(h.api.generate_image).mockImplementationOnce(() => {
    entered.resolve(); return native.promise;
  });
  const task = session.generate({ request, onProgress: vi.fn(), onLog: vi.fn() }); await entered.promise;
  session.cancel({ control: { type: 'naidan-image-cancel-v1', runId: 1 } });
  native.reject(new WebAssembly.RuntimeError('out of bounds'));
  await expect(task).rejects.toThrow('out of bounds');
  expect(h.api.sd_set_graph_diagnostics).toHaveBeenCalledExactlyOnceWith(0);
  expect(h.api.sd_cancel_generation).not.toHaveBeenCalled(); expect(h.api.free_sd_images).not.toHaveBeenCalled();
  await session.close(); expect(h.api.free_sd_ctx).not.toHaveBeenCalled();
});

it('emits zero per-run file traffic for a retained generation without re-reading weights for diagnostics', async () => {
  const h = harness({ pointerBytes: 8, outcome: 'success', channels: 3 });
  const session = createImageGenerationSession(h), request = requestFixture(); request.debug = 'on'; request.sessionId = 'one';
  vi.mocked(h.api.new_sd_ctx).mockImplementationOnce(async () => {
    const source = vi.mocked(h.helpers.mountReadOnlyFile).mock.calls[0]![2];
    source.read(new Uint8Array(12), 0); return 200000n;
  });
  const onDiagnostic = vi.fn(), options = { request, onDiagnostic, onProgress: vi.fn(), onLog: vi.fn() };
  await session.generate(options);
  const read = onDiagnostic.mock.calls.map(([event]) => event.fields).find(fields => fields.metric === 'file-read-run');
  expect(read).toMatchObject({ reads: 1, bytes: 12, blobReads: 1 });
  onDiagnostic.mockClear(); await session.generate({ ...options, request: { ...request, runId: request.runId + 1 } });
  const second = onDiagnostic.mock.calls.map(([event]) => event.fields).find(fields => fields.metric === 'file-read-run');
  expect(second).toMatchObject({ reads: 0, bytes: 0, blobReads: 0, blobBytes: 0, cacheHits: 0, readMs: 0 });
  expect(h.api.new_sd_ctx).toHaveBeenCalledOnce(); await session.close();
});

it.each([4, 8] as const)('keeps image pixels until native return, updates and clears per-run inputs with %i-byte pointers', async pointerBytes => {
  const h = harness({ pointerBytes, outcome: 'success', channels: 3 });
  const bitmap = { width: 2, height: 1, close: vi.fn() };
  let value = 9;
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  vi.stubGlobal('OffscreenCanvas', class {
    getContext() {
      return { fillStyle: '', fillRect() {}, drawImage() {}, getImageData() {
        return { data: new Uint8ClampedArray([value, 2, 3, 255, 4, 5, 6, 255]) };
      } };
    }
  });
  const session = createImageGenerationSession({ core: h.core, helpers: h.helpers, reader: h.reader });
  const request = requestFixture();
  const first = new File(['one'], 'same.png', { type: 'image/png' }), second = new File(['two'], 'same.png', { type: 'image/png' });
  request.imageInputs = { initImage: first, strength: 0.4, referenceImages: [first] };
  const original = h.api.generate_image;
  const observed: number[] = [];
  h.api.generate_image = vi.fn<NativeApi['generate_image']>(async (ctx, params, imagesOut, countOut) => {
    const records = h.fields.get(`sd_img_gen_params_t:${params}:ref_images`);
    if (records !== undefined) {
      const data = BigInt(h.fields.get(`sd_image_t:${records}:data`)!);
      expect(h.core.free).not.toHaveBeenCalledWith(data);
      observed.push(h.core.bytes(data, 1)[0]!);
    } else observed.push(-1);
    return original(ctx, params, imagesOut, countOut);
  });
  try {
    await session.generate({ request, onProgress: vi.fn(), onLog: vi.fn() });
    value = 8; request.imageInputs = { initImage: undefined, strength: 0.4, referenceImages: [second] };
    await session.generate({ request, onProgress: vi.fn(), onLog: vi.fn() });
    request.imageInputs.referenceImages = [];
    await session.generate({ request, onProgress: vi.fn(), onLog: vi.fn() });
    expect(observed).toEqual([9, 8, -1]); expect(h.api.new_sd_ctx).toHaveBeenCalledOnce();
    expect(bitmap.close).toHaveBeenCalledTimes(3);
    await session.close();
  } finally {
    vi.unstubAllGlobals();
  }
});
it('settles cancellation during input decode without entering native generation or leaking the bitmap', async () => {
  const h = harness({ pointerBytes: 8, outcome: 'success', channels: 3 });
  const bitmap = { width: 2, height: 1, close: vi.fn() };
  const decode = Promise.withResolvers<typeof bitmap>();
  vi.stubGlobal('createImageBitmap', vi.fn(() => decode.promise));
  const session = createImageGenerationSession({ core: h.core, helpers: h.helpers, reader: h.reader });
  const request = requestFixture(); request.runId = 1;
  request.imageInputs.initImage = new File(['one'], 'image.png', { type: 'image/png' });
  try {
    const run = session.generate({ request, onProgress: vi.fn(), onLog: vi.fn() });
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledOnce());
    expect(session.cancel({ control: { type: 'naidan-image-cancel-v1', runId: 1 } })).toBe(true);
    decode.resolve(bitmap);
    await expect(run).resolves.toEqual({ cancelled: true, modelResident: true });
    expect(h.api.generate_image).not.toHaveBeenCalled(); expect(bitmap.close).toHaveBeenCalledOnce();
    expect(h.core.free).toHaveBeenCalledWith(h.recordPointers.get('sd_img_gen_params_t'));
    await session.close();
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(['projection', 'vae'] as const)('excludes input VAE tile progress and fixes the total before the first %s preview', async mode => {
  const h = harness({ pointerBytes: 8, outcome: 'success', channels: 3 });
  const request = requestFixture(); request.parameters.steps = 30;
  request.preview = { ...request.preview, mode, enabled: true, startStep: 1 };
  request.imageInputs = { initImage: new File(['image'], 'source.png', { type: 'image/png' }), strength: 0.4, referenceImages: [] };
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2, height: 1, close() {} })));
  vi.stubGlobal('OffscreenCanvas', class {
    getContext() {
      return { fillStyle: '', fillRect() {}, drawImage() {}, getImageData() {
        return { data: new Uint8ClampedArray(8) };
      } };
    }
  });
  const onProgress = vi.fn(), onPreview = vi.fn(), onPerformance = vi.fn();
  const original = vi.mocked(h.api.generate_image).getMockImplementation()!;
  vi.mocked(h.api.generate_image).mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    const progress = h.callbacks.get(h.registrations.progress)!;
    const preview = h.callbacks.get(h.registrations.preview)!;
    h.strings.set(69n, 'vae.hpp:229  - VAE Tile size: 32x32');
    h.callbacks.get(h.registrations.log)!(1, 69n, 0n);
    progress(0, 4, 0, 0n); progress(1, 4, 0.1, 0n); progress(4, 4, 0.1, 0n);
    // A tile count can also equal the requested denoising total.
    progress(0, 30, 0, 0n); progress(1, 30, 0.1, 0n);
    expect(onPerformance.mock.calls.filter(([event]) => event.signal.kind === 'sampling-progress')).toEqual([]);
    h.strings.set(70n, 'image.cpp:859  - generating image: 1/1 - seed 42');
    h.callbacks.get(h.registrations.log)!(1, 70n, 0n);
    progress(0, 13, 0, 0n);
    preview(1, 1, 300000n, 0, 0n);
    progress(1, 13, 0.1, 0n);
    progress(2, 4, 0.1, 0n);
    return result;
  });
  try {
    await runImageGeneration({ ...h, request, onProgress, onLog: vi.fn(), onPerformance, onPreview });
    expect(onPerformance.mock.calls.filter(([event]) => event.signal.kind === 'sampling-progress').map(([event]) => event.signal)).toEqual([
      { kind: 'sampling-progress', step: 0, steps: 13 }, { kind: 'sampling-progress', step: 1, steps: 13 },
    ]);
    expect(onProgress.mock.calls.some(([{ event }]) => event.phase === 'sampling' && event.steps === 4)).toBe(false);
    expect(onPreview.mock.calls.map(([{ capture }]) => ({ step: capture.step, steps: capture.steps }))).toEqual([{ step: 1, steps: 13 }]);
  } finally {
    vi.unstubAllGlobals();
  }
});
