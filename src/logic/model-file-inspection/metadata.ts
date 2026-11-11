import { z } from 'zod';
import { awaitInspection } from './abort';
import { parseModelJson } from './json';

// Limits bound inspection work, not the size of a model file or tensor payload.
export const MODEL_HEADER_LIMIT = 16 * 1024 * 1024;
const readBudget = 32 * 1024 * 1024;
const maxItems = 1_000_000;
const decoder = new TextDecoder('utf-8', { fatal: true });
// eslint-disable-next-line local-rules-named-args/require-named-args -- Platform Blob range-read surface; no whole-file method is required.
export type ModelMetadataFile = Pick<Blob, 'size'> & { slice(...args: Parameters<Blob['slice']>): Pick<Blob, 'arrayBuffer'> };
export type TensorInfo = { name: string, shape: number[], dtype: string };
export type WeightMetadata = {
  format: 'gguf' | 'safetensors';
  metadata: ReadonlyMap<string, string | number | boolean>;
  tensors: TensorInfo[];
  split: { index: number, count: number, tensors: number } | undefined;
  unsupported: string | undefined;
  requiresGgufOriginalShapes: boolean;
};
export type Inspection = { status: 'weights', value: WeightMetadata } | { status: 'unknown' | 'invalid' | 'lfs-pointer', reason: string };
const metadataRecord = z.record(z.string(), z.string());
const safeUnsigned = z.number().int().nonnegative().refine(Number.isSafeInteger);
const tensorSchema = z.object({ dtype: z.string().min(1).max(64), shape: z.array(safeUnsigned).max(64), data_offsets: z.tuple([safeUnsigned, safeUnsigned]) });
const dtypeBytes: Readonly<Record<string, number>> = { F64: 8, F32: 4, F16: 2, BF16: 2, I64: 8, I32: 4, I16: 2, I8: 1, U64: 8, U32: 4, U16: 2, U8: 1, BOOL: 1, F8_E4M3: 1, F8_E5M2: 1 };
// GGUF on-disk block layouts from ggml.h / ggml-common.h. Used only when
// validating Comfy original shapes; unknown types are never guessed.
const ggufBlocks: Readonly<Record<number, readonly [number, number]>> = {
  0: [1, 4],
  1: [1, 2],
  2: [32, 18],
  3: [32, 20],
  6: [32, 22],
  7: [32, 24],
  8: [32, 34],
  9: [32, 36],
  10: [256, 84],
  11: [256, 110],
  12: [256, 144],
  13: [256, 176],
  14: [256, 210],
  15: [256, 292],
  16: [256, 66],
  17: [256, 74],
  18: [256, 98],
  19: [256, 50],
  20: [32, 18],
  21: [256, 110],
  22: [256, 82],
  23: [256, 136],
  24: [1, 1],
  25: [1, 2],
  26: [1, 4],
  27: [1, 8],
  28: [1, 8],
  29: [256, 56],
  30: [1, 2],
  34: [256, 54],
  35: [256, 66],
  39: [32, 17],
  40: [64, 36],
  41: [128, 18],
  42: [64, 18],
};
const originalShapePrefix = 'comfy.gguf.orig_shape.';
const maxGgmlElements = (1n << 63n) - 1n;

function ggufOriginalShapeLayout({ descriptorShape, originalShape, dtype }: { descriptorShape: readonly number[], originalShape: readonly number[], dtype: number }): { bytes: bigint, changesGgmlShape: boolean } {
  const count = originalShape.reduce((total, dimension) => total * BigInt(dimension), 1n);
  if (descriptorShape.reduce((total, dimension) => total * BigInt(dimension), 1n) !== count) {
    throw new Error('GGUF original shape element count disagrees with its descriptor');
  }
  const originalNe = [...originalShape].reverse();
  if (descriptorShape.length !== 1 && (descriptorShape.length !== originalNe.length || descriptorShape.some((dimension, index) => dimension !== originalNe[index]))) {
    throw new Error('GGUF original shape contradicts a multidimensional descriptor');
  }
  const block = ggufBlocks[dtype];
  if (!block) {
    throw new Error('Unsupported GGUF dtype for original shape validation');
  }
  const [blockElements, blockBytes] = block;
  if (descriptorShape[0]! % blockElements !== 0 || originalNe[0]! % blockElements !== 0) {
    throw new Error('GGUF original shape violates quantization row block alignment');
  }
  const descriptorBytes = count / BigInt(blockElements) * BigInt(blockBytes);
  const rowElements = BigInt(originalNe[0]!);
  const originalBytes = rowElements / BigInt(blockElements) * BigInt(blockBytes) * (count / rowElements);
  if (descriptorBytes !== originalBytes) {
    throw new Error('GGUF original shape changes tensor storage bytes');
  }
  return {
    bytes: originalBytes,
    // Leading PyTorch singleton dimensions are trailing GGML ones. They do not
    // require a new native loader when the four physical axes already agree.
    changesGgmlShape: Array.from({ length: 4 }, (_value, index) => (descriptorShape[index] ?? 1) !== (originalNe[index] ?? 1)).some(Boolean),
  };
}

function checkedSize({ value }: { value: bigint }): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Model integer is outside the exact file-offset range');
  }
  return Number(value);
}

export async function readModelRange({ file, offset, length, signal }: { file: ModelMetadataFile, offset: number, length: number, signal: AbortSignal | undefined }): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(file.size) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > file.size || length > file.size - offset || length > MODEL_HEADER_LIMIT) {
    throw new Error('Invalid bounded model read');
  }
  const result = new Uint8Array(await awaitInspection({ task: file.slice(offset, offset + length).arrayBuffer(), signal }));
  signal?.throwIfAborted();
  if (result.length !== length) {
    throw new Error('Model file changed or its header is truncated');
  }
  return result;
}

async function inspectGguf({ file, signal }: { file: ModelMetadataFile, signal: AbortSignal | undefined }): Promise<WeightMetadata> {
  let offset = 0, windowStart = 0, bytesRead = 0, items = 0;
  let window: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  const metadata = new Map<string, string | number | boolean>();
  const keys = new Set<string>();
  const originalShapes = new Map<string, number[]>();
  let alignmentPosition: number | undefined;
  let alignmentType: number | undefined;
  async function checkpoint(): Promise<void> {
    signal?.throwIfAborted();
    if (++items > maxItems * 2) {
      throw new Error('GGUF metadata inspection limit reached');
    }
    if (items % 2048 === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      signal?.throwIfAborted();
    }
  }
  function skip({ bytes }: { bytes: number }): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > file.size - offset) {
      throw new Error('GGUF metadata outside file');
    }
    offset += bytes;
  }
  async function read({ bytes }: { bytes: number }): Promise<DataView<ArrayBuffer>> {
    signal?.throwIfAborted();
    const start = offset;
    skip({ bytes });
    if (start < windowStart || offset > windowStart + window.length) {
      windowStart = start;
      const length = Math.min(file.size - start, Math.max(bytes, 64 * 1024));
      if ((bytesRead += length) > readBudget) {
        throw new Error('GGUF metadata inspection byte budget reached');
      }
      window = await readModelRange({ file, offset: start, length, signal });
    }
    return new DataView(window.buffer, window.byteOffset + start - windowStart, bytes);
  }
  async function u32(): Promise<number> {
    return (await read({ bytes: 4 })).getUint32(0, true);
  }
  async function u64(): Promise<number> {
    return checkedSize({ value: (await read({ bytes: 8 })).getBigUint64(0, true) });
  }
  async function string({ retain }: { retain: boolean }): Promise<string | undefined> {
    const bytes = await u64();
    if (!retain) {
      skip({ bytes });
      return undefined;
    }
    if (bytes > 4096) {
      throw new Error('GGUF descriptor string is too large to inspect');
    }
    const view = await read({ bytes });
    const result = decoder.decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    if (result.includes('\0')) {
      throw new Error('NUL in GGUF descriptor');
    }
    return result;
  }
  async function value({ type, retain }: { type: number, retain: boolean }): Promise<string | number | boolean | undefined> {
    await checkpoint();
    const sizes: Readonly<Record<number, number>> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
    const bytes = sizes[type];
    if (bytes !== undefined) {
      if (!retain) {
        skip({ bytes });
        return undefined;
      }
      const view = await read({ bytes });
      switch (type) {
      case 0: return view.getUint8(0);
      case 1: return view.getInt8(0);
      case 2: return view.getUint16(0, true);
      case 3: return view.getInt16(0, true);
      case 4: return view.getUint32(0, true);
      case 5: return view.getInt32(0, true);
      case 6: return view.getFloat32(0, true);
      case 7: {
        const n = view.getUint8(0);
        if (n > 1) {
          throw new Error('Invalid GGUF boolean');
        }
        return n === 1;
      }
      case 10: case 11: {
        const n = type === 10 ? view.getBigUint64(0, true) : view.getBigInt64(0, true);
        return n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER) ? String(n) : Number(n);
      }
      case 12: return view.getFloat64(0, true);
      default: throw new Error('Unknown GGUF scalar');
      }
    }
    if (type === 8) {
      return string({ retain });
    }
    if (type !== 9) {
      throw new Error('Unknown GGUF metadata type');
    }
    const element = await u32(), count = await u64();
    const size = sizes[element];
    if (size !== undefined) {
      skip({ bytes: count * size });
    } else {
      if (element !== 8 || count > maxItems) {
        throw new Error('Unsupported GGUF array');
      }
      for (let i = 0; i < count; i++) {
        await checkpoint();
        await string({ retain: false });
      }
    }
    return undefined;
  }
  async function originalShape({ type }: { type: number }): Promise<number[]> {
    if (type !== 9) {
      throw new Error('GGUF original shape must be an integer array');
    }
    const element = await u32(), count = await u64();
    if (count < 1 || count > 4 || ![0, 1, 2, 3, 4, 5, 10, 11].includes(element)) {
      throw new Error('Invalid GGUF original shape array type or rank');
    }
    const shape: number[] = [];
    let elements = 1n;
    for (let i = 0; i < count; i++) {
      const dimension = await value({ type: element, retain: true });
      if (typeof dimension !== 'number' || !Number.isSafeInteger(dimension) || dimension <= 0 || (elements *= BigInt(dimension)) > maxGgmlElements) {
        throw new Error('Invalid GGUF original shape dimension or element count');
      }
      shape.push(dimension);
    }
    return shape;
  }
  if (await u32() !== 0x46554747 || ![2, 3].includes(await u32())) {
    throw new Error('Expected little-endian GGUF v2/v3');
  }
  const tensorCount = await u64(), metadataCount = await u64();
  if (tensorCount > 100_000 || metadataCount > maxItems) {
    throw new Error('GGUF table inspection limit reached');
  }
  for (let i = 0; i < metadataCount; i++) {
    const key = await string({ retain: true });
    if (!key || keys.has(key)) {
      throw new Error('Duplicate or empty GGUF metadata key');
    }
    keys.add(key);
    const type = await u32();
    if (key.startsWith(originalShapePrefix)) {
      const name = key.slice(originalShapePrefix.length);
      if (!name || originalShapes.size >= 100_000) {
        throw new Error('Empty GGUF original shape tensor name or inspection limit reached');
      }
      originalShapes.set(name, await originalShape({ type }));
      continue;
    }
    if (key === 'general.alignment') {
      alignmentType = type;
      alignmentPosition = offset;
      await value({ type, retain: false });
      continue;
    }
    const retain = /^(general\.(architecture|name|basename|finetune)|split\.|qwen[\w.]*\.(embedding_length|block_count)|clip\.)/.test(key);
    const item = await value({ type, retain });
    if (item !== undefined) {
      metadata.set(key, item);
    }
  }
  const tensors: TensorInfo[] = [], names = new Set<string>();
  const originalRanges: { offset: bigint, bytes: bigint }[] = [];
  let requiresGgufOriginalShapes = false;
  for (let i = 0; i < tensorCount; i++) {
    await checkpoint();
    const name = await string({ retain: true });
    if (!name || names.has(name)) {
      throw new Error('Duplicate or empty GGUF tensor name');
    }
    names.add(name);
    const rank = await u32();
    if (rank === 0 || rank > 64) {
      throw new Error('Invalid GGUF tensor rank');
    }
    const shape: number[] = [];
    for (let n = 0; n < rank; n++) {
      const dim = await u64();
      if (dim < 1) {
        throw new Error('Invalid GGUF dimension');
      }
      shape.push(dim);
    }
    const dtype = await u32();
    const tensorOffset = await u64();
    if (tensorOffset >= file.size) {
      throw new Error('GGUF tensor offset outside file');
    }
    const original = originalShapes.get(name);
    if (original) {
      const layout = ggufOriginalShapeLayout({ descriptorShape: shape, originalShape: original, dtype });
      originalRanges.push({ offset: BigInt(tensorOffset), bytes: layout.bytes });
      requiresGgufOriginalShapes ||= layout.changesGgmlShape;
    }
    // Comfy arrays already use PyTorch order; reverse only ordinary GGML ne.
    tensors.push({ name, shape: original ? [...original] : shape.reverse(), dtype: String(dtype) });
  }
  if (originalRanges.length) {
    if (alignmentType !== undefined && alignmentType !== 4) {
      throw new Error('Invalid GGUF alignment for original shape validation');
    }
    const descriptorEnd = offset;
    let alignment = 32;
    if (alignmentPosition !== undefined) {
      offset = alignmentPosition;
      alignment = await u32();
      offset = descriptorEnd;
    }
    if (alignment <= 0 || (BigInt(alignment) & (BigInt(alignment) - 1n)) !== 0n) {
      throw new Error('Invalid GGUF alignment for original shape validation');
    }
    const boundary = BigInt(alignment), dataStart = (BigInt(offset) + boundary - 1n) / boundary * boundary;
    for (const range of originalRanges) {
      if (range.offset % boundary !== 0n || dataStart + range.offset + range.bytes > BigInt(file.size)) {
        throw new Error('GGUF original shape tensor storage exceeds file bounds or alignment');
      }
    }
  }
  // Shared shard metadata may describe tensors in a different file. Unmatched
  // shapes have been checked for bounded syntax/product, but change no tensor.
  let split: WeightMetadata['split'];
  if (['split.no', 'split.count', 'split.tensors.count'].some(key => metadata.has(key))) {
    const index = metadata.get('split.no'), count = metadata.get('split.count'), total = metadata.get('split.tensors.count');
    if (typeof index !== 'number' || typeof count !== 'number' || typeof total !== 'number' || !Number.isInteger(index) || !Number.isInteger(count) || !Number.isSafeInteger(total) || index < 0 || count < 1 || count > 65535 || index >= count || total < tensorCount) {
      throw new Error('Invalid GGUF shard metadata');
    }
    split = { index, count, tensors: total };
  }
  return { format: 'gguf', metadata, tensors, split, unsupported: undefined, requiresGgufOriginalShapes };
}

async function inspectSafetensors({ file, headerSize, signal }: { file: ModelMetadataFile, headerSize: number, signal: AbortSignal | undefined }): Promise<WeightMetadata> {
  const bytes = await readModelRange({ file, offset: 8, length: headerSize, signal });
  if (bytes[0] !== 123) {
    throw new Error('Expected a safetensors JSON object');
  }
  const header = z.record(z.string(), z.unknown()).parse(parseModelJson({ text: decoder.decode(bytes) }));
  if (Object.keys(header).length > 100_000) {
    throw new Error('Safetensors tensor inspection limit reached');
  }
  const tensors: TensorInfo[] = [], ranges: [number, number][] = [];
  const metadata = new Map<string, string | number | boolean>();
  let unsupported: string | undefined;
  let metadataBytes = 0;
  for (const [name, entry] of Object.entries(header)) {
    signal?.throwIfAborted();
    if (name === '__metadata__') {
      for (const [key, value] of Object.entries(metadataRecord.parse(entry))) {
        metadata.set(key, value);
      }
      continue;
    }
    if (!name || name.includes('\0') || name.length > 4096) {
      throw new Error('Invalid safetensors tensor name');
    }
    const descriptor = tensorSchema.parse(entry);
    const [start, end] = descriptor.data_offsets;
    if (start > end || end > file.size - 8 - headerSize) {
      throw new Error('Safetensors tensor offset outside file');
    }
    const width = dtypeBytes[descriptor.dtype];
    if (width !== undefined) {
      const elements = descriptor.shape.reduce((total, dim) => total * BigInt(dim), 1n);
      if (elements * BigInt(width) !== BigInt(end - start)) {
        throw new Error('Safetensors shape/dtype/size mismatch');
      }
    } else {
      unsupported = `Unrecognized safetensors dtype: ${descriptor.dtype}`;
    }
    ranges.push([start, end]);
    tensors.push({ name, shape: descriptor.shape, dtype: descriptor.dtype });
    // This tiny metadata tensor is not a model weight. Plain I8 is not evidence
    // for convrot: inspect its declared quantization format instead.
    if (name.endsWith('.comfy_quant')) {
      if (descriptor.dtype !== 'U8' || end - start > 65536 || (metadataBytes += end - start) > 1024 * 1024) {
        throw new Error('Invalid quantization metadata');
      }
      const data = await readModelRange({ file, offset: 8 + headerSize + start, length: end - start, signal });
      const quant = z.object({ format: z.string(), convrot: z.boolean().optional() }).parse(parseModelJson({ text: decoder.decode(data) }));
      if (quant.format === 'int8_tensorwise') {
        unsupported = 'INT8 tensorwise/convrot is not supported by this bicore GGML build';
      }
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start !== cursor) {
      throw new Error('Overlap or hole in safetensors payload');
    }
    cursor = end;
  }
  if (cursor !== file.size - 8 - headerSize) {
    throw new Error('Unindexed safetensors payload');
  }
  return { format: 'safetensors', metadata, tensors, split: undefined, unsupported, requiresGgufOriginalShapes: false };
}

export async function inspectWeightFile({ file, signal }: { file: ModelMetadataFile, signal: AbortSignal | undefined }): Promise<Inspection> {
  signal?.throwIfAborted();
  try {
    if (!Number.isSafeInteger(file.size) || file.size < 8) {
      return { status: 'unknown', reason: 'Not a weight file' };
    }
    const prefix = await readModelRange({ file, offset: 0, length: Math.min(file.size, 256), signal });
    if (new TextDecoder().decode(prefix).startsWith('version https://git-lfs.github.com/spec/v1')) {
      return { status: 'lfs-pointer', reason: 'Git LFS pointer, not downloaded model weights' };
    }
    const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
    if (view.getUint32(0, true) === 0x46554747) {
      return { status: 'weights', value: await inspectGguf({ file, signal }) };
    }
    const size = view.getBigUint64(0, true);
    if (size < 2n || size > BigInt(file.size - 8) || prefix[8] !== 123) {
      return { status: 'unknown', reason: 'Unrecognized weight format' };
    }
    if (size > BigInt(MODEL_HEADER_LIMIT)) {
      throw new Error('Safetensors header exceeds the inspection budget');
    }
    return { status: 'weights', value: await inspectSafetensors({ file, headerSize: Number(size), signal }) };
  } catch (error) {
    signal?.throwIfAborted();
    return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function readModelJson({ file, signal }: { file: ModelMetadataFile, signal: AbortSignal | undefined }): Promise<unknown> {
  if (file.size > MODEL_HEADER_LIMIT) {
    throw new Error('Model JSON exceeds the inspection budget');
  }
  return parseModelJson({ text: decoder.decode(await readModelRange({ file, offset: 0, length: file.size, signal })) });
}

export const TEST_ONLY = {
};
