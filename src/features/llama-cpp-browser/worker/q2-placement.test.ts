import { describe, expect, it, vi } from 'vitest';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { associateGpuRequests } from '@/features/llama-cpp-browser/runtime/webgpu-request-diagnostics';
import { inspectQ2Placement, resolveQ2PlacementDevice, setQ2PlacementOverrides, TEST_ONLY } from './q2-placement';

const limits = {
  maxBufferSize: 268435456,
  maxStorageBufferBindingSize: 134217728,
  minStorageBufferOffsetAlignment: 256,
  maxStorageBuffersPerShaderStage: 8,
  maxBindingsPerBindGroup: 1000,
  maxUniformBuffersPerShaderStage: 12,
  maxUniformBufferBindingSize: 65536,
  maxComputeWorkgroupStorageSize: 16384,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupsPerDimension: 65535,
};

type Tensor = { name: string, kind: number, shape: bigint[], size: bigint };
const shape = [640n, 2560n, 512n, 1n];
const size = 235929600n;

const valid = ({ name }: { name: string }): Tensor => ({ name, kind: 34, shape, size });

function fixture({ entries, pointerBytes }: { entries: Tensor[][], pointerBytes: 4 | 8 }) {
  let offset = 32;
  const buffer = new ArrayBuffer(65536);
  const view = new DataView(buffer);
  const encoder = new TextEncoder();
  const strings = new Map<bigint, string>();
  const allocations: bigint[] = [];
  const alloc = ({ bytes }: { bytes: number }): bigint => {
    const pointer = BigInt(offset);
    offset += (bytes + 7) & ~7;
    return pointer;
  };
  function utf8({ text }: { text: string }): bigint {
    const data = encoder.encode(text);
    const pointer = alloc({ bytes: Math.max(64, data.length + 1) });
    new Uint8Array(buffer, Number(pointer), data.length).set(data);
    strings.set(pointer, text);
    return pointer;
  }
  function pointerAt({ offset }: { offset: bigint }): bigint {
    return pointerBytes === 8 ? view.getBigUint64(Number(offset), true) : BigInt(view.getUint32(Number(offset), true));
  }
  function writePointer({ offset, value }: { offset: bigint, value: bigint }): void {
    if (pointerBytes === 8) {
      view.setBigUint64(Number(offset), value, true);
    } else {
      view.setUint32(Number(offset), Number(value), true);
    }
  }
  const readEntry = ({ gguf, index }: { gguf: bigint, index: bigint }) => entries[Number(gguf - 1n)]![Number(index)]!;
  const api = {
    ggml_backend_dev_by_type: vi.fn(async () => 70n),
    ggml_backend_dev_backend_reg: vi.fn(async () => 71n),
    ggml_backend_reg_get_proc_address: vi.fn<Core['api']['ggml_backend_reg_get_proc_address']>().mockResolvedValue(81n),
    ggml_backend_dev_buffer_type: vi.fn(async () => 72n),
    ggml_backend_buft_get_device: vi.fn(async () => 70n),
    ggml_backend_buft_get_max_size: vi.fn(async () => 268435456n),
    ggml_backend_buft_get_alloc_size: vi.fn(async () => size),
    gguf_init_from_file: vi.fn(async (file: bigint, params: bigint) => {
      const index = Number(strings.get(file)!.match(/\d+/u)?.[0]);
      expect(view.getUint8(Number(params))).toBe(1);
      writePointer({ offset: pointerAt({ offset: params + BigInt(pointerBytes) }), value: BigInt(index + 100) });
      return BigInt(index + 1);
    }),
    gguf_get_n_tensors: vi.fn(async (gguf: bigint) => BigInt(entries[Number(gguf - 1n)]!.length)),
    gguf_get_tensor_name: vi.fn(async (gguf: bigint, index: bigint) => utf8({ text: readEntry({ gguf, index }).name })),
    gguf_get_tensor_type: vi.fn(async (gguf: bigint, index: bigint) => readEntry({ gguf, index }).kind),
    gguf_get_tensor_size: vi.fn(async (gguf: bigint, index: bigint) => readEntry({ gguf, index }).size),
    gguf_get_tensor_ne: vi.fn(async (gguf: bigint, index: bigint) => {
      const pointer = alloc({ bytes: 32 });
      for (const [axis, extent] of readEntry({ gguf, index }).shape.entries()) {
        view.setBigInt64(Number(pointer) + axis * 8, extent, true);
      }
      return pointer;
    }),
    ggml_get_tensor: vi.fn(async () => 95n),
    ggml_free: vi.fn(async () => {}),
    gguf_free: vi.fn(async () => {}),
    llama_max_tensor_buft_overrides: vi.fn(async () => 4096n),
  };
  const setField = vi.fn(({ pointer, field, value }: { pointer: bigint, field: string, value: bigint | number }) => {
    switch (field) {
    case 'no_alloc': view.setUint8(Number(pointer), Number(value));
      break;
    case 'pattern': writePointer({ offset: pointer, value: BigInt(value) });
      break;
    default: writePointer({ offset: pointer + BigInt(pointerBytes), value: BigInt(value) });
      break;
    }
  });
  const free = vi.fn();
  const core = {
    pointerBytes,
    api,
    alloc,
    utf8,
    free,
    setField,
    module: { HEAPU8: new Uint8Array(buffer) },
    hasFunction: vi.fn(() => true),
    allocRecord: () => alloc({ bytes: 2 * pointerBytes }),
    recordSize: () => 2 * pointerBytes,
    bytes: ({ pointer, length }: { pointer: bigint, length: number }) => new Uint8Array(buffer, Number(pointer), length),
    constant: ({ name }: { name: string }) => name === 'GGML_MAX_NAME' ? 64 : name === 'GGML_TYPE_Q2_0' ? 34 : 1,
  } as unknown as Core;
  associateGpuRequests({
    core,
    snapshot: () => ({
      bufferCount: 0,
      bufferBytes: 0,
      writeCount: 0,
      writeBytes: 0,
      largestWriteBytes: 0,
      writesAtLeast4MiB: 0,
      metadata: { deviceLimits: limits },
    }),
  });
  return { api, core, allocations, strings, pointerAt, setField, free };
}

describe('Q2 placement device admission', () => {
  it('looks up the existing device registry and fails before lookup for a CPU or missing ABI', async () => {
    const { core, api, strings, free } = fixture({ entries: [], pointerBytes: 8 });
    await expect(resolveQ2PlacementDevice({ core, profile: 'cpu-wasm32' })).rejects.toThrow('requires a WebGPU runtime');
    vi.mocked(core.hasFunction).mockReturnValueOnce(false);
    await expect(resolveQ2PlacementDevice({ core, profile: 'webgpu-wasm64-jspi' })).rejects.toThrow('lacks the required');
    expect(api.ggml_backend_dev_by_type).not.toHaveBeenCalled();
    await expect(resolveQ2PlacementDevice({ core, profile: 'webgpu-wasm64-jspi' })).resolves.toEqual({ buft: 72n, maxAllocation: 268435456n });
    const marker = api.ggml_backend_reg_get_proc_address.mock.calls[0]?.[1];
    expect(marker).toBeDefined();
    if (marker !== undefined) {
      expect(strings.get(marker)).toBe('ggml_backend_webgpu_indexed_q2_placement_v1');
      expect(free).toHaveBeenCalledWith({ pointer: marker });
    }
    api.ggml_backend_reg_get_proc_address.mockResolvedValueOnce(0n);
    await expect(resolveQ2PlacementDevice({ core, profile: 'webgpu-wasm64-jspi' })).rejects.toThrow('does not advertise');
  });

  it('checks actual allocation, two-binding and alignment boundaries', () => {
    const selected = { ...limits, maxBufferSize: Number(size), maxStorageBufferBindingSize: Number(size / 2n) };
    expect(TEST_ONLY.checkDeviceLimits({ limits: selected })).toBe(size);
    expect(() => TEST_ONLY.checkDeviceLimits({ limits: { ...selected, maxBufferSize: Number(size) - 1 } })).toThrow('maxBufferSize');
    expect(() => TEST_ONLY.checkDeviceLimits({ limits: { ...selected, maxStorageBufferBindingSize: Number(size / 2n) - 4 } })).toThrow('two aligned');
    expect(() => TEST_ONLY.checkDeviceLimits({ limits: { ...selected, maxBufferSize: limits.maxBufferSize, minStorageBufferOffsetAlignment: 16777216 } })).toThrow('two aligned');
    expect(() => TEST_ONLY.checkDeviceLimits({ limits: { ...selected, maxStorageBuffersPerShaderStage: 5 } })).toThrow('maxStorageBuffersPerShaderStage');
    expect(TEST_ONLY.checkDeviceLimits({ limits: { ...selected, maxStorageBufferBindingSize: Number(size), maxStorageBuffersPerShaderStage: 5 } })).toBe(size);
    expect(() => TEST_ONLY.checkDeviceLimits({ limits: undefined })).toThrow('selected WebGPU device limit unavailable');
  });
});

describe('Q2 placement metadata and overrides', () => {
  it('reads a terminated name within the actual heap tail', async () => {
    const target = valid({ name: 'blk.1.ffn_down_exps.weight' });
    const { api, core, allocations } = fixture({ entries: [[target]], pointerBytes: 8 });
    const name = new TextEncoder().encode(target.name);
    const pointer = BigInt(core.module.HEAPU8.byteLength - name.length - 1);
    core.bytes({ pointer, length: name.length }).set(name);
    api.gguf_get_tensor_name.mockResolvedValueOnce(pointer);
    await expect(inspectQ2Placement({ core, paths: ['/models/shard0.gguf'], device: { buft: 72n, maxAllocation: size }, allocations, signal: undefined })).resolves.toEqual([target.name]);
  });

  it('declines more than the measured nine packed weights', async () => {
    const entries = Array.from({ length: 10 }, (_, index) => valid({ name: `blk.${index}.ffn_down_exps.weight` }));
    const { api, core, allocations } = fixture({ entries: [entries], pointerBytes: 8 });
    await expect(inspectQ2Placement({ core, paths: ['/models/shard0.gguf'], device: { buft: 72n, maxAllocation: size }, allocations, signal: undefined })).rejects.toThrow('exceed 2123366400 bytes');
    expect(api.ggml_backend_buft_get_alloc_size).toHaveBeenCalledTimes(9);
    expect(api.ggml_free).toHaveBeenCalledExactlyOnceWith(100n);
    expect(api.gguf_free).toHaveBeenCalledExactlyOnceWith(1n);
  });

  it.each([4, 8] as const)('scans all shards without payload and writes zero-terminated exact overrides with %i-byte pointers', async pointerBytes => {
    const paths = ['/models/shard0.gguf', '/models/shard1.gguf'];
    const first = valid({ name: 'blk.1.ffn_down_exps.weight' });
    const second = valid({ name: 'blk.21.ffn_down_exps.weight' });
    const { api, core, allocations, pointerAt, strings } = fixture({
      pointerBytes,
      entries: [
        [first, { ...first, name: 'blk.2.ffn_down_exps.weight', shape: [640n, 2560n, 127n, 1n] }],
        [{ ...second, name: 'blk.3.ffn_down_exps.weight', kind: 2 }, { ...second, name: 'blk.4.ffn_up_exps.weight' }, second],
      ],
    });
    const names = await inspectQ2Placement({ core, paths, device: { buft: 72n, maxAllocation: size }, allocations, signal: undefined });
    expect(names).toEqual([first.name, second.name]);
    expect(api.gguf_init_from_file.mock.calls.map(([pointer]) => strings.get(pointer))).toEqual(paths);
    expect(api.ggml_free.mock.calls).toEqual([[100n], [101n]]);
    expect(api.gguf_free.mock.calls).toEqual([[1n], [2n]]);
    expect(api.ggml_backend_buft_get_alloc_size).toHaveBeenCalledTimes(2);

    const params = core.allocRecord({ name: 'llama_model_params' });
    setQ2PlacementOverrides({ core, params, names, buft: 72n, allocations });
    const width = BigInt(pointerBytes);
    const table = pointerAt({ offset: params + width });
    expect(allocations).toContain(table);
    expect(strings.get(pointerAt({ offset: table }))).toBe('^blk\\.1\\.ffn_down_exps\\.weight$');
    expect(strings.get(pointerAt({ offset: table + 2n * width }))).toBe('^blk\\.21\\.ffn_down_exps\\.weight$');
    expect(pointerAt({ offset: table + width })).toBe(72n);
    expect(pointerAt({ offset: table + 3n * width })).toBe(72n);
    expect(pointerAt({ offset: table + 4n * width })).toBe(0n);
    expect(pointerAt({ offset: table + 5n * width })).toBe(0n);
  });

  it('releases metadata on duplicate names, zero matching weights and insufficient backend capacity', async () => {
    const tensor = valid({ name: 'blk.1.ffn_down_exps.weight' });
    for (const { entries, capacity, message } of [
      { entries: [[tensor], [tensor]], capacity: size, message: 'invalid GGUF tensor metadata' },
      { entries: [[{ ...tensor, kind: 1 }]], capacity: size, message: 'no eligible Q2_0' },
      { entries: [[tensor]], capacity: size - 1n, message: 'cannot allocate' },
    ]) {
      const { api, core, allocations } = fixture({ entries, pointerBytes: 8 });
      const paths = entries.map((_, index) => `/models/shard${index}.gguf`);
      await expect(inspectQ2Placement({ core, paths, device: { buft: 72n, maxAllocation: capacity }, allocations, signal: undefined })).rejects.toThrow(message);
      expect(api.ggml_free).toHaveBeenCalledTimes(entries.length);
      expect(api.gguf_free).toHaveBeenCalledTimes(entries.length);
    }
  });
});
