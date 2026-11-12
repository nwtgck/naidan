import { modelGraphTensorBytes, type ModelGraphInventory, type ModelGraphTensorInfo } from './compile';
import { graphWeightTypes, graphStorageFormats } from './tensor-layout';
import type { GraphMetadataValue } from './expressions';

export type ModelGraphByteSource = {
  size: number,
  read: ({ offset, destination }: { offset: number, destination: Uint8Array }) => number,
};
export type ModelGraphGguf = {
  source: ModelGraphByteSource,
  inventory: ModelGraphInventory,
  tensorOffsets: ReadonlyMap<string, number>,
  metadataEnd: number,
  alignment: number,
};
const maximumHeaderBytes = 128 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const tensorTypes = new Map(graphWeightTypes.map(type => [graphStorageFormats[type].code, type]));

export function readModelGraphBytes({ source, offset, destination, signal }: { source: ModelGraphByteSource, offset: number, destination: Uint8Array, signal: AbortSignal | undefined }): void {
  if (!Number.isSafeInteger(source.size) || source.size < 0 || !Number.isSafeInteger(offset) || offset < 0 || offset > source.size || destination.length > source.size - offset) {
    throw new Error('Model file range is out of bounds');
  }
  let done = 0;
  while (done < destination.length) {
    signal?.throwIfAborted();
    const part = destination.subarray(done, Math.min(destination.length, done + 1024 * 1024));
    const count = source.read({ offset: offset + done, destination: part });
    if (!Number.isInteger(count) || count <= 0 || count > part.length) {
      throw new Error('Model file was truncated or changed while reading');
    }
    done += count;
  }
}

class HeaderReader {
  offset = 0;
  private start = -1;
  private buffer = new Uint8Array(0);
  private retainedItems = 0;
  private retainedBytes = 0;

  private readonly options: { source: ModelGraphByteSource, signal: AbortSignal | undefined };

  constructor({ source, signal }: { source: ModelGraphByteSource, signal: AbortSignal | undefined }) {
    this.options = { source, signal };
  }

  private check({ count }: { count: number }): void {
    this.options.signal?.throwIfAborted();
    if (!Number.isSafeInteger(count) || count < 0 || count > Math.min(maximumHeaderBytes, this.options.source.size) - this.offset) {
      throw new Error('Invalid or oversized GGUF header');
    }
  }

  skip({ count }: { count: number }): void {
    this.check({ count });
    this.offset += count;
  }

  bytes({ count }: { count: number }): Uint8Array {
    this.check({ count });
    if (this.offset < this.start || this.offset + count > this.start + this.buffer.length) {
      this.start = this.offset;
      this.buffer = new Uint8Array(Math.min(Math.max(65536, count), maximumHeaderBytes - this.offset, this.options.source.size - this.offset));
      readModelGraphBytes({ ...this.options, offset: this.start, destination: this.buffer });
    }
    const result = this.buffer.subarray(this.offset - this.start, this.offset - this.start + count);
    this.offset += count;
    return result;
  }

  view({ count }: { count: number }): DataView {
    const bytes = this.bytes({ count });
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u32(): number {
    return this.view({ count: 4 }).getUint32(0, true);
  }

  u64(): number {
    const value = this.view({ count: 8 }).getBigUint64(0, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Unsafe GGUF integer');
    }
    return Number(value);
  }

  string({ retain }: { retain: boolean }): string {
    const length = this.u64();
    if (length > 8 * 1024 * 1024) {
      throw new Error('GGUF string is too large');
    }
    if (!retain) {
      this.skip({ count: length });
      return '';
    }
    return decoder.decode(this.bytes({ count: length }));
  }

  scalar({ type }: { type: number }): string | number | boolean {
    switch (type) {
    case 0: return this.view({ count: 1 }).getUint8(0);
    case 1: return this.view({ count: 1 }).getInt8(0);
    case 2: return this.view({ count: 2 }).getUint16(0, true);
    case 3: return this.view({ count: 2 }).getInt16(0, true);
    case 4: return this.u32();
    case 5: return this.view({ count: 4 }).getInt32(0, true);
    case 6: return this.view({ count: 4 }).getFloat32(0, true);
    case 7: {
      const value = this.view({ count: 1 }).getUint8(0);
      if (value > 1) {
        throw new Error('Invalid GGUF boolean');
      }
      return value === 1;
    }
    case 8: return this.string({ retain: true });
    case 10: return this.u64();
    case 11: {
      const value = this.view({ count: 8 }).getBigInt64(0, true);
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new Error('Unsafe GGUF integer');
      }
      return Number(value);
    }
    case 12: return this.view({ count: 8 }).getFloat64(0, true);
    default: throw new Error(`Unsupported GGUF metadata type: ${type}`);
    }
  }

  array({ retain }: { retain: boolean }): { type: number, length: number, values: readonly (string | number | boolean)[] | undefined } {
    const type = this.u32(), length = this.u64();
    // Validate the tag even for an empty retained array; a zero element count
    // must not let unknown/native-unsafe metadata reach the GGUF parser.
    if (type === 9 || type > 12) {
      throw new Error('Nested or unknown GGUF array type');
    }
    if (length > 4 * 1024 * 1024) {
      throw new Error('GGUF metadata array exceeds the limit');
    }
    if (retain) {
      if (length > 65536 || this.retainedItems + length > 65536 || type === 9) {
        throw new Error('Retained GGUF metadata array budget exceeded');
      }
      this.retainedItems += length;
      const values: (string | number | boolean)[] = [];
      for (let index = 0; index < length; index++) {
        const value = this.scalar({ type });
        if (typeof value === 'number' && !Number.isFinite(value)) {
          throw new Error('Non-finite GGUF array metadata');
        }
        this.retainedBytes += typeof value === 'string' ? new TextEncoder().encode(value).length : 8;
        if (this.retainedBytes > 1024 * 1024) {
          throw new Error('Retained GGUF metadata byte budget exceeded');
        }
        values.push(value);
      }
      return { type, length, values };
    }
    if (type === 8) {
      for (let index = 0; index < length; index++) {
        this.string({ retain: false });
      }
    } else {
      const width = new Map([[0, 1], [1, 1], [2, 2], [3, 2], [4, 4], [5, 4], [6, 4], [7, 1], [10, 8], [11, 8], [12, 8]]).get(type);
      if (!width) {
        throw new Error('Nested or unknown GGUF array type');
      }
      this.skip({ count: width * length });
    }
    return { type, length, values: undefined };
  }
}

/** Routing reads only through the architecture key, not tensor payloads or
 * descriptors. Unrelated native models retain their native format support. */
export function readModelGraphArchitecture({ source, signal }: { source: ModelGraphByteSource, signal: AbortSignal | undefined }): string {
  const reader = new HeaderReader({ source, signal });
  if (reader.u32() !== 0x46554747 || ![2, 3].includes(reader.u32())) {
    throw new Error('Expected a little-endian GGUF v2 or v3 model');
  }
  reader.u64();
  const count = reader.u64();
  if (count > 32768) {
    throw new Error('GGUF metadata count exceeds the limit');
  }
  const seen = new Set<string>();
  for (let index = 0; index < count; index++) {
    const key = reader.string({ retain: true }), type = reader.u32();
    if (!key || key.length > 1024 || seen.has(key)) {
      throw new Error('Invalid GGUF routing metadata');
    }
    seen.add(key);
    if (type === 9) {
      reader.array({ retain: false });
      continue;
    }
    const value = reader.scalar({ type });
    if (key === 'general.architecture') {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value)) {
        throw new Error('Invalid GGUF architecture');
      }
      return value;
    }
  }
  throw new Error('Missing GGUF architecture');
}

/** Read tensor descriptors, never tensor payloads. No architecture-name aliasing
 * or llama_model construction is needed for this bounded container reader. */
export function inspectModelGraphGguf({ source, signal }: { source: ModelGraphByteSource, signal: AbortSignal | undefined }): ModelGraphGguf {
  const reader = new HeaderReader({ source, signal });
  if (reader.u32() !== 0x46554747 || ![2, 3].includes(reader.u32())) {
    throw new Error('Expected a little-endian GGUF v2 or v3 model');
  }
  const count = reader.u64(), keyCount = reader.u64();
  if (count > 65536 || keyCount > 32768) {
    throw new Error('GGUF descriptor count exceeds the limit');
  }
  const keys = new Set<string>(), metadata = new Map<string, GraphMetadataValue>();
  let vocabularySize = 0;
  for (let index = 0; index < keyCount; index++) {
    const key = reader.string({ retain: true });
    if (!key || key.length > 1024 || key.includes('\0') || keys.has(key)) {
      throw new Error('Duplicate or invalid GGUF metadata key');
    }
    keys.add(key);
    const type = reader.u32();
    if (type === 9) {
      const array = reader.array({ retain: !key.startsWith('tokenizer.') });
      if (array.values !== undefined) {
        metadata.set(key, array.values);
      }
      if (key === 'tokenizer.ggml.tokens') {
        if (array.type !== 8 || array.length > 1048576) {
          throw new Error('Unsupported GGUF vocabulary');
        }
        vocabularySize = array.length;
      }
    } else {
      const value = reader.scalar({ type });
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new Error('Non-finite GGUF scalar metadata');
      }
      metadata.set(key, value);
    }
  }
  const metadataEnd = reader.offset;
  const architecture = metadata.get('general.architecture');
  if (typeof architecture !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(architecture)) {
    throw new Error('Missing or invalid GGUF architecture');
  }
  const alignment = metadata.get('general.alignment') ?? 32;
  if (typeof alignment !== 'number' || !Number.isInteger(alignment) || alignment < 1 || alignment > 1048576 || (alignment & (alignment - 1)) !== 0) {
    throw new Error('Invalid GGUF alignment');
  }
  const tensors = new Map<string, ModelGraphTensorInfo>(), relativeOffsets = new Map<string, number>();
  for (let index = 0; index < count; index++) {
    const name = reader.string({ retain: true }), rank = reader.u32();
    if (!name || name.length > 256 || name.includes('\0') || tensors.has(name) || rank < 1 || rank > 4) {
      throw new Error('Invalid or duplicate GGUF tensor');
    }
    const shape: number[] = [];
    for (let dim = 0; dim < rank; dim++) {
      shape.push(reader.u64());
    }
    const type = tensorTypes.get(reader.u32());
    if (!type) {
      throw new Error(`The registered graph reader does not support the tensor encoding of ${name}`);
    }
    const offset = reader.u64();
    if (offset % alignment !== 0) {
      throw new Error('Unaligned GGUF tensor offset');
    }
    tensors.set(name, { name, shape, type, bytes: modelGraphTensorBytes({ shape, type }) });
    relativeOffsets.set(name, offset);
  }
  const dataStart = Math.ceil(reader.offset / alignment) * alignment;
  const ranges = [...tensors.values()].map(tensor => {
    const start = dataStart + relativeOffsets.get(tensor.name)!;
    const end = start + tensor.bytes;
    if (!Number.isSafeInteger(end) || start < dataStart || end > source.size) {
      throw new Error('GGUF tensor extends beyond the file');
    }
    return { name: tensor.name, start, end };
  }).sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index]!.start < ranges[index - 1]!.end) {
      throw new Error('Overlapping GGUF tensors');
    }
  }
  return { source, inventory: { architecture, metadata, tensors, vocabularySize }, tensorOffsets: new Map(ranges.map(range => [range.name, range.start])), metadataEnd, alignment };
}

/** A metadata-only GGUF is passed to the native vocabulary loader. Tensor
 * descriptors and multi-gigabyte weights are deliberately absent from this copy. */
export function copyModelGraphVocabularyMetadata({ gguf, signal }: { gguf: ModelGraphGguf, signal: AbortSignal | undefined }): Uint8Array {
  if (!gguf.inventory.vocabularySize) {
    throw new Error('The primary GGUF file has no tokenizer vocabulary');
  }
  const bytes = new Uint8Array(Math.ceil(gguf.metadataEnd / gguf.alignment) * gguf.alignment);
  readModelGraphBytes({ source: gguf.source, offset: 0, destination: bytes.subarray(0, gguf.metadataEnd), signal });
  new DataView(bytes.buffer).setBigUint64(8, 0n, true);
  return bytes;
}

export function combineModelGraphGgufs({ files }: { files: readonly ModelGraphGguf[] }): { inventory: ModelGraphInventory, locations: ReadonlyMap<string, { source: ModelGraphByteSource, offset: number }> } {
  const first = files[0];
  if (!first || !first.inventory.vocabularySize) {
    throw new Error('The primary model file must contain its vocabulary');
  }
  const locations = new Map<string, { source: ModelGraphByteSource, offset: number }>(), tensors = new Map<string, ModelGraphTensorInfo>();
  const splitCount = first.inventory.metadata.get('split.count');
  if (files.length > 1 && splitCount !== files.length || files.length === 1 && typeof splitCount === 'number' && splitCount > 1) {
    throw new Error('Incomplete GGUF split model');
  }
  const splitIds = new Set<number>();
  for (const file of files) {
    if (file.inventory.architecture !== first.inventory.architecture) {
      throw new Error('Mixed GGUF architectures');
    }
    if (files.length > 1) {
      const id = file.inventory.metadata.get('split.no');
      if (file.inventory.metadata.get('split.count') !== files.length || typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= files.length || splitIds.has(id)) {
        throw new Error('Invalid GGUF split set');
      }
      splitIds.add(id);
    }
    for (const [name, tensor] of file.inventory.tensors) {
      if (tensors.has(name)) {
        throw new Error(`Duplicate tensor across GGUF shards: ${name}`);
      }
      tensors.set(name, tensor);
      locations.set(name, { source: file.source, offset: file.tensorOffsets.get(name)! });
    }
  }
  return { inventory: { ...first.inventory, tensors }, locations };
}

export const TEST_ONLY = {
  maximumHeaderBytes,
};
