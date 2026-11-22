import { z } from 'zod';
import { awaitInspection } from './abort';
import { GGUF_EDITABLE_METADATA_KEYS } from './gguf-metadata-keys';
import { parseModelJson } from './json';

export { GGUF_EDITABLE_METADATA_KEYS };

// Limits bound inspection work, not the size of a model file or tensor payload.
export const MODEL_HEADER_LIMIT = 16 * 1024 * 1024;
const readBudget = 32 * 1024 * 1024;
const maxItems = 1_000_000;
const decoder = new TextDecoder('utf-8', { fatal: true });
const metadataValueDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const maxGgufDescriptorStringBytes = 4096;
const maxMetadataStringBytes = 1024 * 1024;
const maxMetadataValuesPerPage = 128;
const ggufMagic = 0x46554747;
const stringType = 8;
const arrayType = 9;
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
export type ModelMetadataValue = string | number | boolean;
export type ModelMetadataEntry = {
  key: string;
  type: string;
  value: ModelMetadataValue | undefined;
  count: number | undefined;
  elementType: string | undefined;
  /** The encoded value, including the uint64 length for strings. Arrays point past the array header. */
  range: { offset: number; length: number } | undefined;
  stringOffsets?: readonly number[];
};
export type ModelTensorDescriptor = {
  name: string;
  shape: number[];
  originalShape: number[] | undefined;
  dtype: string;
  dtypeCode: number | undefined;
  offset: number;
  byteLength: number | undefined;
};
export type ModelWeightDetails = {
  format: WeightMetadata['format'];
  version: number | undefined;
  alignment: number | undefined;
  dataOffset: number;
  metadata: readonly ModelMetadataEntry[];
  tensors: readonly ModelTensorDescriptor[];
  split: WeightMetadata['split'];
};
type InspectionFailure = Exclude<Inspection, { status: 'weights' }>;
export type ModelFileDetailsInspection = { status: 'weights', value: ModelWeightDetails } | InspectionFailure;
type GgufDescriptor = { name: string; shape: number[]; originalShape: number[] | undefined; dtype: number; relativeOffset: number };
type GgufDetails = {
  metadata: ModelMetadataEntry[];
  descriptors: GgufDescriptor[];
  version: number;
  alignment: number;
  metadataEnd: number;
  descriptorEnd: number;
  dataOffset: number;
};
const ggufValueTypes = ['uint8', 'int8', 'uint16', 'int16', 'uint32', 'int32', 'float32', 'bool', 'string', 'array', 'uint64', 'int64', 'float64'] as const;
const ggufValueSizes: readonly (number | undefined)[] = [1, 1, 2, 2, 4, 4, 4, 1, undefined, undefined, 8, 8, 8];
const stringIndexStep = 256;
const metadataRecord = z.record(z.string(), z.string());
const safeUnsigned = z.number().int().nonnegative().refine(Number.isSafeInteger);
const tensorSchema = z.object({ dtype: z.string().min(1).max(64), shape: z.array(safeUnsigned).max(64), data_offsets: z.tuple([safeUnsigned, safeUnsigned]) });
const dtypeBytes: Readonly<Record<string, number>> = { F64: 8, F32: 4, F16: 2, BF16: 2, I64: 8, I32: 4, I16: 2, I8: 1, U64: 8, U32: 4, U16: 2, U8: 1, BOOL: 1, F8_E4M3: 1, F8_E5M2: 1 };
// GGUF on-disk block layouts from ggml.h / ggml-common.h. Unknown types are
// never guessed.
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
// Serialized GGML dtype codes from the ggml_type enum. Removed types are omitted.
const ggufDtypeNames: Readonly<Record<number, string>> = {
  0: 'F32',
  1: 'F16',
  2: 'Q4_0',
  3: 'Q4_1',
  6: 'Q5_0',
  7: 'Q5_1',
  8: 'Q8_0',
  9: 'Q8_1',
  10: 'Q2_K',
  11: 'Q3_K',
  12: 'Q4_K',
  13: 'Q5_K',
  14: 'Q6_K',
  15: 'Q8_K',
  16: 'IQ2_XXS',
  17: 'IQ2_XS',
  18: 'IQ3_XXS',
  19: 'IQ1_S',
  20: 'IQ4_NL',
  21: 'IQ3_S',
  22: 'IQ2_S',
  23: 'IQ4_XS',
  24: 'I8',
  25: 'I16',
  26: 'I32',
  27: 'I64',
  28: 'F64',
  29: 'IQ1_M',
  30: 'BF16',
  34: 'TQ1_0',
  35: 'TQ2_0',
  39: 'MXFP4',
  40: 'NVFP4',
  41: 'Q1_0',
  42: 'Q2_0',
  43: 'F8_E4M3',
};

function readGgufScalar({ type, view }: { type: number, view: DataView }): ModelMetadataValue {
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

function createGgufReader({ file, start, end, signal }: { file: ModelMetadataFile, start: number, end: number, signal: AbortSignal | undefined }) {
  let offset = start, windowStart = 0, bytesRead = 0, items = 0;
  let window: Uint8Array<ArrayBuffer> = new Uint8Array(0);
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
  function seek({ position }: { position: number }): void {
    if (!Number.isSafeInteger(position) || position < start || position > end) {
      throw new Error('GGUF metadata outside file');
    }
    offset = position;
  }
  function skip({ bytes }: { bytes: number }): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > end - offset) {
      throw new Error('GGUF metadata outside file');
    }
    offset += bytes;
  }
  async function read({ bytes }: { bytes: number }): Promise<DataView<ArrayBuffer>> {
    signal?.throwIfAborted();
    if (bytes === 0) {
      return new DataView(new ArrayBuffer(0));
    }
    const position = offset;
    skip({ bytes });
    if (position < windowStart || offset > windowStart + window.length) {
      windowStart = position;
      const length = Math.min(end - position, Math.max(bytes, 64 * 1024));
      if ((bytesRead += length) > readBudget) {
        throw new Error('GGUF metadata inspection byte budget reached');
      }
      window = await readModelRange({ file, offset: position, length, signal });
    }
    return new DataView(window.buffer, window.byteOffset + position - windowStart, bytes);
  }
  async function u32(): Promise<number> {
    return (await read({ bytes: 4 })).getUint32(0, true);
  }
  async function u64(): Promise<number> {
    return checkedSize({ value: (await read({ bytes: 8 })).getBigUint64(0, true) });
  }
  async function readString({ mode }: { mode: 'descriptor' | 'metadata' | 'preview' | 'skip' }): Promise<string | undefined> {
    const bytes = await u64();
    switch (mode) {
    case 'skip':
      skip({ bytes });
      return undefined;
    case 'descriptor': {
      if (bytes > maxGgufDescriptorStringBytes) {
        throw new Error('GGUF descriptor string is too large to inspect');
      }
      const result = decoder.decode(await read({ bytes }));
      if (result.includes('\0')) {
        throw new Error('NUL in GGUF descriptor');
      }
      return result;
    }
    case 'metadata':
      if (bytes > maxMetadataStringBytes) {
        throw new Error('GGUF metadata string exceeds the display budget');
      }
      return metadataValueDecoder.decode(await read({ bytes }));
    case 'preview':
      if (bytes > maxGgufDescriptorStringBytes) {
        skip({ bytes });
        return undefined;
      }
      return metadataValueDecoder.decode(await read({ bytes }));
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unsupported GGUF string mode: ${exhaustive}`);
    }
    }
  }
  return { position: () => offset, checkpoint, read, seek, skip, u32, u64, readString };
}

function alignGgufOffset({ offset, alignment }: { offset: number, alignment: number }): number {
  const boundary = BigInt(alignment);
  return checkedSize({ value: (BigInt(offset) + boundary - 1n) / boundary * boundary });
}

async function inspectGguf({ file, signal, details }: { file: ModelMetadataFile, signal: AbortSignal | undefined, details: GgufDetails | undefined }): Promise<WeightMetadata> {
  const reader = createGgufReader({ file, start: 0, end: file.size, signal });
  const metadata = new Map<string, ModelMetadataValue>();
  const keys = new Set<string>();
  const originalShapes = new Map<string, number[]>();
  let alignmentPosition: number | undefined;
  let alignmentType: number | undefined;

  async function value({ type, retain }: { type: number, retain: boolean }): Promise<ModelMetadataValue | undefined> {
    await reader.checkpoint();
    if (type === stringType) {
      if (!retain) {
        return reader.readString({ mode: 'skip' });
      }
      return reader.readString({ mode: details ? 'preview' : 'descriptor' });
    }
    const bytes = ggufValueSizes[type];
    if (bytes === undefined) {
      throw new Error('Unknown GGUF metadata type');
    }
    if (!retain) {
      reader.skip({ bytes });
      return undefined;
    }
    return readGgufScalar({ type, view: await reader.read({ bytes }) });
  }

  async function readArray({ captureOffsets }: { captureOffsets: boolean }) {
    await reader.checkpoint();
    const element = await reader.u32(), count = await reader.u64();
    const payloadOffset = reader.position();
    const size = ggufValueSizes[element];
    if (size !== undefined) {
      reader.skip({ bytes: count * size });
      return { element, count, payloadOffset, stringOffsets: undefined };
    }
    if (element !== stringType || count > maxItems) {
      throw new Error('Unsupported GGUF array');
    }
    const stringOffsets: number[] | undefined = captureOffsets && count > stringIndexStep ? [] : undefined;
    for (let i = 0; i < count; i++) {
      await reader.checkpoint();
      if (i % stringIndexStep === 0) {
        stringOffsets?.push(reader.position());
      }
      await reader.readString({ mode: 'skip' });
    }
    return { element, count, payloadOffset, stringOffsets };
  }

  async function originalShape({ type }: { type: number }): Promise<{ shape: number[], element: number, payloadOffset: number }> {
    if (type !== arrayType) {
      throw new Error('GGUF original shape must be an integer array');
    }
    const element = await reader.u32(), count = await reader.u64();
    if (count < 1 || count > 4 || ![0, 1, 2, 3, 4, 5, 10, 11].includes(element)) {
      throw new Error('Invalid GGUF original shape array type or rank');
    }
    const payloadOffset = reader.position();
    const shape: number[] = [];
    let elements = 1n;
    for (let i = 0; i < count; i++) {
      const dimension = await value({ type: element, retain: true });
      if (typeof dimension !== 'number' || !Number.isSafeInteger(dimension) || dimension <= 0 || (elements *= BigInt(dimension)) > maxGgmlElements) {
        throw new Error('Invalid GGUF original shape dimension or element count');
      }
      shape.push(dimension);
    }
    return { shape, element, payloadOffset };
  }

  const magic = await reader.u32(), version = await reader.u32();
  if (magic !== ggufMagic || ![2, 3].includes(version)) {
    throw new Error('Expected little-endian GGUF v2/v3');
  }
  const tensorCount = await reader.u64(), metadataCount = await reader.u64();
  if (tensorCount > 100_000 || metadataCount > maxItems) {
    throw new Error('GGUF table inspection limit reached');
  }
  for (let i = 0; i < metadataCount; i++) {
    const key = await reader.readString({ mode: 'descriptor' });
    if (!key || keys.has(key)) {
      throw new Error('Duplicate or empty GGUF metadata key');
    }
    keys.add(key);
    const type = await reader.u32();
    const valueOffset = reader.position();
    let payloadOffset = valueOffset;
    let item: ModelMetadataValue | undefined;
    let elementType: string | undefined;
    let count: number | undefined;
    let stringOffsets: readonly number[] | undefined;
    if (key.startsWith(originalShapePrefix)) {
      const name = key.slice(originalShapePrefix.length);
      if (!name || originalShapes.size >= 100_000) {
        throw new Error('Empty GGUF original shape tensor name or inspection limit reached');
      }
      const original = await originalShape({ type });
      originalShapes.set(name, original.shape);
      count = original.shape.length;
      elementType = ggufValueTypes[original.element];
      payloadOffset = original.payloadOffset;
    } else {
      const isAlignment = key === 'general.alignment';
      if (isAlignment) {
        alignmentType = type;
        alignmentPosition = valueOffset;
      }
      if (type === arrayType) {
        const array = await readArray({ captureOffsets: details !== undefined });
        payloadOffset = array.payloadOffset;
        elementType = ggufValueTypes[array.element];
        count = array.count;
        stringOffsets = array.stringOffsets;
      } else {
        const retain = !isAlignment && /^(general\.(architecture|name|basename|finetune)|split\.|qwen[\w.]*\.(embedding_length|block_count)|clip\.)/.test(key);
        item = await value({ type, retain: retain || (details !== undefined && type !== stringType) });
        if (retain && item !== undefined) {
          metadata.set(key, item);
        }
      }
    }
    if (details) {
      const typeName = ggufValueTypes[type];
      if (typeName === undefined) {
        throw new Error('Unknown GGUF metadata type');
      }
      details.metadata.push({
        key,
        type: typeName,
        value: item,
        count,
        elementType,
        range: { offset: payloadOffset, length: reader.position() - payloadOffset },
        ...(stringOffsets === undefined ? {} : { stringOffsets }),
      });
    }
  }
  const metadataEnd = reader.position();
  const tensors: TensorInfo[] = [], names = new Set<string>();
  const originalRanges: { offset: bigint, bytes: bigint }[] = [];
  let requiresGgufOriginalShapes = false;
  for (let i = 0; i < tensorCount; i++) {
    await reader.checkpoint();
    const name = await reader.readString({ mode: 'descriptor' });
    if (!name || names.has(name)) {
      throw new Error('Duplicate or empty GGUF tensor name');
    }
    names.add(name);
    const rank = await reader.u32();
    if (rank === 0 || rank > 64) {
      throw new Error('Invalid GGUF tensor rank');
    }
    const shape: number[] = [];
    for (let n = 0; n < rank; n++) {
      const dim = await reader.u64();
      if (dim < 1) {
        throw new Error('Invalid GGUF dimension');
      }
      shape.push(dim);
    }
    const dtype = await reader.u32();
    const tensorOffset = await reader.u64();
    if (tensorOffset >= file.size) {
      throw new Error('GGUF tensor offset outside file');
    }
    const original = originalShapes.get(name);
    if (original) {
      const layout = ggufOriginalShapeLayout({ descriptorShape: shape, originalShape: original, dtype });
      originalRanges.push({ offset: BigInt(tensorOffset), bytes: layout.bytes });
      requiresGgufOriginalShapes ||= layout.changesGgmlShape;
    }
    if (details) {
      details.descriptors.push({ name, shape, originalShape: original, dtype, relativeOffset: tensorOffset });
    } else {
      // Comfy arrays already use PyTorch order; reverse only ordinary GGML ne.
      tensors.push({ name, shape: original ? [...original] : shape.reverse(), dtype: String(dtype) });
    }
  }
  if (originalRanges.length || details) {
    if (alignmentType !== undefined && alignmentType !== 4) {
      throw new Error('Invalid GGUF alignment');
    }
    const descriptorEnd = reader.position();
    let alignment = 32;
    if (alignmentPosition !== undefined) {
      reader.seek({ position: alignmentPosition });
      alignment = await reader.u32();
    }
    if (alignment <= 0 || (BigInt(alignment) & (BigInt(alignment) - 1n)) !== 0n) {
      throw new Error('Invalid GGUF alignment');
    }
    const dataOffset = tensorCount === 0 ? descriptorEnd : alignGgufOffset({ offset: descriptorEnd, alignment });
    for (const range of originalRanges) {
      if (range.offset % BigInt(alignment) !== 0n || BigInt(dataOffset) + range.offset + range.bytes > BigInt(file.size)) {
        throw new Error('GGUF original shape tensor storage exceeds file bounds or alignment');
      }
    }
    if (details) {
      if (dataOffset > file.size) {
        throw new Error('GGUF tensor data starts outside the file');
      }
      details.version = version;
      details.alignment = alignment;
      details.metadataEnd = metadataEnd;
      details.descriptorEnd = descriptorEnd;
      details.dataOffset = dataOffset;
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

async function inspectSafetensors({ file, headerSize, signal, descriptors }: { file: ModelMetadataFile, headerSize: number, signal: AbortSignal | undefined, descriptors: ModelTensorDescriptor[] | undefined }): Promise<WeightMetadata> {
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
    if (descriptors === undefined) {
      tensors.push({ name, shape: descriptor.shape, dtype: descriptor.dtype });
    } else {
      descriptors.push({
        name,
        shape: descriptor.shape,
        originalShape: undefined,
        dtype: descriptor.dtype,
        dtypeCode: undefined,
        offset: 8 + headerSize + start,
        byteLength: end - start,
      });
    }
    // This tiny metadata tensor is not a model weight. Plain I8 is not evidence
    // for convrot: inspect its declared quantization format instead.
    if (descriptors === undefined && name.endsWith('.comfy_quant')) {
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

type WeightFileFormat = { status: 'gguf' } | { status: 'safetensors', headerSize: number } | InspectionFailure;

async function identifyWeightFile({ file, signal }: { file: ModelMetadataFile, signal: AbortSignal | undefined }): Promise<WeightFileFormat> {
  if (!Number.isSafeInteger(file.size) || file.size < 8) {
    return { status: 'unknown', reason: 'Not a weight file' };
  }
  const prefix = await readModelRange({ file, offset: 0, length: 8, signal });
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  if (view.getUint32(0, true) === ggufMagic) {
    return { status: 'gguf' };
  }
  const prefixDecoder = new TextDecoder();
  if (prefixDecoder.decode(prefix).startsWith('versi')) {
    const pointerPrefix = 'version https://git-lfs.github.com/spec/v1';
    const pointer = await readModelRange({ file, offset: 0, length: Math.min(file.size, pointerPrefix.length + 3), signal });
    if (prefixDecoder.decode(pointer).startsWith(pointerPrefix)) {
      return { status: 'lfs-pointer', reason: 'Git LFS pointer, not downloaded model weights' };
    }
  }
  const size = view.getBigUint64(0, true);
  if (size < 2n || size > BigInt(file.size - 8) ||
      (await readModelRange({ file, offset: 8, length: 1, signal }))[0] !== 123) {
    return { status: 'unknown', reason: 'Unrecognized weight format' };
  }
  if (size > BigInt(MODEL_HEADER_LIMIT)) {
    throw new Error('Safetensors header exceeds the inspection budget');
  }
  return { status: 'safetensors', headerSize: Number(size) };
}

export async function inspectWeightFile({ file, signal }: { file: ModelMetadataFile, signal: AbortSignal | undefined }): Promise<Inspection> {
  signal?.throwIfAborted();
  try {
    const format = await identifyWeightFile({ file, signal });
    switch (format.status) {
    case 'gguf':
      return { status: 'weights', value: await inspectGguf({ file, signal, details: undefined }) };
    case 'safetensors':
      return { status: 'weights', value: await inspectSafetensors({ file, headerSize: format.headerSize, signal, descriptors: undefined }) };
    case 'unknown': case 'invalid': case 'lfs-pointer':
      return format;
    default: {
      const exhaustive: never = format;
      throw new Error(`Unsupported weight format: ${exhaustive}`);
    }
    }
  } catch (error) {
    signal?.throwIfAborted();
    return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
}

function createGgufDetails(): GgufDetails {
  return { metadata: [], descriptors: [], version: 0, alignment: 32, metadataEnd: 0, descriptorEnd: 0, dataOffset: 0 };
}

function getGgufTensorDescriptors({ file, details }: { file: ModelMetadataFile, details: GgufDetails }): ModelTensorDescriptor[] {
  const tensors = details.descriptors.map(({ name, shape, originalShape, dtype, relativeOffset }) => {
    if (relativeOffset % details.alignment !== 0 || relativeOffset >= file.size - details.dataOffset) {
      throw new Error('GGUF tensor offset outside file or unaligned');
    }
    let byteLength: number | undefined;
    const block = dtype === 43 ? [1, 1] as const : ggufBlocks[dtype];
    if (block !== undefined) {
      const [blockElements, blockBytes] = block;
      if (shape[0]! % blockElements !== 0) {
        throw new Error('GGUF tensor dimension violates quantization row block alignment');
      }
      const elements = shape.reduce((total, dimension) => total * BigInt(dimension), 1n);
      byteLength = checkedSize({ value: elements / BigInt(blockElements) * BigInt(blockBytes) });
    }
    const offset = details.dataOffset + relativeOffset;
    if (byteLength !== undefined && byteLength > file.size - offset) {
      throw new Error('GGUF tensor data exceeds file bounds');
    }
    return { name, shape, originalShape, dtype: ggufDtypeNames[dtype] ?? String(dtype), dtypeCode: dtype, offset, byteLength };
  });
  let previousEnd = details.dataOffset;
  for (const tensor of [...tensors].sort((left, right) => left.offset - right.offset)) {
    if (tensor.offset < previousEnd) {
      throw new Error('Overlapping GGUF tensor data');
    }
    previousEnd = tensor.offset + (tensor.byteLength ?? 0);
  }
  return tensors;
}

/** Inspect a model for browsing without opening an inference runtime or reading any Safetensors payload. */
export async function inspectModelFileDetails({ file, signal }: { file: ModelMetadataFile, signal: AbortSignal | undefined }): Promise<ModelFileDetailsInspection> {
  signal?.throwIfAborted();
  try {
    const format = await identifyWeightFile({ file, signal });
    switch (format.status) {
    case 'gguf': {
      const details = createGgufDetails();
      const summary = await inspectGguf({ file, signal, details });
      return {
        status: 'weights',
        value: {
          format: 'gguf',
          version: details.version,
          alignment: details.alignment,
          dataOffset: details.dataOffset,
          metadata: details.metadata,
          split: summary.split,
          tensors: getGgufTensorDescriptors({ file, details }),
        },
      };
    }
    case 'safetensors': {
      const tensors: ModelTensorDescriptor[] = [];
      const summary = await inspectSafetensors({ file, headerSize: format.headerSize, signal, descriptors: tensors });
      return {
        status: 'weights',
        value: {
          format: 'safetensors',
          version: undefined,
          alignment: undefined,
          dataOffset: 8 + format.headerSize,
          split: undefined,
          tensors,
          metadata: Array.from(summary.metadata, ([key, value]) => ({
            key,
            type: 'string',
            value,
            range: undefined,
            count: undefined,
            elementType: undefined,
          })),
        },
      };
    }
    case 'unknown': case 'invalid': case 'lfs-pointer':
      return format;
    default: {
      const exhaustive: never = format;
      throw new Error(`Unsupported weight format: ${exhaustive}`);
    }
    }
  } catch (error) {
    signal?.throwIfAborted();
    return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Read one deferred scalar or a bounded page of array elements from the inspected snapshot. */
export async function readModelMetadataValue({ file, entry, start, limit, signal }: { file: ModelMetadataFile, entry: ModelMetadataEntry, start: number, limit: number, signal: AbortSignal | undefined }): Promise<{ values: ModelMetadataValue[], next: number | undefined }> {
  signal?.throwIfAborted();
  const count = entry.count ?? 1;
  if (!Number.isSafeInteger(start) || start < 0 || start > count || !Number.isSafeInteger(limit) || limit < 1 || limit > maxMetadataValuesPerPage) {
    throw new Error('Invalid metadata value page');
  }
  if (start === count) {
    return { values: [], next: undefined };
  }
  if (entry.value !== undefined) {
    return { values: [entry.value], next: undefined };
  }
  const range = entry.range;
  if (range === undefined || !Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || range.offset < 0 || range.length < 0 || range.length > file.size - range.offset) {
    throw new Error('Invalid GGUF metadata range');
  }
  const reader = createGgufReader({ file, start: range.offset, end: range.offset + range.length, signal });
  const type = ggufValueTypes.findIndex(name => name === (entry.elementType ?? entry.type));
  const until = Math.min(count, start + limit);
  const values: ModelMetadataValue[] = [];
  if (type === stringType) {
    const block = Math.floor(start / stringIndexStep);
    const indexOffset = entry.stringOffsets?.[block];
    let index = 0;
    if (indexOffset !== undefined) {
      reader.seek({ position: indexOffset });
      index = block * stringIndexStep;
    }
    for (; index < start; index++) {
      await reader.checkpoint();
      await reader.readString({ mode: 'skip' });
    }
    const pageOffset = reader.position();
    for (; index < until; index++) {
      const value = await reader.readString({ mode: 'metadata' });
      if (values.length > 0 && reader.position() - pageOffset > maxMetadataStringBytes) {
        break;
      }
      values.push(value!);
    }
    return { values, next: index < count ? index : undefined };
  }
  const bytes = ggufValueSizes[type];
  if (bytes === undefined) {
    throw new Error('Unsupported metadata page value type');
  }
  reader.seek({ position: range.offset + start * bytes });
  const view = await reader.read({ bytes: (until - start) * bytes });
  for (let index = 0; index < until - start; index++) {
    values.push(readGgufScalar({ type, view: new DataView(view.buffer, view.byteOffset + index * bytes, bytes) }));
  }
  return { values, next: until < count ? until : undefined };
}

function encodeGgufString({ text, maxBytes }: { text: string, maxBytes: number }): Uint8Array<ArrayBuffer> {
  if (text.length > maxBytes || text.includes('\0')) {
    throw new Error('Invalid text for a GGUF metadata value');
  }
  const encoded = new TextEncoder().encode(text);
  if (encoded.length > maxBytes || metadataValueDecoder.decode(encoded) !== text) {
    throw new Error('GGUF metadata string is too large or is not valid Unicode');
  }
  const output = new Uint8Array(8 + encoded.length);
  new DataView(output.buffer).setBigUint64(0, BigInt(encoded.length), true);
  output.set(encoded, 8);
  return output;
}

type GgufRewriteEdit = { offset: number, length: number, bytes: Uint8Array<ArrayBuffer> };

/** Build an aligned header for an unchanged tensor body beginning at bodyOffset in the source. */
export async function prepareGgufMetadataRewrite({ file, changes, signal }: { file: ModelMetadataFile, changes: Readonly<Record<string, string>>, signal: AbortSignal | undefined }): Promise<{ header: Uint8Array<ArrayBuffer>, bodyOffset: number }> {
  signal?.throwIfAborted();
  const details = createGgufDetails();
  await inspectGguf({ file, signal, details });
  // Refuse to rewrite a file with invalid tensor descriptors, including known
  // byte ranges that extend beyond the captured input snapshot.
  getGgufTensorDescriptors({ file, details });
  const edits: GgufRewriteEdit[] = [];
  let metadataCount = details.metadata.length;
  for (const [key, value] of Object.entries(changes)) {
    if (!GGUF_EDITABLE_METADATA_KEYS.some(editable => editable === key) || typeof value !== 'string') {
      throw new Error('Unsupported GGUF metadata edit');
    }
    // Model inference inspection expects general.name to fit its descriptor budget.
    const maxBytes = key === 'general.name' ? maxGgufDescriptorStringBytes : maxMetadataStringBytes;
    const nextValue = encodeGgufString({ text: value, maxBytes });
    const existing = details.metadata.find(item => item.key === key);
    if (existing) {
      if (existing.type !== 'string' || existing.range === undefined) {
        throw new Error('Editable GGUF metadata is not a string');
      }
      edits.push({ ...existing.range, bytes: nextValue });
      continue;
    }
    const encodedKey = encodeGgufString({ text: key, maxBytes: maxGgufDescriptorStringBytes });
    const bytes = new Uint8Array(encodedKey.length + 4 + nextValue.length);
    bytes.set(encodedKey);
    new DataView(bytes.buffer).setUint32(encodedKey.length, stringType, true);
    bytes.set(nextValue, encodedKey.length + 4);
    edits.push({ offset: details.metadataEnd, length: 0, bytes });
    metadataCount++;
  }
  if (metadataCount > maxItems) {
    throw new Error('GGUF metadata count exceeds the inspection budget');
  }
  const descriptorEnd = edits.reduce((offset, edit) => offset + edit.bytes.length - edit.length, details.descriptorEnd);
  const headerLength = details.descriptors.length === 0 ? descriptorEnd : alignGgufOffset({ offset: descriptorEnd, alignment: details.alignment });
  if (headerLength > MODEL_HEADER_LIMIT || !Number.isSafeInteger(headerLength + (file.size - details.dataOffset))) {
    throw new Error('Rewritten GGUF header exceeds the inspection budget');
  }
  const header = new Uint8Array(headerLength);
  let sourceOffset = 0, outputOffset = 0;
  async function copyThrough({ offset }: { offset: number }): Promise<void> {
    const length = offset - sourceOffset;
    if (length > 0) {
      header.set(await readModelRange({ file, offset: sourceOffset, length, signal }), outputOffset);
      sourceOffset = offset;
      outputOffset += length;
    }
  }
  for (const edit of edits.sort((left, right) => left.offset - right.offset)) {
    await copyThrough({ offset: edit.offset });
    header.set(edit.bytes, outputOffset);
    sourceOffset += edit.length;
    outputOffset += edit.bytes.length;
  }
  await copyThrough({ offset: details.descriptorEnd });
  signal?.throwIfAborted();
  new DataView(header.buffer).setBigUint64(16, BigInt(metadataCount), true);
  return { header, bodyOffset: details.dataOffset };
}

export async function readModelJson({ file, signal }: { file: ModelMetadataFile, signal: AbortSignal | undefined }): Promise<unknown> {
  if (file.size > MODEL_HEADER_LIMIT) {
    throw new Error('Model JSON exceeds the inspection budget');
  }
  return parseModelJson({ text: decoder.decode(await readModelRange({ file, offset: 0, length: file.size, signal })) });
}

export const TEST_ONLY = {
};
