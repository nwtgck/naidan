import { imageErrorContext, type ImageDiagnosticInput, type createImageTrace } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import { previewControlSchema, type PreviewControl, type Request, type Progress, type ModelSlot } from '@/features/stable-diffusion-cpp-browser/types';
import type { Core, HostHelpers } from './core-types';
import { createModelFileSource, createModelFileReadCache, MODEL_FILE_CACHE_BYTES, MODEL_FILE_PAGE_BYTES, type SyncBlobReader } from './gguf-file';
import { validateModelMounts } from './model-mounts';
import { copyNativeImage, imagePixelStatistics, type ImagePixels } from './image-output';
import { createNativePreviewControl } from './preview-control';

type Emit = ReturnType<typeof createImageTrace>['emit'];
export type PreviewPixels = { image: ImagePixels, step: number, steps: number, revision: number, maxEdge: number, mode: 'projection' | 'vae' };
type Run = { request: Request, onProgress: ({ event }: { event: Progress }) => void,
  onLog: ({ message, level }: { message: string, level?: number }) => void,
  onDiagnostic?: Emit, onPreview?: ({ capture }: { capture: PreviewPixels }) => void };
const pathFields = { model: 'model_path', diffusion: 'diffusion_model_path', vae: 'vae_path', clipL: 'clip_l_path', clipG: 'clip_g_path', t5: 't5xxl_path', lm: 'llm_path' } satisfies Record<ModelSlot, string>;
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
export function effectiveVaeTile({ modelVersion, requested, policy, enabled }: {
  modelVersion: string, requested: number, policy: Request['parameters']['qwenVaePolicy'], enabled: boolean,
}): number {
  if (enabled && policy === 'bounded' && modelVersion.trim() === 'Qwen Image 2.1') return Math.min(requested, 16);
  return requested;
}

/** One immutable model composition per worker. Only per-image allocations are
 * freed between successful runs; the client retires the worker on composition
 * changes, cancellation or failure. A native trap is never followed by a free. */
export function createImageGenerationSession({ core, helpers, reader }: {
  core: Core, helpers: Pick<HostHelpers, 'mountReadOnlyFile'>, reader: SyncBlobReader,
}) {
  if (core.pointerBytes !== 4 && core.pointerBytes !== 8) throw new Error('Unsupported native pointer width');
  const allocations: bigint[] = [], callbacks: (number | bigint)[] = [], mounts: { remove(): void }[] = [];
  const fileReadCache = createModelFileReadCache({ pageBytes: MODEL_FILE_PAGE_BYTES, capacityBytes: MODEL_FILE_CACHE_BYTES });
  const reportFinalReads: (() => void)[] = [];
  let context = 0n, modelVersion = 'Unknown', sessionId: string | undefined;
  let poisoned = false, closed = false, failed = false;
  let nativeCall: 'new_sd_ctx' | 'generate_image' | undefined;
  let nativePhase: 'model' | 'sampling' | 'decoding' = 'model';
  let previewDecoding = false;
  let active: (Run & { latest: PreviewControl, preview?: ReturnType<typeof createNativePreviewControl>, capturedStep: number }) | undefined;
  const keep = ({ pointer }: { pointer: bigint }) => {
    allocations.push(pointer); return pointer;
  };
  const text = ({ value }: { value: string }) => keep({ pointer: core.utf8(value) });
  const emit = ({ ...event }: ImageDiagnosticInput): void => {
    try {
      active?.onDiagnostic?.(event);
    } catch { /* observational */ }
  };
  const notify = ({ event }: { event: Progress }): void => {
    try {
      active?.onProgress({ event });
    } catch { /* observational */ }
  };
  const log = ({ message, level }: { message: string, level?: number }): void => {
    // Full VAE previews reuse the same native tile-progress callback as final
    // decoding. Observe only pinned native markers; never show tiles as steps.
    if (nativeCall === 'generate_image' && nativePhase === 'sampling' && active?.request.preview.mode === 'vae') {
      if (/^vae\.hpp:\d+\s+- VAE Tile size:/.test(message)) previewDecoding = true;
      if (/^vae\.hpp:\d+\s+- computing vae decode graph completed,/.test(message) || /^diffusion_engine\.cpp:\d+\s+- preview decode failed/.test(message)) previewDecoding = false;
    }
    if (nativeCall === 'generate_image' && nativePhase === 'sampling' && /^image\.cpp:\d+\s+- decoding [1-9]\d* latents\s*$/.test(message)) {
      nativePhase = 'decoding'; previewDecoding = false; notify({ event: { phase: 'decoding', step: 0, steps: 0 } });
      emit({ event: 'start', stage: 'decoding', message: 'Decoding image latents', fields: {} });
    }
    try {
      active?.onLog({ message, level });
    } catch { /* observational */ }
  };
  function failureStage(): 'model-load' | 'generation' | 'decoding' {
    switch (nativePhase) {
    case 'model': return 'model-load';
    case 'sampling': return 'generation';
    case 'decoding': return 'decoding';
    default: { const exhaustive: never = nativePhase; throw new Error(String(exhaustive)); }
    }
  }
  async function installCallbacks(): Promise<void> {
    if (callbacks.length) return;
    callbacks.push(core.module.addFunction((...args) => {
      try {
        if (args[1] !== undefined) log({ message: core.readUtf8(BigInt(args[1]), 8192) ?? '', level: Number(args[0]) });
      } catch { /* borrowed diagnostics */ }
    }, 'vipp'));
    callbacks.push(core.module.addFunction((...args) => {
      if (previewDecoding) return;
      const step = Number(args[0]), steps = Number(args[1]);
      if (Number.isInteger(step) && Number.isInteger(steps) && step >= 0 && steps >= 0) {
        if (nativePhase === 'sampling' && steps === active?.request.parameters.steps) active.preview?.observeStep({ step });
        notify({ event: { phase: nativePhase, step, steps } });
      }
    }, 'viifp'));
    callbacks.push(core.module.addFunction((...args) => {
      previewDecoding = false;
      const operation = active, snapshot = operation?.preview?.snapshot();
      if (!operation || !snapshot?.settings.enabled || !operation.onPreview) return;
      const rawStep = Number(args[0]), step = Math.abs(rawStep), count = Number(args[1]), pointer = BigInt(args[2] ?? 0);
      // Negative intermediate evaluations are not completed user-visible steps.
      if (!Number.isInteger(step) || step < snapshot.settings.startStep || step > operation.request.parameters.steps || (rawStep < 0 && step !== operation.request.parameters.steps) || step <= operation.capturedStep || count !== 1 || !pointer || Number(args[3]) !== 0) return;
      try {
        const image = copyNativeImage({ core, pointer });
        operation.capturedStep = step;
        operation.onPreview({ capture: { image, step, steps: operation.request.parameters.steps, revision: snapshot.revision, maxEdge: snapshot.settings.maxEdge, mode: snapshot.settings.mode } });
      } catch (error) {
        emit({ event: 'native', stage: 'generation', message: 'Preview frame could not be copied; final generation continues', fields: { ...imageErrorContext({ error }) } });
      }
    }, 'viipip'));
    await core.api.sd_set_log_callback(BigInt(callbacks[0]!), 0n);
    await core.api.sd_set_progress_callback(BigInt(callbacks[1]!), 0n);
  }
  async function initialize({ request }: { request: Request }): Promise<void> {
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
          const debug = active?.request.debug;
          switch (debug) {
          case undefined: case 'off': return;
          case 'on': break;
          default: { const exhaustive: never = debug; throw new Error(String(exhaustive)); }
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
            if (active?.request.debug === 'on' && (reads === 1 || performance.now() - reportedAt > 1000)) {
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
    const { flashAttention, conditioningCacheSize, modelArguments } = request.parameters;
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
    modelVersion = core.readUtf8(await core.api.sd_get_model_version_name(context), 256) ?? 'Unknown';
  }
  async function generate({ ...run }: Run): Promise<ImagePixels & { modelVersion: string, uniformOutput: boolean }> {
    if (closed || failed || poisoned || active) throw new Error('Image session is busy, failed or released');
    if (sessionId !== undefined && sessionId !== run.request.sessionId) throw new Error('Model composition changed; replace the image worker');
    sessionId ??= run.request.sessionId;
    const { request } = run;
    previewDecoding = false;
    active = { ...run, latest: { type: 'naidan-image-preview-control-v1', runId: request.runId, revision: 0, settings: { ...request.preview } }, capturedStep: 0 };
    const runAllocations: bigint[] = [];
    const keep = ({ pointer }: { pointer: bigint }) => {
      runAllocations.push(pointer); return pointer;
    };
    const text = ({ value }: { value: string }) => keep({ pointer: core.utf8(value) });
    let images = 0n, imageCount = 0;
    let result: (ImagePixels & { modelVersion: string, uniformOutput: boolean }) | undefined;
    let failure: { error: unknown } | undefined;
    try {
      await installCallbacks();
      active.preview = createNativePreviewControl({ core, callback: callbacks[2]!, runId: request.runId, initial: request.preview });
      if (active.latest.revision) active.preview.update({ control: active.latest });
      if (!context) await initialize({ request });
      else emit({ event: 'native', stage: 'model-load', message: 'Reusing loaded model context and weights', fields: { reused: true } });
      const { prompt, negativePrompt, width, height, steps, guidance, seed, sampler, scheduler,
        distilledGuidance, vaeTiling, vaeTileSize, qwenVaePolicy, flashAttention } = request.parameters;
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
      const effectiveTile = effectiveVaeTile({ modelVersion, requested: vaeTileSize, policy: qwenVaePolicy, enabled: vaeTiling });
      core.setField('sd_tiling_params_t', tiling, 'tile_size_x', effectiveTile);
      core.setField('sd_tiling_params_t', tiling, 'tile_size_y', effectiveTile);
      if (effectiveTile !== vaeTileSize) emit({ event: 'native', stage: 'decoding', message: 'Bounded Qwen VAE tiles; output dimensions and sampling unchanged', fields: { requestedTile: vaeTileSize, effectiveTile, width, height } });
      core.setField('sd_tiling_params_t', tiling, 'target_overlap', 0.25);
      const imagesOut = keep({ pointer: core.alloc(core.pointerBytes) });
      const countOut = keep({ pointer: core.alloc(4) });
      core.bytes(imagesOut, core.pointerBytes).fill(0); core.bytes(countOut, 4).fill(0);
      nativePhase = 'sampling';
      notify({ event: { phase: 'sampling', step: 0, steps } });
      emit({ event: 'start', stage: 'generation', message: 'generate_image includes text encoding, denoising and VAE decoding', fields: { width, height, steps, guidance, sampler: sampleMethod, scheduler: sampleScheduler, vaeTiling, flashAttention } });
      await active!.preview!.start();
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
      const output = copyNativeImage({ core, pointer: images });
      if (output.width !== width || output.height !== height) throw new Error('Invalid generated image dimensions/channels');
      const stats = imagePixelStatistics(output);
      emit({ event: 'native', stage: 'encoding', message: 'Native pixels before canvas/PNG encoding (uniform colour is not proof of failure)', fields: stats });
      result = { ...output, modelVersion, uniformOutput: stats.uniformOutput };
    } catch (error) {
      failure = { error }; failed = true;
      const details = imageErrorContext({ error });
      poisoned ||= nativeCall !== undefined || details.errorType === 'wasm-trap';
      if (poisoned) emit({ event: 'failed', stage: failureStage(), message: error instanceof Error ? error.message : String(error), fields: { ...details, nativeCall: nativeCall ?? 'native-boundary', wasmBytes: core.module.HEAPU8?.byteLength ?? 0, workerTerminationRequired: true } });
    }
    active.preview?.close();
    try {
      if (!poisoned) {
        if (images && imageCount > 0 && imageCount <= 64) await core.api.free_sd_images(images, imageCount);
        await core.api.sd_set_preview_callback(0n, core.constant('PREVIEW_NONE'), 1, 0, 0, 0n);
        for (const pointer of runAllocations.reverse()) core.free(pointer);
      }
    } catch (error) {
      poisoned = true; failed = true;
      emit({ event: 'failed', stage: 'cleanup', message: 'Per-image cleanup failed; Worker termination required', fields: imageErrorContext({ error }) });
      failure ??= { error };
    } finally {
      for (const report of reportFinalReads) {
        try {
          report();
        } catch { /* metrics cannot replace the primary error */ }
      }
      active = undefined;
    }
    if (failure) throw failure.error;
    if (!result) throw new Error('Image operation produced no result');
    return result;
  }

  function updatePreview({ control }: { control: PreviewControl }): boolean {
    const parsed = previewControlSchema.safeParse(control);
    if (!parsed.success || !active || poisoned || closed || control.runId !== active.request.runId || control.revision <= active.latest.revision || control.settings.mode !== active.request.preview.mode) return false;
    if (active.preview && !active.preview.update({ control })) return false;
    active.latest = control;
    return true;
  }
  async function close({ onDiagnostic, onLog }: { onDiagnostic?: Emit, onLog?: Run['onLog'] } = {}): Promise<void> {
    if (closed) return;
    if (active) throw new Error('Do not enter native cleanup during generation');
    closed = true;
    const report = ({ ...event }: ImageDiagnosticInput) => {
      try {
        onDiagnostic?.(event);
      } catch { /* observational */ }
    };
    report({ event: 'start', stage: 'cleanup', message: undefined, fields: { nativeCleanup: poisoned ? 'skipped' : 'run' } });
    try {
      if (poisoned) {
        try {
          onLog?.({ message: 'Native cleanup skipped after an interrupted native call; Worker termination will release this instance.' });
        } catch { /* observational */ }
        return;
      }
      if (context) await core.api.free_sd_ctx(context);
      await core.api.sd_set_log_callback(0n, 0n);
      await core.api.sd_set_progress_callback(0n, 0n);
      for (const pointer of callbacks) core.module.removeFunction(pointer);
      for (const pointer of allocations.reverse()) core.free(pointer);
      for (const mount of mounts.reverse()) mount.remove();
      report({ event: 'complete', stage: 'cleanup', message: undefined, fields: {} });
    } catch (error) {
      poisoned = true;
      report({ event: 'failed', stage: 'cleanup', message: 'Native cleanup failed; Worker termination required', fields: imageErrorContext({ error }) });
      throw error;
    } finally {
      fileReadCache.clear();
    }
  }
  return { generate, updatePreview, close };
}

/** One-shot convenience uses the same ownership implementation as retained runs. */
export async function runImageGeneration({ core, helpers, reader, ...run }: Run & {
  core: Core, helpers: Pick<HostHelpers, 'mountReadOnlyFile'>, reader: SyncBlobReader,
}) {
  const session = createImageGenerationSession({ core, helpers, reader });
  let failure: { error: unknown } | undefined;
  let output: Awaited<ReturnType<typeof session.generate>> | undefined;
  try {
    output = await session.generate(run);
  } catch (error) {
    failure = { error };
  }
  try {
    await session.close({ onDiagnostic: run.onDiagnostic, onLog: run.onLog });
  } catch (error) {
    failure ??= { error };
  }
  if (failure) throw failure.error;
  if (!output) throw new Error('Image operation produced no result');
  return output;
}
export const TEST_ONLY = {
};
