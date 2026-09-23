import { Blob as NativeBlob } from 'node:buffer';

export type MetadataFixtureEntry = { key: string, type: number, value: Uint8Array };
export function ggufInteger({ value, bytes }: { value: bigint | number, bytes: 4 | 8 }): Uint8Array {
  const buffer = new Uint8Array(bytes); const view = new DataView(buffer.buffer);
  if (bytes === 4) view.setUint32(0, Number(value), true); else view.setBigUint64(0, BigInt(value), true);
  return buffer;
}
export function ggufString({ value }: { value: string }): Uint8Array {
  const data = new TextEncoder().encode(value);
  return concatenateGguf({ parts: [ggufInteger({ value: data.length, bytes: 8 }), data] });
}
export function concatenateGguf({ parts }: { parts: readonly Uint8Array[] }): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset); offset += part.length;
  }
  return bytes;
}
export function ggufFixture({ entries, version = 3 }: { entries: readonly MetadataFixtureEntry[], version?: number }): NativeBlob {
  // Node's Blob supports arrayBuffer/slice in the jsdom runner, without adding a
  // global browser polyfill that could hide missing platform functionality.
  return new NativeBlob([concatenateGguf({ parts: [
    ggufInteger({ value: 0x46554747, bytes: 4 }), ggufInteger({ value: version, bytes: 4 }),
    ggufInteger({ value: 0, bytes: 8 }), ggufInteger({ value: entries.length, bytes: 8 }),
    ...entries.flatMap(entry => [ggufString({ value: entry.key }), ggufInteger({ value: entry.type, bytes: 4 }), entry.value]),
  ] })]);
}
export function textMetadata({ key, value }: { key: string, value: string }): MetadataFixtureEntry {
  return { key, type: 8, value: ggufString({ value }) };
}
export function boolMetadata({ key, value }: { key: string, value: boolean }): MetadataFixtureEntry {
  return { key, type: 7, value: new Uint8Array([value ? 1 : 0]) };
}
export const TEST_ONLY = {
};
