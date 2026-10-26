// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachCore, mountReadOnlyFile, schema, type Core } from 'stable-diffusion-cpp-browser-core/stable-diffusion-cpp/examples/runtime';
import type createNativeModule from 'stable-diffusion-cpp-browser-core/stable-diffusion-cpp/profiles/webgpu-wasm32-asyncify/test/core.d.ts';
import { createModelFileReadCache, createModelFileSource, type SyncBlobReader } from './gguf-file';

// Exercises the installed ABI and real CPU arithmetic with self-authored native
// tensors. It does not create model contexts, generate images or run GPU kernels.
let native: Awaited<ReturnType<typeof createNativeModule>>;
let core: Core;
const nativeDiagnostics: string[] = [];

beforeAll(async () => {
  const root = path.resolve('node_modules/stable-diffusion-cpp-browser-core/stable-diffusion-cpp-browser-core');
  const folder = path.join(root, 'profiles/webgpu-wasm32-asyncify/test');
  const imported: unknown = await import(/* @vite-ignore */ pathToFileURL(path.join(folder, 'core.mjs')).href);
  if (!imported || typeof imported !== 'object' || !('default' in imported) || typeof imported.default !== 'function') {
    throw new Error('Missing installed image test core factory');
  }
  const create = imported.default as typeof createNativeModule;
  native = await create({
    wasmBinary: await readFile(path.join(folder, 'core.wasm')),
    print() {},
    printErr(message) {
      if (nativeDiagnostics.length < 20) {
        nativeDiagnostics.push(message);
      }
    },
  });
  core = attachCore(native, schema, { suspension: 'asyncify' });
  expect(native._sdc_abi_version()).toBe(2);
  expect(core.pointerBytes).toBe(4);
}, 30_000);

describe('installed image core contracts on CPU', () => {
  it('initializes and resets the real context record without retaining previous pointers or options', async () => {
    const params = core.allocRecord('sd_ctx_params_t');
    const backend = core.utf8('WebGPU');
    const argumentsText = core.utf8('fixture=true');
    using _cleanup = {
      [Symbol.dispose]() {
        core.free(argumentsText);
        core.free(backend);
        core.free(params);
      },
    };
    core.bytes(params, core.recordSize('sd_ctx_params_t')).fill(255);
    await core.api.sd_ctx_params_init(params);
    expect(core.getField('sd_ctx_params_t', params, 'backend')).toBe(0n);
    expect(core.getField('sd_ctx_params_t', params, 'params_backend')).toBe(0n);
    expect(core.getField('sd_ctx_params_t', params, 'model_args')).toBe(0n);
    expect(core.getField('sd_ctx_params_t', params, 'auto_fit')).toBe(1);
    expect(core.getField('sd_ctx_params_t', params, 'conditioning_cache_size')).toBe(4);
    expect(core.getField('sd_ctx_params_t', params, 'wtype')).toBe(core.constant('SD_TYPE_COUNT'));
    core.setField('sd_ctx_params_t', params, 'backend', backend);
    core.setField('sd_ctx_params_t', params, 'model_args', argumentsText);
    core.setField('sd_ctx_params_t', params, 'auto_fit', 0);
    core.setField('sd_ctx_params_t', params, 'conditioning_cache_size', 1);
    core.setField('sd_ctx_params_t', params, 'diffusion_flash_attn', 1);
    expect(core.readUtf8(BigInt(core.getField('sd_ctx_params_t', params, 'backend')))).toBe('WebGPU');
    expect(core.readUtf8(BigInt(core.getField('sd_ctx_params_t', params, 'model_args')))).toBe('fixture=true');
    expect(core.getField('sd_ctx_params_t', params, 'auto_fit')).toBe(0);
    expect(core.getField('sd_ctx_params_t', params, 'conditioning_cache_size')).toBe(1);
    expect(core.getField('sd_ctx_params_t', params, 'diffusion_flash_attn')).toBe(1);
    await core.api.sd_ctx_params_init(params);
    expect(core.getField('sd_ctx_params_t', params, 'backend')).toBe(0n);
    expect(core.getField('sd_ctx_params_t', params, 'model_args')).toBe(0n);
    expect(core.getField('sd_ctx_params_t', params, 'auto_fit')).toBe(1);
    expect(core.getField('sd_ctx_params_t', params, 'conditioning_cache_size')).toBe(4);
    expect(core.getField('sd_ctx_params_t', params, 'diffusion_flash_attn')).toBe(0);
  });

  it('reinitializes nested sampling and image inputs without keeping a previous run', async () => {
    const params = core.allocRecord('sd_img_gen_params_t');
    const prompt = core.utf8('fixture 日本語😀');
    const pixels = core.alloc(6);
    using _cleanup = {
      [Symbol.dispose]() {
        core.free(pixels);
        core.free(prompt);
        core.free(params);
      },
    };
    core.bytes(params, core.recordSize('sd_img_gen_params_t')).fill(255);
    await core.api.sd_img_gen_params_init(params);
    const sample = core.fieldAddress('sd_img_gen_params_t', params, 'sample_params');
    const guidance = core.fieldAddress('sd_sample_params_t', sample, 'guidance');
    const image = core.fieldAddress('sd_img_gen_params_t', params, 'init_image');
    const tile = core.fieldAddress('sd_img_gen_params_t', params, 'vae_tiling_params');
    expect(core.getField('sd_img_gen_params_t', params, 'clip_skip')).toBe(-1);
    expect(core.getField('sd_img_gen_params_t', params, 'seed')).toBe(-1n);
    expect(core.getField('sd_sample_params_t', sample, 'sample_method')).toBe(core.constant('SAMPLE_METHOD_COUNT'));
    expect(core.getField('sd_sample_params_t', sample, 'scheduler')).toBe(core.constant('SCHEDULER_COUNT'));
    expect(core.getField('sd_sample_params_t', sample, 'sample_steps')).toBe(20);
    expect(core.getField('sd_guidance_params_t', guidance, 'txt_cfg')).toBe(7);
    core.bytes(pixels, 6).set([1, 2, 3, 4, 5, 6]);
    core.setField('sd_img_gen_params_t', params, 'prompt', prompt);
    core.setField('sd_img_gen_params_t', params, 'width', 320);
    core.setField('sd_sample_params_t', sample, 'sample_steps', 7);
    core.setField('sd_guidance_params_t', guidance, 'txt_cfg', 5.5);
    core.setField('sd_image_t', image, 'width', 2);
    core.setField('sd_image_t', image, 'height', 1);
    core.setField('sd_image_t', image, 'channel', 3);
    core.setField('sd_image_t', image, 'data', pixels);
    core.setField('sd_tiling_params_t', tile, 'enabled', 1);
    expect(core.readUtf8(BigInt(core.getField('sd_img_gen_params_t', params, 'prompt')))).toBe('fixture 日本語😀');
    expect(core.getField('sd_img_gen_params_t', params, 'width')).toBe(320);
    expect(core.getField('sd_sample_params_t', sample, 'sample_steps')).toBe(7);
    expect(core.getField('sd_guidance_params_t', guidance, 'txt_cfg')).toBe(5.5);
    expect(core.getField('sd_image_t', image, 'data')).toBe(pixels);
    expect(core.getField('sd_image_t', image, 'width')).toBe(2);
    expect(core.getField('sd_image_t', image, 'height')).toBe(1);
    expect(core.getField('sd_image_t', image, 'channel')).toBe(3);
    expect(core.getField('sd_tiling_params_t', tile, 'enabled')).toBe(1);
    await core.api.sd_img_gen_params_init(params);
    expect(core.getField('sd_img_gen_params_t', params, 'prompt')).toBe(0n);
    expect(core.getField('sd_img_gen_params_t', params, 'width')).toBe(512);
    expect(core.getField('sd_img_gen_params_t', params, 'loras')).toBe(0n);
    expect(core.getField('sd_img_gen_params_t', params, 'lora_count')).toBe(0);
    expect(core.getField('sd_sample_params_t', sample, 'sample_steps')).toBe(20);
    expect(core.getField('sd_guidance_params_t', guidance, 'txt_cfg')).toBe(7);
    expect(core.getField('sd_image_t', image, 'width')).toBe(0);
    expect(core.getField('sd_image_t', image, 'data')).toBe(0n);
    expect(core.getField('sd_tiling_params_t', tile, 'enabled')).toBe(0);
    expect(Array.from(core.bytes(pixels, 6))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('preserves signed 64-bit seeds beyond JavaScript number precision on the real wasm32 record', async () => {
    const params = core.allocRecord('sd_img_gen_params_t');
    using _cleanup = {
      [Symbol.dispose]() {
        core.free(params);
      },
    };
    await core.api.sd_img_gen_params_init(params);
    for (const seed of [-1n, 0n, 9007199254740993n, 9223372036854775807n]) {
      core.setField('sd_img_gen_params_t', params, 'seed', seed);
      expect(core.getField('sd_img_gen_params_t', params, 'seed')).toBe(seed);
    }
    expect(() => core.setField('sd_img_gen_params_t', params, 'seed', 9223372036854775808n)).toThrow('range');
    expect(() => core.setField('sd_img_gen_params_t', params, 'seed', Number(9007199254740993n))).toThrow('exact integer');
    await core.api.sd_img_gen_params_init(params);
    expect(core.getField('sd_img_gen_params_t', params, 'seed')).toBe(-1n);
  });

  it('connects bounded Blob reads through the real native safetensors reader beyond 4 GiB', async () => {
    const gap = 4 * 1024 ** 3;
    const json = new TextEncoder().encode(JSON.stringify({
      padding: { dtype: 'U8', shape: [gap], data_offsets: [0, gap] },
      weight: { dtype: 'F32', shape: [1], data_offsets: [gap, gap + 4] },
    }));
    const jsonBytes = Math.ceil(json.length / 8) * 8;
    const header = new Uint8Array(8 + jsonBytes);
    header.fill(32, 8);
    new DataView(header.buffer).setBigUint64(0, BigInt(jsonBytes), true);
    header.set(json, 8);
    // The offset follows directly from the file format, independently of the
    // production parser and the native probe's reported offset.
    const payloadOffset = header.length + gap;
    const size = payloadOffset + 4;
    const pageBytes = 64 * 1024;
    const reads: { offset: number, length: number }[] = [];
    const slices = new WeakMap<Blob, ArrayBuffer>();
    const file = new File([header], 'synthetic.safetensors', { lastModified: 1 });
    Object.defineProperty(file, 'size', { value: size });
    Object.defineProperty(file, 'arrayBuffer', {
      value() {
        throw new Error('Whole-model reads are forbidden in this fixture');
      },
    });
    Object.defineProperty(file, 'slice', {
      // External Blob.slice signature.
      value(start: number | undefined, end: number | undefined): Blob {
        const offset = start ?? 0;
        const limit = Math.min(end ?? size, size);
        const length = limit - offset;
        if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || length > pageBytes) {
          throw new Error('Unbounded or invalid sparse fixture read');
        }
        const bytes = new Uint8Array(length);
        for (const range of [{ offset: 0, bytes: header }, { offset: payloadOffset, bytes: Uint8Array.of(0, 0, 128, 63) }]) {
          const first = Math.max(offset, range.offset);
          const last = Math.min(limit, range.offset + range.bytes.length);
          if (first < last) {
            bytes.set(range.bytes.subarray(first - range.offset, last - range.offset), first - offset);
          }
        }
        reads.push({ offset, length });
        const blob = new Blob([bytes]);
        slices.set(blob, bytes.buffer);
        return blob;
      },
    });
    const reader: SyncBlobReader = {
      // External FileReaderSync signature.
      readAsArrayBuffer(blob) {
        const bytes = slices.get(blob);
        if (!bytes) {
          throw new Error('Unknown sparse fixture slice');
        }
        return bytes;
      },
    };
    const cache = createModelFileReadCache({ pageBytes, capacityBytes: 2 * pageBytes });
    const source = createModelFileSource({ file, reader, cache });
    const path = '/native-contract/synthetic.safetensors';
    {
      const mounted = mountReadOnlyFile(core, path, source, { maxChunkBytes: 16 * 1024 });
      const filename = core.utf8(path);
      using _cleanup = {
        [Symbol.dispose]() {
          core.free(filename);
          mounted.remove();
          cache.clear();
        },
      };
      expect(await native.ccall('sdc_test_safetensors_offset', 'bigint', ['number'], [Number(filename)], { async: true })).toBe(BigInt(payloadOffset));
      expect(await native.ccall('sdc_test_safetensors_value', 'number', ['number'], [Number(filename)], { async: true })).toBe(0x3f800000);
      // Opaque U8 padding is validated but omitted from the parameter map.
      expect(await native.ccall('sdc_test_model_tensor_count', 'number', ['number'], [Number(filename)], { async: true })).toBe(1);
      const blobReads = source.metrics().blobReads;
      expect(await native.ccall('sdc_test_safetensors_value', 'number', ['number'], [Number(filename)], { async: true })).toBe(0x3f800000);
      expect(source.metrics().blobReads).toBe(blobReads);
      expect(source.metrics().cacheHits).toBeGreaterThan(0);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.some(read => read.offset >= gap)).toBe(true);
      expect(reads.every(read => read.length <= pageBytes)).toBe(true);
      expect(reads.reduce((total, read) => total + read.length, 0)).toBeLessThanOrEqual(2 * pageBytes);
      expect(cache.retainedBytes()).toBeLessThanOrEqual(2 * pageBytes);
    }
    expect(cache.retainedBytes()).toBe(0);
    // Reusing the same path checks that the previous filesystem entry was removed.
    const remounted = mountReadOnlyFile(core, path, source, { maxChunkBytes: 16 * 1024 });
    using _remount = {
      [Symbol.dispose]() {
        remounted.remove();
      },
    };
  });

  it.each([
    { name: 'mixed BF16/F16 timestep arithmetic', probe: 'sdc_test_qwen_timestep' },
    { name: 'BF16 parameter file loading and arithmetic', probe: 'sdc_test_bf16_weights' },
    { name: '3D convolution bias arithmetic', probe: 'sdc_test_conv3d_bias' },
  ])('evaluates $name with the actual CPU backend', async ({ probe }) => {
    const backend = core.utf8('CPU');
    using _cleanup = {
      [Symbol.dispose]() {
        core.free(backend);
      },
    };
    nativeDiagnostics.length = 0;
    expect(typeof native['_' + probe]).toBe('function');
    // These test-only exports use native pointers, rather than the normalized
    // bigint bridge. ccall owns the complete Asyncify return before cleanup.
    const result = await native.ccall(probe, 'number', ['number'], [Number(backend)], { async: true });
    expect(result, nativeDiagnostics.join('\n')).toBe(1);
  });
});
