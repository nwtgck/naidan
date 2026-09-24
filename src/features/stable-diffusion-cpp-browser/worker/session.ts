import type { Request, Progress, ModelSlot } from '@/features/stable-diffusion-cpp-browser/types';
import type { Core, HostHelpers } from './core-types';
import { createGgufFileSource, type SyncBlobReader } from './gguf-file';

const pathFields = {
  model: 'model_path', diffusion: 'diffusion_model_path', vae: 'vae_path',
  clipL: 'clip_l_path', clipG: 'clip_g_path', t5: 't5xxl_path', lm: 'llm_path',
} satisfies Record<ModelSlot, string>;

/** One context per operation is a Naidan policy, not a limitation of the core. */
export async function runImageGeneration({ core, helpers, request, reader, onProgress, onLog }: {
  core: Core, helpers: Pick<HostHelpers, 'mountReadOnlyFile'>, request: Request,
  reader: SyncBlobReader,
  onProgress: ({ event }: { event: Progress }) => void,
  onLog: ({ message }: { message: string }) => void,
}): Promise<{ pixels: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, modelVersion: string }> {
  if (core.pointerBytes !== 4 && core.pointerBytes !== 8) throw new Error('Unsupported native pointer width');
  const allocations: bigint[] = [];
  const mounts: { remove(): void }[] = [];
  const callbacks: (number | bigint)[] = [];
  let context = 0n;
  let images = 0n;
  let imageCount = 0;
  const keep = ({ pointer }: { pointer: bigint }) => {
    allocations.push(pointer); return pointer;
  };
  const text = ({ value }: { value: string }) => keep({ pointer: core.utf8(value) });
  const log = ({ message }: { message: string }) => {
    try {
      onLog({ message });
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
        if (pointer !== undefined) log({ message: core.readUtf8(BigInt(pointer), 8192) ?? '' });
      } catch { /* Borrowed diagnostic may no longer be readable after a trap. */ }
    }, 'vipp');
    callbacks.push(logCallback);
    const progressCallback = core.module.addFunction((...args) => {
      const [rawStep, rawSteps] = args;
      const step = Number(rawStep), steps = Number(rawSteps);
      if (Number.isInteger(step) && Number.isInteger(steps) && step >= 0 && steps >= 0) notify({ event: { phase: 'sampling', step, steps } });
    }, 'viifp');
    callbacks.push(progressCallback);
    await core.api.sd_set_log_callback(BigInt(logCallback), 0n);
    await core.api.sd_set_progress_callback(BigInt(progressCallback), 0n);
    core.module.FS.mkdir('/models');
    const paths = new Map<ModelSlot, string>();
    for (const { slot, file } of request.models) {
      const path = '/models/' + slot + '.gguf';
      const source = createGgufFileSource({ file, reader });
      mounts.push(helpers.mountReadOnlyFile(core, path, source, { maxChunkBytes: 8 * 1024 * 1024 }));
      paths.set(slot, path);
      log({ message: `Mounted ${slot}: ${file.size} bytes, caller-owned random access (no GGUF split)` });
    }
    const ctxParams = keep({ pointer: core.allocRecord('sd_ctx_params_t') });
    await core.api.sd_ctx_params_init(ctxParams);
    for (const [slot, path] of paths) core.setField('sd_ctx_params_t', ctxParams, pathFields[slot], text({ value: path }));
    // These choices are visible application policy; none is embedded in the core.
    core.setField('sd_ctx_params_t', ctxParams, 'n_threads', 1);
    core.setField('sd_ctx_params_t', ctxParams, 'enable_mmap', 0);
    core.setField('sd_ctx_params_t', ctxParams, 'disable_prefetch', 1);
    core.setField('sd_ctx_params_t', ctxParams, 'eager_load', 0);
    core.setField('sd_ctx_params_t', ctxParams, 'auto_fit', 0);
    core.setField('sd_ctx_params_t', ctxParams, 'backend', text({ value: 'WebGPU' }));
    core.setField('sd_ctx_params_t', ctxParams, 'params_backend', text({ value: 'disk' }));
    core.setField('sd_ctx_params_t', ctxParams, 'max_vram', text({ value: String(request.gpuBudgetMiB / 1024) }));
    const { prompt, negativePrompt, width, height, steps, guidance, seed, sampler, scheduler,
      distilledGuidance, vaeTiling, vaeTileSize, flashAttention, conditioningCacheSize, modelArguments, ...rest } = request.parameters;
    rest satisfies Record<PropertyKey, never>;
    core.setField('sd_ctx_params_t', ctxParams, 'flash_attn', Number(flashAttention));
    core.setField('sd_ctx_params_t', ctxParams, 'diffusion_flash_attn', Number(flashAttention));
    core.setField('sd_ctx_params_t', ctxParams, 'conditioning_cache_size', conditioningCacheSize);
    core.setField('sd_ctx_params_t', ctxParams, 'model_args', modelArguments ? text({ value: modelArguments }) : 0n);
    notify({ event: { phase: 'model', step: 0, steps: 0 } });
    context = await core.api.new_sd_ctx(ctxParams);
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
    const generated = await core.api.generate_image(context, params, imagesOut, countOut);
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
  } finally {
    // If Wasm traps, cleanup may also fail; the client unconditionally destroys
    // this Worker. Do not replace the useful native error with a cleanup error.
    try {
      if (images && imageCount > 0 && imageCount <= 64) await core.api.free_sd_images(images, imageCount);
      if (context) await core.api.free_sd_ctx(context);
      await core.api.sd_set_log_callback(0n, 0n);
      await core.api.sd_set_progress_callback(0n, 0n);
      for (const pointer of callbacks) core.module.removeFunction(pointer);
      for (const pointer of allocations.reverse()) core.free(pointer);
      // A disk-backed parameter source must outlive the complete native context.
      for (const mounted of mounts.reverse()) mounted.remove();
    } catch (error) {
      log({ message: `Native teardown failed; Worker will be terminated: ${String(error)}` });
    }
  }
}
export const TEST_ONLY = {
};
