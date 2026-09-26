import { imageErrorContext, type ImageDiagnosticInput, type createImageTrace } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import type { Request, Progress, ModelSlot } from '@/features/stable-diffusion-cpp-browser/types';
import type { Core, HostHelpers } from './core-types';
import { createModelFileSource, createModelFileReadCache, MODEL_FILE_CACHE_BYTES, MODEL_FILE_PAGE_BYTES, type SyncBlobReader } from './gguf-file';
import { validateModelMounts } from './model-mounts';

const pathFields = {
  model: 'model_path', diffusion: 'diffusion_model_path', vae: 'vae_path',
  clipL: 'clip_l_path', clipG: 'clip_g_path', t5: 't5xxl_path', lm: 'llm_path',
} satisfies Record<ModelSlot, string>;

function totalModelBytes({ request }: { request: Request }): number {
  return request.models.reduce((total, model) => total + model.file.size + (model.companions ?? []).reduce((sum, companion) => sum + companion.file.size, 0), 0);
}

function resolveWeightResidency({ request }: { request: Request }) {
  switch (request.weightResidency) {
  case 'auto': return { resolved: 'gpu', paramsBackend: 'WebGPU', eagerLoad: true };
  case 'cpu': return { resolved: 'cpu', paramsBackend: 'cpu', eagerLoad: false };
  case 'hybrid': return { resolved: 'hybrid', paramsBackend: 'diffusion=disk,te=cpu,vae=cpu', eagerLoad: false };
  case 'disk': return { resolved: 'disk', paramsBackend: 'disk', eagerLoad: false };
  case 'runtime': return { resolved: 'runtime', paramsBackend: '', eagerLoad: false };
  default: { const exhaustive: never = request.weightResidency; throw new Error(String(exhaustive)); }
  }
}

/** One context per operation is a Naidan policy, not a limitation of the core. */
export async function runImageGeneration({ core, helpers, request, reader, onProgress, onLog, onDiagnostic }: {
  core: Core, helpers: Pick<HostHelpers, 'mountReadOnlyFile'>, request: Request,
  reader: SyncBlobReader,
  onProgress: ({ event }: { event: Progress }) => void,
  onLog: ({ message, level }: { message: string, level?: number }) => void,
  onDiagnostic?: ReturnType<typeof createImageTrace>['emit'],
}): Promise<{ pixels: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, modelVersion: string }> {
  if (core.pointerBytes !== 4 && core.pointerBytes !== 8) throw new Error('Unsupported native pointer width');
  const allocations: bigint[] = [];
  const mounts: { remove(): void }[] = [];
  const fileReadCache = createModelFileReadCache({ pageBytes: MODEL_FILE_PAGE_BYTES, capacityBytes: MODEL_FILE_CACHE_BYTES });
  const reportFinalReads: (() => void)[] = [];
  const callbacks: (number | bigint)[] = [];
  let context = 0n;
  let images = 0n;
  let imageCount = 0;
  let nativeCall: 'new_sd_ctx' | 'generate_image' | undefined;
  let poisoned = false;
  // The native callback is also used for loading tensors. Do not report those
  // counts as denoising steps or diagnose a load failure as a sampling failure.
  let nativePhase: 'model' | 'sampling' | 'decoding' = 'model';
  function failureStage(): 'model-load' | 'generation' | 'decoding' {
    switch (nativePhase) {
    case 'model': return 'model-load' as const;
    case 'sampling': return 'generation' as const;
    case 'decoding': return 'decoding' as const;
    default: { const exhaustive: never = nativePhase; throw new Error(String(exhaustive)); }
    }
  }
  const keep = ({ pointer }: { pointer: bigint }) => {
    allocations.push(pointer); return pointer;
  };
  const text = ({ value }: { value: string }) => keep({ pointer: core.utf8(value) });
  const emit = ({ ...event }: ImageDiagnosticInput): void => {
    try {
      onDiagnostic?.(event);
    } catch { /* diagnostic only */ }
  };
  const log = ({ message, level }: { message: string, level?: number }) => {
    // The public progress callback is reused for VAE tiles. The pinned upstream
    // emits this exact boundary before decoding; only observe it during the
    // active generation call, never from a user prompt or model-load diagnostic.
    if (nativeCall === 'generate_image' && nativePhase === 'sampling' && /^image\.cpp:\d+\s+- decoding [1-9]\d* latents\s*$/.test(message)) {
      nativePhase = 'decoding';
      notify({ event: { phase: 'decoding', step: 0, steps: 0 } });
      emit({ event: 'start', stage: 'decoding', message: 'Decoding image latents', fields: {} });
    }
    try {
      onLog({ message, level });
    } catch { /* A renderer/listener failure must never unwind native code. */ }
  };
  const notify = ({ event }: { event: Progress }) => {
    try {
      onProgress({ event });
    } catch { /* Notifications do not control native execution. */ }
  };
  try {
    // Callbacks have native pointer-sized arguments on both Wasm widths.
    const logCallback = core.module.addFunction((...args) => {
      try {
        const pointer = args[1];
        if (pointer !== undefined) log({ message: core.readUtf8(BigInt(pointer), 8192) ?? '', level: Number(args[0]) });
      } catch { /* Borrowed diagnostic may no longer be readable after a trap. */ }
    }, 'vipp');
    callbacks.push(logCallback);
    const progressCallback = core.module.addFunction((...args) => {
      const [rawStep, rawSteps] = args;
      const step = Number(rawStep), steps = Number(rawSteps);
      if (Number.isInteger(step) && Number.isInteger(steps) && step >= 0 && steps >= 0) notify({ event: { phase: nativePhase, step, steps } });
    }, 'viifp');
    callbacks.push(progressCallback);
    await core.api.sd_set_log_callback(BigInt(logCallback), 0n);
    await core.api.sd_set_progress_callback(BigInt(progressCallback), 0n);
    core.module.FS.mkdir('/models');
    const paths = new Map<ModelSlot, string>();
    const directories = new Set(['/models']);
    const capabilities = core.module._sdc_model_io_capabilities?.() ?? 0;
    for (const input of request.models) {
      const { slot, file } = input;
      emit({ event: 'start', stage: 'model-header', message: undefined, fields: { slot, bytes: file.size } });
      const plan = await validateModelMounts({ input, reader, capabilities });
      emit({ event: 'file-summary', stage: 'model-header', message: 'File tensor types are source metadata, not proof of CPU/GPU placement', fields: { slot, path: plan.path.slice(0, 512), members: plan.files.length, ...plan.summary } });
      const root = '/models/' + slot + '/';
      for (const entry of plan.files) {
        const path = root + entry.path;
        const parts = path.split('/').slice(1, -1); let parent = '';
        for (const part of parts) {
          parent += '/' + part;
          if (!directories.has(parent)) {
            core.module.FS.mkdir(parent); directories.add(parent);
          }
        }
        const source = createModelFileSource({ file: entry.file, reader, cache: fileReadCache });
        let reads = 0, reportedAt = 0;
        const reportReads = ({ report }: { report: 'progress' | 'final' }) => {
          switch (request.debug) {
          case undefined: case 'off': return;
          case 'on': break;
          default: { const exhaustive: never = request.debug; throw new Error(String(exhaustive)); }
          }
          emit({ event: 'file-read', stage: 'generation', message: 'Cumulative per-file reads; readMs includes blobReadMs. cacheHits counts fully cached nonempty reads.', fields: {
            slot, path: entry.path.slice(0, 512), report, ...source.metrics(), fileBytes: source.size,
            cachePageBytes: MODEL_FILE_PAGE_BYTES, cacheCapacityBytes: MODEL_FILE_CACHE_BYTES, cacheRetainedBytes: fileReadCache.retainedBytes(),
          } });
        };
        reportFinalReads.push(() => reportReads({ report: 'final' }));
        mounts.push(helpers.mountReadOnlyFile(core, path, { size: source.size,
          // eslint-disable-next-line local-rules-named-args/require-named-args -- External filesystem range-reader signature.
          read(destination, offset) {
            const count = source.read(destination, offset);
            reads++;
            if (request.debug === 'on' && (reads === 1 || performance.now() - reportedAt > 1000)) {
              reportedAt = performance.now();
              reportReads({ report: 'progress' });
            }
            return count;
          },
        }, { maxChunkBytes: MODEL_FILE_PAGE_BYTES }));
      }
      paths.set(slot, root + plan.path);
      log({ message: `Mounted ${slot}: ${file.size} bytes; original paths, bounded random access` });
    }
    const ctxParams = keep({ pointer: core.allocRecord('sd_ctx_params_t') });
    await core.api.sd_ctx_params_init(ctxParams);
    for (const [slot, path] of paths) core.setField('sd_ctx_params_t', ctxParams, pathFields[slot], text({ value: path }));
    const residency = resolveWeightResidency({ request });
    const modelBytes = totalModelBytes({ request });
    // Auto keeps supported weights on the compute device for the operation,
    // rather than selecting CPU/disk residency from model-size thresholds.
    // This requests placement; native unsupported tensor/operation fallbacks
    // remain possible and must not be reported as verified GPU execution.
    core.setField('sd_ctx_params_t', ctxParams, 'n_threads', 1);
    core.setField('sd_ctx_params_t', ctxParams, 'enable_mmap', 0);
    core.setField('sd_ctx_params_t', ctxParams, 'disable_prefetch', 0);
    core.setField('sd_ctx_params_t', ctxParams, 'eager_load', Number(residency.eagerLoad));
    core.setField('sd_ctx_params_t', ctxParams, 'auto_fit', 0);
    core.setField('sd_ctx_params_t', ctxParams, 'backend', text({ value: 'WebGPU' }));
    core.setField('sd_ctx_params_t', ctxParams, 'params_backend', residency.paramsBackend ? text({ value: residency.paramsBackend }) : 0n);
    // A null max_vram means no synthetic managed-memory budget in the pinned
    // runtime. WebGPU reports unknown free/total capacity, so real allocations
    // enforce device limits; maxBufferSize is not a total GPU memory budget.
    core.setField('sd_ctx_params_t', ctxParams, 'max_vram', request.gpuBudgetMiB === undefined ? 0n : text({ value: String(request.gpuBudgetMiB / 1024) }));
    log({ message: `Requested WebGPU compute and ${residency.paramsBackend || '(runtime backend)'} weight residency, eager_load=${residency.eagerLoad}, gpuBudgetMiB=${request.gpuBudgetMiB ?? 'unset'}, modelBytes=${modelBytes}` });
    emit({ event: 'native', stage: 'model-load', message: 'Requested weight placement, not proof of every tensor or operation running on GPU', fields: {
      requested: request.weightResidency, resolved: residency.resolved, requestedComputeBackend: 'WebGPU', requestedParamsBackend: residency.paramsBackend || '(runtime backend)',
      eagerLoad: residency.eagerLoad, autoFit: false, gpuBudgetMiB: request.gpuBudgetMiB ?? 'unset', modelBytes,
    } });
    const { prompt, negativePrompt, width, height, steps, guidance, seed, sampler, scheduler,
      distilledGuidance, vaeTiling, vaeTileSize, flashAttention, conditioningCacheSize, modelArguments, ...rest } = request.parameters;
    rest satisfies Record<PropertyKey, never>;
    core.setField('sd_ctx_params_t', ctxParams, 'flash_attn', Number(flashAttention));
    core.setField('sd_ctx_params_t', ctxParams, 'diffusion_flash_attn', Number(flashAttention));
    core.setField('sd_ctx_params_t', ctxParams, 'conditioning_cache_size', conditioningCacheSize);
    core.setField('sd_ctx_params_t', ctxParams, 'model_args', modelArguments ? text({ value: modelArguments }) : 0n);
    notify({ event: { phase: 'model', step: 0, steps: 0 } });
    emit({ event: 'start', stage: 'model-load', message: undefined, fields: { wasmBytes: core.module.HEAPU8?.byteLength ?? 0, gpuBudgetMiB: request.gpuBudgetMiB ?? 'unset' } });
    nativeCall = 'new_sd_ctx';
    context = await core.api.new_sd_ctx(ctxParams);
    nativeCall = undefined;
    emit({ event: 'complete', stage: 'model-load', message: undefined, fields: { wasmBytes: core.module.HEAPU8?.byteLength ?? 0, created: !!context } });
    if (!context) throw new Error('Model initialization failed; see native diagnostics');
    if (await core.api.sd_ctx_supports_image_generation(context) !== 1) throw new Error('This context does not support image generation');
    const modelVersion = core.readUtf8(await core.api.sd_get_model_version_name(context), 256) ?? 'Unknown';
    const params = keep({ pointer: core.allocRecord('sd_img_gen_params_t') });
    await core.api.sd_img_gen_params_init(params);
    core.setField('sd_img_gen_params_t', params, 'prompt', text({ value: prompt }));
    core.setField('sd_img_gen_params_t', params, 'negative_prompt', text({ value: negativePrompt }));
    core.setField('sd_img_gen_params_t', params, 'width', width);
    core.setField('sd_img_gen_params_t', params, 'height', height);
    core.setField('sd_img_gen_params_t', params, 'seed', BigInt(seed));
    core.setField('sd_img_gen_params_t', params, 'batch_count', 1);
    const sample = core.fieldAddress('sd_img_gen_params_t', params, 'sample_params');
    const sampleMethod = await (async () => {
      switch (sampler) {
      case 'auto': return core.api.sd_get_default_sample_method(context);
      case 'euler': case 'euler_a': case 'heun': case 'dpm2': case 'dpm++2m': case 'lcm': return core.api.str_to_sample_method(text({ value: sampler }));
      default: { const exhaustive: never = sampler; throw new Error(String(exhaustive)); }
      }
    })();
    const sampleScheduler = await (async () => {
      switch (scheduler) {
      case 'auto': return core.api.sd_get_default_scheduler(context, sampleMethod);
      case 'discrete': case 'karras': case 'exponential': case 'simple': case 'sgm_uniform': return core.api.str_to_scheduler(text({ value: scheduler }));
      default: { const exhaustive: never = scheduler; throw new Error(String(exhaustive)); }
      }
    })();
    if (sampleMethod < 0 || sampleMethod >= core.constant('SAMPLE_METHOD_COUNT') || sampleScheduler < 0 || sampleScheduler >= core.constant('SCHEDULER_COUNT')) throw new Error('The selected sampling method or scheduler is unavailable');
    core.setField('sd_sample_params_t', sample, 'sample_method', sampleMethod);
    core.setField('sd_sample_params_t', sample, 'scheduler', sampleScheduler);
    core.setField('sd_sample_params_t', sample, 'sample_steps', steps);
    const guidanceParams = core.fieldAddress('sd_sample_params_t', sample, 'guidance');
    core.setField('sd_guidance_params_t', guidanceParams, 'txt_cfg', guidance);
    core.setField('sd_guidance_params_t', guidanceParams, 'distilled_guidance', distilledGuidance);
    const tiling = core.fieldAddress('sd_img_gen_params_t', params, 'vae_tiling_params');
    core.setField('sd_tiling_params_t', tiling, 'enabled', Number(vaeTiling));
    core.setField('sd_tiling_params_t', tiling, 'tile_size_x', vaeTileSize);
    core.setField('sd_tiling_params_t', tiling, 'tile_size_y', vaeTileSize);
    core.setField('sd_tiling_params_t', tiling, 'target_overlap', 0.25);
    const imagesOut = keep({ pointer: core.alloc(core.pointerBytes) });
    const countOut = keep({ pointer: core.alloc(4) });
    core.bytes(imagesOut, core.pointerBytes).fill(0); core.bytes(countOut, 4).fill(0);
    nativePhase = 'sampling';
    notify({ event: { phase: 'sampling', step: 0, steps } });
    emit({ event: 'start', stage: 'generation', message: 'generate_image includes text encoding, denoising and VAE decoding', fields: { width, height, steps, guidance, sampler: sampleMethod, scheduler: sampleScheduler, vaeTiling, flashAttention } });
    nativeCall = 'generate_image';
    const generated = await core.api.generate_image(context, params, imagesOut, countOut);
    nativeCall = undefined;
    emit({ event: 'complete', stage: 'generation', message: undefined, fields: { generated, wasmBytes: core.module.HEAPU8?.byteLength ?? 0 } });
    // Recreate views after every native call: Wasm memory may have grown.
    const pointers = core.bytes(imagesOut, core.pointerBytes);
    const pointerView = new DataView(pointers.buffer, pointers.byteOffset, pointers.byteLength);
    images = core.pointerBytes === 8 ? pointerView.getBigUint64(0, true) : BigInt(pointerView.getUint32(0, true));
    const counts = core.bytes(countOut, 4);
    imageCount = new DataView(counts.buffer, counts.byteOffset, 4).getInt32(0, true);
    if (generated !== 1 || !images || imageCount !== 1) throw new Error('Image generation did not return one complete image');
    const outputWidth = Number(core.getField('sd_image_t', images, 'width'));
    const outputHeight = Number(core.getField('sd_image_t', images, 'height'));
    const channels = Number(core.getField('sd_image_t', images, 'channel'));
    const pixelsPointer = BigInt(core.getField('sd_image_t', images, 'data'));
    if (outputWidth !== width || outputHeight !== height || ![3, 4].includes(channels) || !pixelsPointer) throw new Error('Invalid generated image dimensions/channels');
    const source = core.bytes(pixelsPointer, width * height * channels);
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let from = 0, to = 0; from < source.length; from += channels, to += 4) {
      pixels[to] = source[from]!; pixels[to + 1] = source[from + 1]!; pixels[to + 2] = source[from + 2]!;
      pixels[to + 3] = channels === 4 ? source[from + 3]! : 255;
    }
    return { pixels, width, height, modelVersion };
  } catch (error) {
    // A trap does not unwind the C++ graph guard. A rejection while a native
    // operation is pending is equally uncertain. Do not re-enter this instance
    // to free its context, allocations, callbacks or filesystem after either.
    // The single-use client always terminates the Worker, even on failure.
    const details = imageErrorContext({ error });
    poisoned = nativeCall !== undefined || details.errorType === 'wasm-trap';
    if (poisoned) emit({ event: 'failed', stage: failureStage(),
      message: error instanceof Error ? error.message : String(error),
      fields: { ...details, nativeCall: nativeCall ?? 'native-boundary', wasmBytes: core.module.HEAPU8?.byteLength ?? 0, workerTerminationRequired: true },
    });
    throw error;
  } finally {
    // Record the primary failure above BEFORE teardown; cleanup never replaces
    // its original stack with a graph_active_ assertion or an unreachable trap.
    try {
      emit({ event: 'start', stage: 'cleanup', message: undefined, fields: { nativeCleanup: poisoned ? 'skipped' : 'run' } });
      if (poisoned) {
        log({ message: 'Native cleanup skipped after an interrupted native call; Worker termination will release this instance.' });
      } else {
        if (images && imageCount > 0 && imageCount <= 64) await core.api.free_sd_images(images, imageCount);
        if (context) await core.api.free_sd_ctx(context);
        await core.api.sd_set_log_callback(0n, 0n);
        await core.api.sd_set_progress_callback(0n, 0n);
        for (const pointer of callbacks) core.module.removeFunction(pointer);
        for (const pointer of allocations.reverse()) core.free(pointer);
        // Mounted parameter sources must outlive the complete native context.
        for (const mounted of mounts.reverse()) mounted.remove();
        emit({ event: 'complete', stage: 'cleanup', message: undefined, fields: {} });
      }
    } catch (error) {
      emit({ event: 'failed', stage: 'cleanup', message: 'Native cleanup failed; Worker termination will release this instance.', fields: imageErrorContext({ error }) });
      log({ message: `Native teardown failed; Worker will be terminated: ${String(error)}` });
    } finally {
      // These are JS-only counters/cache disposal, not callbacks into Wasm.
      for (const report of reportFinalReads) report();
      fileReadCache.clear();
    }
  }
}
export const TEST_ONLY = {
};
