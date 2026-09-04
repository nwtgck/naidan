import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findPackIndexEntry, findPackIndexObjectIdsByPrefix, parsePackIndex } from './pack-index';

const fixturePath = join(
  process.cwd(),
  'src/features/wesh/commands/git/test-fixtures/pack-delta/pack-84deeadcdec240a56f8bbd6c1b636a78cb4467af.idx',
);

function fixedPackIndexV1(): Uint8Array {
  const objectIds = [
    '0100000000000000000000000000000000000001',
    '8000000000000000000000000000000000000002',
  ];
  const bytes = new Uint8Array(256 * 4 + objectIds.length * 24 + 40);
  const view = new DataView(bytes.buffer);
  for (let firstByte = 0; firstByte < 256; firstByte += 1) {
    const count = objectIds.filter(objectId => Number.parseInt(objectId.slice(0, 2), 16) <= firstByte).length;
    view.setUint32(firstByte * 4, count, false);
  }
  let offset = 256 * 4;
  const offsets = [12, 345];
  for (let index = 0; index < objectIds.length; index += 1) {
    view.setUint32(offset, offsets[index]!, false);
    offset += 4;
    bytes.set(Buffer.from(objectIds[index]!, 'hex'), offset);
    offset += 20;
  }
  bytes.fill(0x11, offset, offset + 20);
  offset += 20;
  bytes.set(createHash('sha1').update(bytes.subarray(0, offset)).digest(), offset);
  return bytes;
}

describe('wesh git pack index parser', () => {
  it('parses a fixed Git pack index with sorted object ids and offsets', async () => {
    const index = parsePackIndex({ bytes: await readFile(fixturePath) });

    expect(index.entries).toHaveLength(24);
    expect(index.entries[0]).toEqual({
      objectId: '19cb03c331783f423d72132b35251eca4d5d5873',
      offset: 5186,
    });
    expect(index.entries.at(-1)).toEqual({
      objectId: 'ed40651d2a78c5b6fabc0441abbfbd8b312cb0a2',
      offset: 4711,
    });
    expect(index.packChecksum).toBe('84deeadcdec240a56f8bbd6c1b636a78cb4467af');
  });

  it('binary-searches exact and abbreviated object ids in sorted indexes', async () => {
    const index = parsePackIndex({ bytes: await readFile(fixturePath) });
    const first = index.entries[0]!;

    expect(findPackIndexEntry({ packIndex: index, objectId: first.objectId })).toBe(first);
    expect(findPackIndexEntry({ packIndex: index, objectId: '0000000000000000000000000000000000000000' })).toBeUndefined();
    expect(findPackIndexObjectIdsByPrefix({ packIndex: index, prefix: first.objectId.slice(0, 6), limit: 2 })).toEqual([first.objectId]);
    expect(findPackIndexObjectIdsByPrefix({ packIndex: index, prefix: '', limit: 2 })).toEqual(
      index.entries.slice(0, 2).map(entry => entry.objectId),
    );
  });

  it('rejects a pack index whose checksum no longer matches its contents', async () => {
    const bytes = new Uint8Array(await readFile(fixturePath));
    bytes[1024] = bytes[1024]! ^ 0x01;

    expect(() => parsePackIndex({ bytes })).toThrow('pack index checksum mismatch');
  });
  it('parses original version 1 indexes into the same object-id and offset model', () => {
    const index = parsePackIndex({ bytes: fixedPackIndexV1() });

    expect(index.entries).toEqual([
      { objectId: '0100000000000000000000000000000000000001', offset: 12 },
      { objectId: '8000000000000000000000000000000000000002', offset: 345 },
    ]);
    expect(index.packChecksum).toBe('1111111111111111111111111111111111111111');
  });

});
