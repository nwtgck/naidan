import type { ImageGenerationSampling } from '@/01-models/image-generation-history';
import type { NativePerformanceSignal } from './run-performance';
import { imageErrorContext, type ImageDiagnosticInput, type createImageTrace } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import { cancelControlSchema, previewControlSchema, type CancelControl, type CancelledResult, type PreviewControl, type Request, type Progress, type ModelSlot } from '@/features/stable-diffusion-cpp-browser/types';
import type { Core, HostHelpers } from './core-types';
import { createModelFileSource, createModelFileReadCache, MODEL_FILE_CACHE_BYTES, MODEL_FILE_PAGE_BYTES, type SyncBlobReader } from './gguf-file';
import { validateModelMounts } from './model-mounts';
import { assertBf16ConversionFitsMemory } from './bf16-conversion-memory';
import { copyNativeImage, imagePixelStatistics, type ImagePixels } from './image-output';
import { createNativePreviewControl } from './preview-control';
import { writeImageInputs } from './image-input';
import { inspectImageEngine } from './engine-state';
import type { ImageEngineInspection } from '@/features/stable-diffusion-cpp-browser/engine-state';

const cancelledRun = Symbol('cancelled image run after safe native return');
type Emit = ReturnType<typeof createImageTrace>['emit'];
export type PreviewPixels = { image: ImagePixels, step: number, steps: number, revision: number, maxEdge: number, mode: 'projection' | 'vae' };
type Run = { request: Request, onProgress: ({ event }: { event: Progress }) => void,
  onLog: ({ message, level }: { message: string, level?: number }) => void,
  onDiagnostic?: Emit, onPerformance?: ({ signal }: { signal: NativePerformanceSignal }) => void, onPreview?: ({ capture }: { capture: PreviewPixels }) => void };
const pathFields = { model: 'model_path', diffusion: 'diffusion_model_path', vae: 'vae_path', clipL: 'clip_l_path', clipG: 'clip_g_path', t5: 't5xxl_path', lm: 'llm_path' } satisfies Record<ModelSlot, string>;

function totalModelBytes({ request }: { request: Request }): number {
  return request.models.reduce((total, model) => total + model.file.size + (model.companions ?? []).reduce((sum, companion) => sum + companion.file.size, 0), 0)
    + request.loras.reduce((total, lora) => total + lora.file.size, 0);
}

function resolveWeightResidency({ request }: { request: Request }) {
  switch (request.weightResidency) {
  case 'auto': return { resolved: 'gpu', paramsBackend: 'WebGPU', eagerLoad: true };
  case 'cpu': return { resolved: 'cpu', paramsBackend: 'cpu', eagerLoad: false };
  case 'hybrid': return { resolved: 'hybrid', paramsBackend: 'diffusion=disk,te=cpu,vae=cpu', eagerLoad: false };
  case 'disk': return { resolved: 'disk', paramsBackend: 'disk', eagerLoad: false };
  case 'runtime': return { resolved: 'runtime', paramsBackend: '', eagerLoad: false };
  default: {
    const exhaustive: never = request.weightResidency;
    throw new Error(String(exhaustive));
  }
  }
}

export function effectiveVaeTile({ modelVersion, requested, policy, enabled }: {
  modelVersion: string, requested: number, policy: Request['parameters']['qwenVaePolicy'], enabled: boolean,
}): number {
  if (enabled && policy === 'bounded' && modelVersion.trim() === 'Qwen Image 2.1') {
    return Math.min(requested, 16);
  }
  return requested;
}

/** The editor and saved requests keep latent-pixel tiles; native fields use image pixels. */
export function nativeVaeTile({ modelVersion, requested, policy, enabled }: {
  modelVersion: string, requested: number, policy: Request['parameters']['qwenVaePolicy'], enabled: boolean,
}): number {
  if (!enabled) {
    return 0;
  }
  const tile = effectiveVaeTile({ modelVersion, requested, policy, enabled });
  switch (modelVersion.trim()) {
  case 'Qwen Image 2.1': case 'Flux.2': case 'Flux.2 klein': case 'SeFi-Image': case 'Ernie Image': case 'MiniMax-H3-Image': case 'P-H3-Image': return tile * 16;
  case 'Z-Image': case 'Anima': case 'Krea2':
  case 'Qwen Image': case 'Qwen Image Layered': case 'Flux': case 'Flux Fill': case 'Flux Control': case 'Flex.2': case 'Chroma': case 'Ovis Image':
  case 'SD 1.x': case 'SD 1.x Inpaint': case 'Instruct-Pix2Pix': case 'SD 1.x Tiny UNet':
  case 'SD 2.x': case 'SD 2.x Inpaint': case 'SD 2.x Tiny UNet': case 'SDXS (512-DS)': case 'SDXS (09)':
  case 'SDXL': case 'SDXL Inpaint': case 'SDXL Instruct-Pix2Pix': case 'SDXL (Vega)': case 'SDXL (SSD1B)': return tile * 8;
  default: throw new Error('The VAE tile scale for this model is unknown. Disable VAE tiling before generating.');
  }
}

/** One immutable model composition per worker. Only per-image allocations are
 * freed between successful runs; the client retires the worker on composition
 * changes, forced cancellation or failure. Graceful cancellation waits for native cleanup. A native trap is never followed by a free. */
export function createImageGenerationSession({ core, helpers, reader }: {
  core: Core, helpers: Pick<HostHelpers, 'mountReadOnlyFile'>, reader: SyncBlobReader,
}) {
  if (core.pointerBytes !== 4 && core.pointerBytes !== 8) {
    throw new Error('Unsupported native pointer width');
  }
  const allocations: bigint[] = [], callbacks: (number | bigint)[] = [], mounts: { remove(): void }[] = [];
  const fileReadCache = createModelFileReadCache({ pageBytes: MODEL_FILE_PAGE_BYTES, capacityBytes: MODEL_FILE_CACHE_BYTES });
  const reportFinalReads: (() => void)[] = [];
  const loraPaths: string[] = [];
  let context = 0n, modelVersion = 'Unknown', sessionId: string | undefined;
  let poisoned = false, closed = false, failed = false;
  let inspection: Promise<ImageEngineInspection> | undefined;
  let artifact: Request['artifact'] | undefined;
  let nativeCall: 'sd_browser_bf16_retention_version' | 'new_sd_ctx' | 'generate_image' | 'sd_sample_method_name' | 'sd_scheduler_name' | undefined;
  let nativePhase: 'model' | 'sampling' | 'decoding' = 'model';
  let active: (Run & { latest: PreviewControl, preview?: ReturnType<typeof createNativePreviewControl>, capturedStep: number, samplingSteps: number | undefined, samplingPass: number | undefined, cancelRequested: boolean }) | undefined;
  const keep = ({ pointer }: { pointer: bigint }) => {
    allocations.push(pointer);
    return pointer;
  };
  const text = ({ value }: { value: string }) => keep({ pointer: core.utf8(value) });
  async function samplingName({ functionName, id }: { functionName: 'sd_sample_method_name' | 'sd_scheduler_name', id: number }): Promise<{ name?: string }> {
    const getter = core.api[functionName];
    if (!getter) {
      return {};
    }
    nativeCall = functionName;
    const pointer = await getter(id);
    // Names are borrowed static strings. Copy a bounded value now; never free
    // their pointer or map an unlisted native method into an editor enum.
    const name = pointer === 0n ? undefined : core.readUtf8(pointer, 129) ?? undefined;
    nativeCall = undefined;
    return name && name.length <= 128 ? { name } : {};
  }

  const emit: Emit = ({ ...event }): void => {
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
    try {
      active?.onLog({ message, level });
    } catch { /* observational */ }
  };
  function failureStage(): 'model-load' | 'generation' | 'decoding' {
    switch (nativePhase) {
    case 'model': return 'model-load';
    case 'sampling': return 'generation';
    case 'decoding': return 'decoding';
    default: {
      const exhaustive: never = nativePhase;
      throw new Error(String(exhaustive));
    }
    }
  }
  async function installCallbacks(): Promise<void> {
    if (callbacks.length) {
      return;
    }
    callbacks.push(core.module.addFunction((...args) => {
      try {
        if (args[1] !== undefined) {
          log({ message: core.readUtf8(BigInt(args[1]), 8192) ?? '', level: Number(args[0]) });
        }
      } catch { /* borrowed diagnostics */ }
    }, 'vipp'));
    callbacks.push(core.module.addFunction((...args) => {
      // Sampling has context-local events. Legacy VAE tiles must not become denoising steps.
      if (nativeCall === 'generate_image' && nativePhase === 'sampling') {
        return;
      }
      const step = Number(args[0]), steps = Number(args[1]);
      if (Number.isInteger(step) && Number.isInteger(steps) && step >= 0 && steps >= 0) {
        notify({ event: { phase: nativePhase, step, steps } });
      }
    }, 'viifp'));
    callbacks.push(core.module.addFunction((...args) => {
      const operation = active, snapshot = operation?.preview?.snapshot();
      if (!operation || operation.samplingSteps === undefined || operation.cancelRequested || !snapshot?.settings.enabled || !operation.onPreview) {
        return;
      }
      const rawStep = Number(args[0]), step = Math.abs(rawStep), count = Number(args[1]), pointer = BigInt(args[2] ?? 0);
      // Negative intermediate evaluations are not completed user-visible steps.
      if (!Number.isInteger(step) || step < snapshot.settings.startStep || step > operation.samplingSteps || (rawStep < 0 && step !== operation.samplingSteps) || step <= operation.capturedStep || count !== 1 || !pointer || Number(args[3]) !== 0) {
        return;
      }
      try {
        const image = copyNativeImage({ core, pointer });
        operation.capturedStep = step;
        operation.onPreview({ capture: { image, step, steps: operation.samplingSteps, revision: snapshot.revision, maxEdge: snapshot.settings.maxEdge, mode: snapshot.settings.mode } });
      } catch (error) {
        emit({ event: 'native', stage: 'generation', message: 'Preview frame could not be copied; final generation continues', fields: { ...imageErrorContext({ error }) } });
      }
    }, 'viipip'));
    callbacks.push(core.module.addFunction((...args) => {
      const operation = active;
      if (!operation || operation.cancelRequested || nativeCall !== 'generate_image') {
        return;
      }
      try {
        const pointer = BigInt(args[0] ?? 0);
        if (!pointer) {
          return;
        }
        const stage = core.readUtf8(BigInt(core.getField('sd_generation_progress_t', pointer, 'stage')), 128);
        if (stage === 'vae_decode') {
          if (operation.samplingPass !== undefined && nativePhase !== 'decoding') {
            nativePhase = 'decoding';
            notify({ event: { phase: 'decoding', step: 0, steps: 0 } });
            emit({ event: 'start', stage: 'decoding', message: 'Decoding image latents', fields: {} });
          }
          return;
        }
        if (stage !== 'sampling' || nativePhase !== 'sampling'
          || core.readUtf8(BigInt(core.getField('sd_generation_progress_t', pointer, 'unit')), 32) !== 'steps') {
          return;
        }
        const completed = core.getField('sd_generation_progress_t', pointer, 'completed');
        const total = core.getField('sd_generation_progress_t', pointer, 'total');
        const pass = Number(core.getField('sd_generation_progress_t', pointer, 'sample_pass'));
        if (typeof completed !== 'bigint' || typeof total !== 'bigint' || completed < 0n || total < 1n
          || completed > total || total > BigInt(operation.request.parameters.steps)
          || !Number.isSafeInteger(pass) || pass < 1) {
          return;
        }
        if (operation.samplingPass === undefined) {
          if (completed !== 0n) {
            return;
          }
          operation.samplingPass = pass;
          operation.samplingSteps = Number(total);
        }
        if (operation.samplingPass !== pass || operation.samplingSteps !== Number(total)) {
          return;
        }
        const step = Number(completed), steps = Number(total);
        try {
          operation.onPerformance?.({ signal: { kind: 'sampling-progress', step, steps } });
        } catch { /* measurement only */ }
        operation.preview?.observeStep({ step });
        notify({ event: { phase: 'sampling', step, steps } });
      } catch { /* borrowed progress must never throw through native code */ }
    }, 'vpp'));
    await core.api.sd_set_log_callback(BigInt(callbacks[0]!), 0n);
    await core.api.sd_set_progress_callback(BigInt(callbacks[1]!), 0n);
  }
  async function initialize({ request }: { request: Request }): Promise<void> {
    let bf16RetentionVersion = 0;
    if (request.artifact.bf16WeightRetention === true) {
      const getter = core.api.sd_browser_bf16_retention_version;
      if (typeof getter !== 'function') {
        throw new Error('The installed image runtime advertises BF16 weight retention but its native version API is missing. Update the image runtime before generating.');
      }
      try {
        nativeCall = 'sd_browser_bf16_retention_version';
        bf16RetentionVersion = await getter();
        nativeCall = undefined;
      } catch (cause) {
        throw new Error('The installed image runtime could not verify its native BF16 weight retention contract. Update the image runtime before generating.', { cause });
      }
      if (!Number.isSafeInteger(bf16RetentionVersion) || bf16RetentionVersion < 1) {
        throw new Error('The installed image runtime does not implement the advertised BF16 weight retention contract. Update the image runtime before generating.');
      }
    }
    if (request.parameters.bf16WeightType === 'bf16' && bf16RetentionVersion < 1) {
      throw new Error('The installed image runtime does not support retaining BF16 weights. Update the image runtime or explicitly choose F32 or F16 before generating.');
    }
    try {
      // Generated record metadata is checked before mounting model files. Older
      // artifacts must not silently ignore the selected weight conversion.
      core.fieldAddress('sd_ctx_params_t', 0n, 'webgpu_bf16_type');
    } catch (cause) {
      throw new Error('The installed image runtime does not support BF16 weight conversion. Update the image runtime before generating.', { cause });
    }
    try {
      for (const field of ['flash_attn_mode', 'conv_direct_mode', 'batched_cfg']) {
        core.fieldAddress('sd_ctx_params_t', 0n, field);
      }
      for (const field of ['items', 'count']) {
        core.fieldAddress('sd_image_generation_result_t', 0n, field);
      }
      core.fieldAddress('sd_image_result_t', 0n, 'image');
      for (const field of ['tile_size_w', 'tile_size_h']) {
        core.fieldAddress('sd_tiling_params_t', 0n, field);
      }
      for (const field of ['stage', 'unit', 'completed', 'total', 'sample_pass']) {
        core.fieldAddress('sd_generation_progress_t', 0n, field);
      }
      if (typeof core.api.free_sd_image_generation_result !== 'function'
        || typeof core.api.sd_set_generation_progress_callback !== 'function') {
        throw new Error('Missing image result ownership or generation progress API');
      }
    } catch (cause) {
      throw new Error('The installed image runtime does not support the required image API. Update the image runtime before generating.', { cause });
    }
    if (request.loras.length) {
      try {
        core.fieldAddress('sd_img_gen_params_t', 0n, 'loras');
        core.fieldAddress('sd_img_gen_params_t', 0n, 'lora_count');
        for (const field of ['is_high_noise', 'multiplier', 'path']) {
          core.fieldAddress('sd_lora_t', 0n, field);
        }
      } catch (cause) {
        throw new Error('The installed image runtime does not support LoRA adapters. Update the image runtime before generating.', { cause });
      }
    }
    core.module.FS.mkdir('/models');
    const paths = new Map<ModelSlot, string>();
    const directories = new Set(['/models']);
    const capabilities = core.module._sdc_model_io_capabilities?.() ?? 0;
    const h3Composition: { primary: boolean, embedding: Awaited<ReturnType<typeof validateModelMounts>>['minimaxH3BF16Embedding'] } = { primary: false, embedding: undefined };
    async function mount({ slot, input }: { slot: string, input: Parameters<typeof validateModelMounts>[0]['input'] }): Promise<string> {
      const { file } = input;
      emit({ event: 'start', stage: 'model-header', message: undefined, fields: { slot, bytes: file.size } });
      const plan = await validateModelMounts({ input, reader, capabilities });
      if (slot === 'diffusion') {
        h3Composition.primary = plan.minimaxH3Image;
      }
      if (slot === 'lm') {
        h3Composition.embedding = plan.minimaxH3BF16Embedding;
      }
      emit({ event: 'file-summary', stage: 'model-header', message: 'File tensor types are source metadata, not proof of CPU/GPU placement', fields: { slot, path: plan.relativePath.slice(0, 512), members: plan.files.length, ...plan.summary } });
      const root = '/models/' + slot + '/';
      for (const entry of plan.files) {
        const path = root + entry.relativePath;
        const parts = path.split('/').slice(1, -1);
        let parent = '';
        for (const part of parts) {
          parent += '/' + part;
          if (!directories.has(parent)) {
            core.module.FS.mkdir(parent);
            directories.add(parent);
          }
        }
        const source = createModelFileSource({ file: entry.file, reader, cache: fileReadCache });
        let reads = 0, reportedAt = 0;
        const reportReads = ({ report }: { report: 'progress' | 'final' }) => {
          const debug = active?.request.debug;
          switch (debug) {
          case undefined: case 'off': return;
          case 'on': break;
          default: {
            const exhaustive: never = debug;
            throw new Error(String(exhaustive));
          }
          }
          emit({
            event: 'file-read',
            stage: 'generation',
            message: 'Cumulative per-file reads; readMs includes blobReadMs. cacheHits counts fully cached nonempty reads.',
            fields: {
              slot,
              path: entry.relativePath.slice(0, 512),
              report,
              ...source.metrics(),
              fileBytes: source.size,
              cachePageBytes: MODEL_FILE_PAGE_BYTES,
              cacheCapacityBytes: MODEL_FILE_CACHE_BYTES,
              cacheRetainedBytes: fileReadCache.retainedBytes(),
            },
          });
        };
        let previousRun = source.metrics();
        reportFinalReads.push(() => {
          reportReads({ report: 'final' });
          const current = source.metrics();
          const debug = active?.request.debug;
          switch (debug) {
          case 'on': emit({
            event: 'file-read',
            stage: 'generation',
            message: 'Per-run file reads (not lifetime totals)',
            fields: {
              metric: 'file-read-run',
              perfVersion: 1,
              slot,
              path: entry.relativePath.slice(0, 512),
              reads: current.reads - previousRun.reads,
              bytes: current.bytes - previousRun.bytes,
              readMs: current.readMs - previousRun.readMs,
              blobReads: current.blobReads - previousRun.blobReads,
              blobBytes: current.blobBytes - previousRun.blobBytes,
              blobReadMs: current.blobReadMs - previousRun.blobReadMs,
              cacheHits: current.cacheHits - previousRun.cacheHits,
              cacheHitBytes: current.cacheHitBytes - previousRun.cacheHitBytes,
            },
          });
            break;
          case 'off': case undefined: break;
          default: {
            const exhaustive: never = debug;
            throw new Error(String(exhaustive));
          }
          }
          previousRun = current;
        });
        mounts.push(helpers.mountReadOnlyFile(core, path, {
          size: source.size,
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
      log({ message: `Mounted ${slot}: ${file.size} bytes; original paths, bounded random access` });
      return root + plan.relativePath;
    }
    for (const input of request.models) {
      paths.set(input.slot, await mount({ slot: input.slot, input }));
    }
    for (const [index, input] of request.loras.entries()) {
      loraPaths.push(await mount({ slot: `lora-${index}`, input }));
    }
    const { primary: minimaxH3Image, embedding: minimaxH3BF16Embedding } = h3Composition;
    if (minimaxH3Image && minimaxH3BF16Embedding && bf16RetentionVersion < 1 && request.parameters.bf16WeightType !== 'bf16') {
      const maximumMemoryBytes = (() => {
        switch (request.artifact.profile) {
        case 'webgpu-wasm32-jspi': case 'webgpu-wasm32-asyncify': return 2n ** 32n;
        case 'webgpu-wasm64-jspi': return 16n * 1024n ** 3n;
        default: {
          const exhaustive: never = request.artifact.profile;
          throw new Error(String(exhaustive));
        }
        }
      })();
      // This full source + destination bound belongs to the legacy reader.
      // Version 1 can use bounded device reads, including F32/F16 conversion;
      // its actual host/device destination and F32 fallbacks are decided and
      // checked natively. Requested residency alone cannot establish that path.
      // Do not generalize the known H3 GET_ROWS role into retention for arbitrary
      // rank-2 weights: norm/bias and unsupported roles still use F32.
      // Unused source tensors and complete file sizes do not establish this bound.
      assertBf16ConversionFitsMemory({
        tensorName: minimaxH3BF16Embedding.name,
        elements: minimaxH3BF16Embedding.elements,
        target: request.parameters.bf16WeightType,
        maximumMemoryBytes,
      });
    }
    const ctxParams = keep({ pointer: core.allocRecord('sd_ctx_params_t') });
    await core.api.sd_ctx_params_init(ctxParams);
    for (const [slot, path] of paths) {
      core.setField('sd_ctx_params_t', ctxParams, pathFields[slot], text({ value: path }));
    }
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
    emit({
      event: 'native',
      stage: 'model-load',
      message: 'Requested weight placement, not proof of every tensor or operation running on GPU',
      fields: {
        requested: request.weightResidency,
        resolved: residency.resolved,
        requestedComputeBackend: 'WebGPU',
        requestedParamsBackend: residency.paramsBackend || '(runtime backend)',
        eagerLoad: residency.eagerLoad,
        autoFit: false,
        gpuBudgetMiB: request.gpuBudgetMiB ?? 'unset',
        modelBytes,
        bf16WeightType: request.parameters.bf16WeightType,
      },
    });
    const { flashAttention, bf16WeightType, conditioningCacheSize, modelArguments } = request.parameters;
    switch (bf16WeightType) {
    case 'f32': core.setField('sd_ctx_params_t', ctxParams, 'webgpu_bf16_type', core.constant('SD_TYPE_F32'));
      break;
    case 'f16': core.setField('sd_ctx_params_t', ctxParams, 'webgpu_bf16_type', core.constant('SD_TYPE_F16'));
      break;
    case 'bf16': core.setField('sd_ctx_params_t', ctxParams, 'webgpu_bf16_type', core.constant('SD_TYPE_BF16'));
      break;
    default: {
      const exhaustive: never = bf16WeightType;
      throw new Error(String(exhaustive));
    }
    }
    core.setField('sd_ctx_params_t', ctxParams, 'flash_attn', Number(flashAttention));
    core.setField('sd_ctx_params_t', ctxParams, 'diffusion_flash_attn', Number(flashAttention));
    core.setField('sd_ctx_params_t', ctxParams, 'flash_attn_mode', text({ value: flashAttention ? 'on' : 'off' }));
    core.setField('sd_ctx_params_t', ctxParams, 'conv_direct_mode', text({ value: 'off' }));
    // Preserve sequential UNet CFG instead of adopting the new native batching default.
    core.setField('sd_ctx_params_t', ctxParams, 'batched_cfg', 0);
    core.setField('sd_ctx_params_t', ctxParams, 'conditioning_cache_size', conditioningCacheSize);
    core.setField('sd_ctx_params_t', ctxParams, 'model_args', modelArguments ? text({ value: modelArguments }) : 0n);
    notify({ event: { phase: 'model', step: 0, steps: 0 } });
    emit({ event: 'start', stage: 'model-load', message: undefined, fields: { wasmBytes: core.module.HEAPU8?.byteLength ?? 0, gpuBudgetMiB: request.gpuBudgetMiB ?? 'unset' } });
    nativeCall = 'new_sd_ctx';
    context = await core.api.new_sd_ctx(ctxParams);
    nativeCall = undefined;
    emit({ event: 'complete', stage: 'model-load', message: undefined, fields: { wasmBytes: core.module.HEAPU8?.byteLength ?? 0, created: !!context } });
    if (!context) {
      throw new Error('Model initialization failed; see native diagnostics');
    }
    if (await core.api.sd_ctx_supports_image_generation(context) !== 1) {
      throw new Error('This context does not support image generation');
    }
    modelVersion = core.readUtf8(await core.api.sd_get_model_version_name(context), 256) ?? 'Unknown';
  }
  async function generate({ run: { ...run } }: { run: Run }): Promise<(ImagePixels & { modelVersion: string, uniformOutput: boolean, sampling?: ImageGenerationSampling }) | CancelledResult> {
    if (closed || failed || poisoned || active) {
      throw new Error('Image session is busy, failed or released');
    }
    if (sessionId !== undefined && sessionId !== run.request.sessionId) {
      throw new Error('Model composition changed; replace the image worker');
    }
    sessionId ??= run.request.sessionId;
    const { request } = run;
    artifact ??= request.artifact;
    active = {
      ...run,
      latest: { type: 'naidan-image-preview-control-v1', runId: request.runId, revision: 0, settings: { ...request.preview } },
      capturedStep: 0,
      samplingSteps: undefined,
      samplingPass: undefined,
      cancelRequested: false,
    };
    // A requested observation may have started while idle. Reserve this run
    // first, then let that read finish before entering native code.
    if (inspection) {
      await inspection;
    }
    if (poisoned || closed) {
      active = undefined;
      throw new Error('Image session was released while inspecting its state');
    }
    const runAllocations: bigint[] = [];
    const keep = ({ pointer }: { pointer: bigint }) => {
      runAllocations.push(pointer);
      return pointer;
    };
    const text = ({ value }: { value: string }) => keep({ pointer: core.utf8(value) });
    let generationResult = 0n;
    let result: (ImagePixels & { modelVersion: string, uniformOutput: boolean, sampling?: ImageGenerationSampling }) | CancelledResult | undefined;
    let failure: { error: unknown } | undefined;
    try {
      await installCallbacks();
      // Start a fresh bounded observation window even when reusing the context.
      // This setter is idle-only; callbacks must never toggle diagnostics.
      switch (request.debug) {
      case 'on': await core.api.sd_set_graph_diagnostics(1);
        break;
      case 'off': case undefined: await core.api.sd_set_graph_diagnostics(0);
        break;
      default: {
        const exhaustive: never = request.debug;
        throw new Error(String(exhaustive));
      }
      }
      active.preview = createNativePreviewControl({ core, callback: callbacks[2]!, runId: request.runId, initial: request.preview });
      if (active.latest.revision) {
        active.preview.update({ control: active.latest });
      }
      if (!context) {
        await initialize({ request });
      } else {
        emit({ event: 'native', stage: 'model-load', message: 'Reusing loaded model context and weights', fields: { reused: true } });
      }
      if (active.cancelRequested) {
        throw cancelledRun;
      }
      if (modelVersion === 'MiniMax-H3-Image' && request.imageInputs.referenceImages.length > 16) {
        throw new Error('MiniMax-H3-Image supports at most 16 reference images.');
      }
      const { prompt, negativePrompt, width, height, steps, guidance, seed, sampler, scheduler,
        distilledGuidance, vaeTiling, vaeTileSize, qwenVaePolicy, flashAttention } = request.parameters;
      const pixelTile = nativeVaeTile({ modelVersion, requested: vaeTileSize, policy: qwenVaePolicy, enabled: vaeTiling });
      const params = keep({ pointer: core.allocRecord('sd_img_gen_params_t') });
      await core.api.sd_img_gen_params_init(params);
      await writeImageInputs({
        core,
        params,
        inputs: request.imageInputs,
        keep,
        checkCancelled() {
          if (active?.cancelRequested) {
            throw cancelledRun;
          }
        },
        onDecoded({ metadata }) {
          emit({ event: 'native', stage: 'generation', message: 'Decoded input image; native model preprocessing and conditioning follow', fields: { metric: 'input-image', ...metadata, strength: request.imageInputs.strength, alphaBackground: 'white', resize: 'native' } });
        },
      });
      core.setField('sd_img_gen_params_t', params, 'prompt', text({ value: prompt }));
      core.setField('sd_img_gen_params_t', params, 'negative_prompt', text({ value: negativePrompt }));
      core.setField('sd_img_gen_params_t', params, 'width', width);
      core.setField('sd_img_gen_params_t', params, 'height', height);
      core.setField('sd_img_gen_params_t', params, 'seed', BigInt(seed));
      core.setField('sd_img_gen_params_t', params, 'batch_count', 1);
      if (request.loras.length !== loraPaths.length) {
        throw new Error('LoRA files changed; replace the image worker');
      }
      const selectedLoras = request.loras.flatMap((lora, index) => lora.strength === 0 ? [] : [{ path: loraPaths[index]!, strength: lora.strength }]);
      if (selectedLoras.length) {
        const recordBytes = core.recordSize('sd_lora_t');
        const records = keep({ pointer: core.alloc(recordBytes * selectedLoras.length) });
        core.bytes(records, recordBytes * selectedLoras.length).fill(0);
        selectedLoras.forEach(({ path, strength }, index) => {
          const pointer = records + BigInt(index * recordBytes);
          core.setField('sd_lora_t', pointer, 'is_high_noise', 0);
          core.setField('sd_lora_t', pointer, 'multiplier', strength);
          core.setField('sd_lora_t', pointer, 'path', text({ value: path }));
        });
        core.setField('sd_img_gen_params_t', params, 'loras', records);
      } else {
        // An empty list clears native adapters from a previous retained run.
        core.setField('sd_img_gen_params_t', params, 'loras', 0n);
      }
      core.setField('sd_img_gen_params_t', params, 'lora_count', selectedLoras.length);
      request.loras.forEach(({ file, relativePath, strength }, index) => emit({
        event: 'native',
        stage: 'generation',
        message: 'Requested LoRA configuration; image generation success does not verify adapter compatibility or effect',
        fields: { metric: 'lora-request', index, path: (relativePath ?? file.name).slice(0, 512), bytes: file.size, strength, enabled: strength !== 0 },
      }));
      const sample = core.fieldAddress('sd_img_gen_params_t', params, 'sample_params');
      const sampleMethod = await (async () => {
        switch (sampler) {
        case 'auto': return core.api.sd_get_default_sample_method(context);
        case 'euler': case 'euler_a': case 'heun': case 'dpm2': case 'dpm++2m': case 'lcm': return core.api.str_to_sample_method(text({ value: sampler }));
        default: {
          const exhaustive: never = sampler;
          throw new Error(String(exhaustive));
        }
        }
      })();
      const sampleScheduler = await (async () => {
        switch (scheduler) {
        case 'auto': return core.api.sd_get_default_scheduler(context, sampleMethod);
        case 'discrete': case 'karras': case 'exponential': case 'simple': case 'sgm_uniform': return core.api.str_to_scheduler(text({ value: scheduler }));
        default: {
          const exhaustive: never = scheduler;
          throw new Error(String(exhaustive));
        }
        }
      })();
      if (sampleMethod < 0 || sampleMethod >= core.constant('SAMPLE_METHOD_COUNT') || sampleScheduler < 0 || sampleScheduler >= core.constant('SCHEDULER_COUNT')) {
        throw new Error('The selected sampling method or scheduler is unavailable');
      }
      const sampling: ImageGenerationSampling = {
        sampler: { id: sampleMethod, ...await samplingName({ functionName: 'sd_sample_method_name', id: sampleMethod }) },
        scheduler: { id: sampleScheduler, ...await samplingName({ functionName: 'sd_scheduler_name', id: sampleScheduler }) },
      };
      core.setField('sd_sample_params_t', sample, 'sample_method', sampleMethod);
      core.setField('sd_sample_params_t', sample, 'scheduler', sampleScheduler);
      core.setField('sd_sample_params_t', sample, 'sample_steps', steps);
      const guidanceParams = core.fieldAddress('sd_sample_params_t', sample, 'guidance');
      core.setField('sd_guidance_params_t', guidanceParams, 'txt_cfg', guidance);
      core.setField('sd_guidance_params_t', guidanceParams, 'distilled_guidance', distilledGuidance);
      const tiling = core.fieldAddress('sd_img_gen_params_t', params, 'vae_tiling_params');
      core.setField('sd_tiling_params_t', tiling, 'enabled', Number(vaeTiling));
      const effectiveTile = effectiveVaeTile({ modelVersion, requested: vaeTileSize, policy: qwenVaePolicy, enabled: vaeTiling });
      core.setField('sd_tiling_params_t', tiling, 'tile_size_w', pixelTile);
      core.setField('sd_tiling_params_t', tiling, 'tile_size_h', pixelTile);
      if (effectiveTile !== vaeTileSize) {
        emit({ event: 'native', stage: 'decoding', message: 'Bounded Qwen VAE tiles; output dimensions and sampling unchanged', fields: { requestedTile: vaeTileSize, effectiveTile, width, height } });
      }
      core.setField('sd_tiling_params_t', tiling, 'target_overlap', 0.25);
      const resultOut = keep({ pointer: core.alloc(core.pointerBytes) });
      core.bytes(resultOut, core.pointerBytes).fill(0);
      nativePhase = 'sampling';
      notify({ event: { phase: 'sampling', step: 0, steps } });
      emit({ event: 'start', stage: 'generation', message: 'generate_image includes text encoding, denoising and VAE decoding', fields: { width, height, steps, guidance, sampler: sampleMethod, scheduler: sampleScheduler, vaeTiling, flashAttention } });
      await active!.preview!.start();
      await core.api.sd_set_generation_progress_callback(context, BigInt(callbacks[3]!), 0n);
      if (active.cancelRequested) {
        throw cancelledRun;
      }
      try {
        active.onPerformance?.({ signal: { kind: 'conditioning' } });
      } catch { /* measurement only */ }
      nativeCall = 'generate_image';
      const generated = await core.api.generate_image(context, params, resultOut);
      nativeCall = undefined;
      emit({ event: 'complete', stage: 'generation', message: undefined, fields: { generated, wasmBytes: core.module.HEAPU8?.byteLength ?? 0 } });
      // Recreate views after every native call: Wasm memory may have grown.
      const pointers = core.bytes(resultOut, core.pointerBytes);
      const pointerView = new DataView(pointers.buffer, pointers.byteOffset, pointers.byteLength);
      generationResult = core.pointerBytes === 8 ? pointerView.getBigUint64(0, true) : BigInt(pointerView.getUint32(0, true));
      if (active.cancelRequested) {
        throw cancelledRun;
      }
      if (generated !== 1 || !generationResult) {
        throw new Error('Image generation did not return one complete image');
      }
      const images = BigInt(core.getField('sd_image_generation_result_t', generationResult, 'items'));
      const imageCount = core.getField('sd_image_generation_result_t', generationResult, 'count');
      if (!images || imageCount !== 1) {
        throw new Error('Image generation did not return one complete image');
      }
      const output = copyNativeImage({ core, pointer: core.fieldAddress('sd_image_result_t', images, 'image') });
      if (output.width !== width || output.height !== height) {
        throw new Error('Invalid generated image dimensions/channels');
      }
      const stats = imagePixelStatistics(output);
      emit({ event: 'native', stage: 'encoding', message: 'Native pixels before canvas/PNG encoding (uniform colour is not proof of failure)', fields: stats });
      result = { ...output, modelVersion, uniformOutput: stats.uniformOutput, sampling };
    } catch (error) {
      if (error === cancelledRun && nativeCall === undefined && context) {
        result = { cancelled: true, modelResident: true };
      } else {
        failure = { error };
        failed = true;
        const details = imageErrorContext({ error });
        poisoned ||= nativeCall !== undefined || details.errorType === 'wasm-trap';
        if (poisoned) {
          emit({ event: 'failed', stage: failureStage(), message: error instanceof Error ? error.message : String(error), fields: { ...details, nativeCall: nativeCall ?? 'native-boundary', wasmBytes: core.module.HEAPU8?.byteLength ?? 0, workerTerminationRequired: true } });
        }
      }
    } finally {
      // A trap/uncertain native return forbids reentry. Worker termination then
      // discards the module-global diagnostic flag along with the native state.
      if (!poisoned) {
        try {
          if (context) {
            await core.api.sd_set_generation_progress_callback(context, 0n, 0n);
          }
          await core.api.sd_set_graph_diagnostics(0);
        } catch (error) {
          poisoned = true;
          failed = true;
          emit({ event: 'failed', stage: 'cleanup', message: 'Graph diagnostic cleanup failed; Worker termination required', fields: imageErrorContext({ error }) });
          failure ??= { error };
        }
      }
    }
    active.preview?.close();
    try {
      if (!poisoned) {
        if (generationResult) {
          await core.api.free_sd_image_generation_result(generationResult);
        }
        await core.api.sd_set_preview_callback(0n, core.constant('PREVIEW_NONE'), 1, 0, 0, 0n);
        if (active.cancelRequested && context) {
          await core.api.sd_cancel_generation(context, core.constant('SD_CANCEL_RESET'));
        }
        for (const pointer of runAllocations.reverse()) {
          core.free(pointer);
        }
      }
    } catch (error) {
      poisoned = true;
      failed = true;
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
    if (failure) {
      throw failure.error;
    }
    if (!result) {
      throw new Error('Image operation produced no result');
    }
    return result;
  }

  function cancel({ control }: { control: CancelControl }): boolean {
    const parsed = cancelControlSchema.safeParse(control);
    if (!parsed.success || !active || poisoned || failed || closed || control.runId !== active.request.runId) {
      return false;
    }
    if (active.cancelRequested) {
      return true;
    }
    active.cancelRequested = true;
    if (nativeCall === 'generate_image' && context) {
      // Pinned sd_cancel_generation performs only an atomic flag store. Never
      // throw from a native callback or call the generic busy-guarded API here.
      const set = core.module._sdc_sd_cancel_generation;
      if (!set) {
        throw new Error('This runtime lacks cooperative image cancellation');
      }
      set(context, core.constant('SD_CANCEL_ALL'));
    }
    return true;
  }
  function updatePreview({ control }: { control: PreviewControl }): boolean {
    const parsed = previewControlSchema.safeParse(control);
    if (!parsed.success || !active || active.cancelRequested || poisoned || closed || control.runId !== active.request.runId || control.revision <= active.latest.revision || control.settings.mode !== active.request.preview.mode) {
      return false;
    }
    if (active.preview && !active.preview.update({ control })) {
      return false;
    }
    active.latest = control;
    return true;
  }
  async function inspectEngine(): Promise<ImageEngineInspection> {
    if (closed || poisoned || failed) {
      return { status: 'unavailable', reason: 'released' };
    }
    if (active || nativeCall || core.busy) {
      return { status: 'unavailable', reason: 'busy' };
    }
    if (!context || !artifact) {
      return { status: 'unavailable', reason: 'not-loaded' };
    }
    if (inspection) {
      return inspection;
    }
    const pending = inspectImageEngine({
      core,
      context,
      profile: artifact.profile,
      source: artifact.modulePath.split('/')[1]!,
      modelVersion,
      fileReadCacheBytes: fileReadCache.retainedBytes(),
    });
    inspection = pending;
    try {
      const result = await pending;
      if (result.status === 'failed' && result.disposition === 'retire-worker') {
        poisoned = true;
        failed = true;
      }
      return result;
    } finally {
      if (inspection === pending) {
        inspection = undefined;
      }
    }
  }
  async function close({ onDiagnostic, onLog }: { onDiagnostic?: Emit, onLog?: Run['onLog'] } = {}): Promise<void> {
    if (closed) {
      return;
    }
    if (active) {
      throw new Error('Do not enter native cleanup during generation');
    }
    closed = true;
    if (inspection) {
      await inspection;
    }
    const report = ({ ...event }: { event: ImageDiagnosticInput['event'], message?: ImageDiagnosticInput['message'], stage: ImageDiagnosticInput['stage'], fields: ImageDiagnosticInput['fields'] }) => {
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
      if (context) {
        await core.api.free_sd_ctx(context);
      }
      await core.api.sd_set_log_callback(0n, 0n);
      await core.api.sd_set_progress_callback(0n, 0n);
      for (const pointer of callbacks) {
        core.module.removeFunction(pointer);
      }
      for (const pointer of allocations.reverse()) {
        core.free(pointer);
      }
      for (const mount of mounts.reverse()) {
        mount.remove();
      }
      report({ event: 'complete', stage: 'cleanup', message: undefined, fields: {} });
    } catch (error) {
      poisoned = true;
      report({ event: 'failed', stage: 'cleanup', message: 'Native cleanup failed; Worker termination required', fields: imageErrorContext({ error }) });
      throw error;
    } finally {
      fileReadCache.clear();
    }
  }
  return { generate, cancel, updatePreview, inspectEngine, close };
}

/** One-shot convenience uses the same ownership implementation as retained runs. */
export async function runImageGeneration({ core, helpers, reader, ...run }: { core: Core, helpers: Pick<HostHelpers, 'mountReadOnlyFile'>, reader: SyncBlobReader, request: Run['request'], onProgress: Run['onProgress'], onLog: Run['onLog'], onDiagnostic?: Run['onDiagnostic'], onPerformance?: Run['onPerformance'], onPreview?: Run['onPreview'] }) {
  const session = createImageGenerationSession({ core, helpers, reader });
  let failure: { error: unknown } | undefined;
  let output: Awaited<ReturnType<typeof session.generate>> | undefined;
  try {
    output = await session.generate({ run });
  } catch (error) {
    failure = { error };
  }
  try {
    await session.close({ onDiagnostic: run.onDiagnostic, onLog: run.onLog });
  } catch (error) {
    failure ??= { error };
  }
  if (failure) {
    throw failure.error;
  }
  if (!output) {
    throw new Error('Image operation produced no result');
  }
  if ('cancelled' in output) {
    throw new DOMException('Image generation cancelled', 'AbortError');
  }
  return output;
}

export const TEST_ONLY = {
};
