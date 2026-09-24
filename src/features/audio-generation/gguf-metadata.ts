/** Bounded, advisory GGUF metadata inspection; never load tensors or run a model.
 * Supports little-endian v2/v3, as accepted by the existing model inventory.
 * Unknown layouts and limits are detection failures, not generation prohibitions.
 */
/** Only the range-reading surface is required, not whole-file materialization. */
// eslint-disable-next-line local-rules-named-args/require-named-args -- Preserve the platform Blob.slice signature while requiring only its arrayBuffer result.
export type GgufMetadataFile = Pick<Blob, 'size'> & { slice(...args: Parameters<Blob['slice']>): Pick<Blob, 'arrayBuffer'> };
export type GgufMetadataValue = string | boolean | number;
export const AUDIO_METADATA_SCAN_BYTES = 16 * 1024 * 1024;
const chunkBytes = 64 * 1024;
const maxItems = 1_000_000;
const maxStringBytes = 4096;

export async function readAudioGgufMetadata({ file, keys, signal }: {
  file: GgufMetadataFile, keys: readonly string[], signal: AbortSignal | undefined,
}): Promise<ReadonlyMap<string, GgufMetadataValue>> {
  let offset = 0;
  let windowStart = 0;
  let window = new Uint8Array();
  let steps = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const values = new Map<string, GgufMetadataValue>();
  const wanted = new Set(keys);
  const limit = Math.min(file.size, AUDIO_METADATA_SCAN_BYTES);
  function fail(): never {
    throw new Error('Unsupported or incomplete GGUF metadata');
  }
  function skip({ bytes }: { bytes: number }): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || offset + bytes > limit) fail();
    offset += bytes;
  }
  async function read({ bytes }: { bytes: number }): Promise<DataView> {
    signal?.throwIfAborted();
    const start = offset;
    skip({ bytes });
    if (start < windowStart || offset > windowStart + window.length) {
      windowStart = start;
      window = new Uint8Array(await file.slice(start, Math.min(limit, Math.max(offset, start + chunkBytes))).arrayBuffer());
      signal?.throwIfAborted();
      if (window.length < bytes) fail();
    }
    return new DataView(window.buffer, window.byteOffset + start - windowStart, bytes);
  }
  async function u32(): Promise<number> {
    return (await read({ bytes: 4 })).getUint32(0, true);
  }
  async function count(): Promise<number> {
    const value = (await read({ bytes: 8 })).getBigUint64(0, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail();
    return Number(value);
  }
  async function string({ retain }: { retain: boolean }): Promise<string | undefined> {
    const bytes = await count();
    if (!retain) {
      skip({ bytes }); return undefined;
    }
    if (bytes > maxStringBytes) fail();
    const data = await read({ bytes });
    return decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  async function checkpoint(): Promise<void> {
    signal?.throwIfAborted();
    if (++steps > maxItems) fail();
    // Large tokenizer string arrays can precede an interesting key. Remain
    // cancellable without creating an unbounded array of promises or strings.
    if (steps % 2048 === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      signal?.throwIfAborted();
    }
  }
  async function value({ type, retain, depth }: { type: number, retain: boolean, depth: number }): Promise<GgufMetadataValue | undefined> {
    await checkpoint();
    const sizes: Readonly<Record<number, number>> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
    const size = sizes[type];
    if (size !== undefined) {
      if (!retain) {
        skip({ bytes: size }); return undefined;
      }
      const data = await read({ bytes: size });
      switch (type) {
      case 0: return data.getUint8(0);
      case 1: return data.getInt8(0);
      case 2: return data.getUint16(0, true);
      case 3: return data.getInt16(0, true);
      case 4: return data.getUint32(0, true);
      case 5: return data.getInt32(0, true);
      case 6: return data.getFloat32(0, true);
      case 7: {
        const flag = data.getUint8(0); if (flag > 1) fail(); return flag === 1;
      }
      case 10: case 11: {
        const number = Number(type === 10 ? data.getBigUint64(0, true) : data.getBigInt64(0, true));
        if (!Number.isSafeInteger(number)) fail(); return number;
      }
      case 12: return data.getFloat64(0, true);
      default: return fail();
      }
    }
    switch (type) {
    case 8: return string({ retain });
    case 9: {
      if (depth >= 4) fail();
      const element = await u32(); const length = await count();
      if (length > maxItems) fail();
      const elementSize = sizes[element];
      if (elementSize !== undefined) skip({ bytes: length * elementSize });
      else {
        if (element !== 8 && element !== 9) fail();
        for (let index = 0; index < length; index++) await value({ type: element, retain: false, depth: depth + 1 });
      }
      // Arrays are deliberately not exposed to callers (e.g. tokenizer vocab).
      return undefined;
    }
    default: return fail();
    }
  }
  if (!Number.isSafeInteger(file.size) || file.size < 24) fail();
  const header = await read({ bytes: 24 });
  if (header.getUint32(0, true) !== 0x46554747 || ![2, 3].includes(header.getUint32(4, true))) fail();
  const entries = header.getBigUint64(16, true);
  if (entries > BigInt(maxItems)) fail();
  for (let index = 0; index < Number(entries); index++) {
    const key = await string({ retain: true });
    if (key === undefined) fail();
    const type = await u32();
    const selected = wanted.has(key);
    const entry = await value({ type, retain: selected, depth: 0 });
    if (selected) {
      if (entry !== undefined) values.set(key, entry);
      wanted.delete(key);
      if (wanted.size === 0) break;
    }
  }
  return values;
}
export const TEST_ONLY = {
};
