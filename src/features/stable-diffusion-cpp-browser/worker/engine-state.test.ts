import { expect, it, vi } from 'vitest';
import { inspectImageEngine } from './engine-state';
import { imageEngineInspectionSchema, imageEngineSnapshotSchema } from '@/features/stable-diffusion-cpp-browser/engine-state';
import { engineSnapshotFixture } from '@/features/stable-diffusion-cpp-browser/test-utils/engine-state';

function harness() {
  let next = 100n;
  const fields = new Map<string, number | bigint>([
    ['sd_runtime_info_t:struct_size', 128], ['sd_runtime_info_t:version', 1], ['sd_runtime_info_t:n_threads', 1],
    ['sd_runtime_info_t:runners_ready', 1], ['sd_runtime_info_t:eager_load', 1],
    ['sd_memory_info_t:struct_size', 128], ['sd_memory_info_t:version', 1], ['sd_memory_info_t:registered_tensor_bytes', 9007199254740993n],
    ['sd_ctx_params_t:n_threads', -1], ['sd_ctx_params_t:backend', 999n], ['sd_ctx_params_t:webgpu_bf16_type', 0],
  ]);
  const core: Parameters<typeof inspectImageEngine>[0]['core'] = {
    busy: false,
    module: { HEAPU8: new Uint8Array(65536) },
    api: { sd_ctx_get_runtime_info: vi.fn(async () => 1), sd_ctx_get_memory_info: vi.fn(async () => 1), sd_ctx_get_params: vi.fn(async () => 1) },
    allocRecord: vi.fn(() => ++next),
    recordSize: vi.fn(() => 128),
    free: vi.fn(),
    getField: vi.fn((record, _pointer, field) => fields.get(record + ':' + field) ?? 0),
    constant: vi.fn(name => name === 'SD_TYPE_F32' ? 0 : 1),
    readUtf8: vi.fn(() => 'WebGPU'),
  };
  const inspect = () => inspectImageEngine({ core, context: 1n, profile: 'webgpu-wasm64-jspi', source: 'a'.repeat(40), modelVersion: 'Loaded model', fileReadCacheBytes: 32 });
  return { core, fields, inspect };
}

it('reads idle ABI records, preserves uint64 precision and copies borrowed strings before freeing only owned records', async () => {
  const h = harness();
  const result = await h.inspect();
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') throw new Error('Expected snapshot');
  expect(result.snapshot.memory.registeredTensorBytes).toBe('9007199254740993');
  expect(result.snapshot.runtime.nThreads).toBe(1); expect(result.snapshot.requested.nThreads).toBe(-1);
  expect(result.snapshot.wasmCapacityBytes).toBe(65536); expect(result.snapshot.fileReadCacheBytes).toBe(32);
  expect(result.snapshot.requested.computeBackend).toBe('WebGPU');
  expect(h.core.readUtf8).toHaveBeenCalledWith(999n, 513);
  expect(vi.mocked(h.core.free).mock.calls).toEqual([[103n], [102n], [101n]]);
  expect(h.core.api.sd_ctx_get_memory_info).toHaveBeenCalledWith(1n, 102n, 128n);
  expect(imageEngineInspectionSchema.safeParse(result).success).toBe(true);
});

it('does no allocation or native call while busy or without the optional getters', async () => {
  const h = harness(); Object.defineProperty(h.core, 'busy', { value: true, configurable: true });
  expect(await h.inspect()).toEqual({ status: 'unavailable', reason: 'busy' });
  Object.defineProperty(h.core, 'busy', { value: false }); h.core.api.sd_ctx_get_memory_info = undefined;
  expect(await h.inspect()).toEqual({ status: 'unavailable', reason: 'unsupported' });
  expect(h.core.allocRecord).not.toHaveBeenCalled(); expect(h.core.api.sd_ctx_get_runtime_info).not.toHaveBeenCalled();
});

it('does not publish uninitialized/refused records and allows a subsequent successful observation', async () => {
  const h = harness(); vi.mocked(h.core.api.sd_ctx_get_runtime_info!).mockResolvedValueOnce(0);
  expect(await h.inspect()).toMatchObject({ status: 'failed', disposition: 'retryable' });
  expect(h.core.getField).not.toHaveBeenCalled(); expect(h.core.api.sd_ctx_get_memory_info).not.toHaveBeenCalled();
  expect(await h.inspect()).toMatchObject({ status: 'ready' });
});

it('rejects unexpected layouts and inexact numbers without invalidating the native context', async () => {
  const h = harness(); h.fields.set('sd_memory_info_t:version', 2);
  expect(await h.inspect()).toMatchObject({ status: 'failed', disposition: 'retryable' });
  h.fields.set('sd_memory_info_t:version', 1); h.fields.set('sd_memory_info_t:registered_tensor_bytes', Number.MAX_SAFE_INTEGER + 1);
  expect(await h.inspect()).toMatchObject({ status: 'failed', disposition: 'retryable', message: 'Inexact image engine memory value' });
});

it('does not reenter native free or remaining getters after a trap', async () => {
  const h = harness(); vi.mocked(h.core.api.sd_ctx_get_memory_info!).mockRejectedValue(new WebAssembly.RuntimeError('memory access out of bounds'));
  expect(await h.inspect()).toMatchObject({ status: 'failed', disposition: 'retire-worker' });
  expect(h.core.api.sd_ctx_get_params).not.toHaveBeenCalled(); expect(h.core.free).not.toHaveBeenCalled();
});

it.each(['bad', '-1', '18446744073709551616', '1'.repeat(500)])('rejects malformed uint64 wire values without throwing from safeParse: %s', value => {
  const snapshot = engineSnapshotFixture(); snapshot.memory.registeredTensorBytes = value;
  expect(imageEngineSnapshotSchema.safeParse(snapshot).success).toBe(false);
});
