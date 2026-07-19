import { describe, expect, it } from 'vitest';
import { encodeBase64Url } from '@/00-storage/service/hizofs/base64-url';
import { importHizoFSRootKey } from '@/00-storage/service/hizofs/crypto/object-crypto';
import {
  decodeHizoFSSegmentIndex,
  encodeHizoFSSegmentIndex,
} from './segment-index';

const FILE_SYSTEM_ID = encodeBase64Url({ bytes: new Uint8Array(16).fill(3) });

async function createRootKey(): Promise<CryptoKey> {
  return await importHizoFSRootKey({ rawRootKey: new Uint8Array(32).fill(7) });
}

describe('HizoFS authenticated sealed-segment index', () => {
  it('round-trips bounded ordered record locations', async () => {
    const rootKey = await createRootKey();
    const segmentId = new Uint8Array(16).fill(9);
    const bytes = await encodeHizoFSSegmentIndex({
      rootKey,
      fileSystemId: FILE_SYSTEM_ID,
      index: {
        segmentType: 'metadata',
        segmentId,
        segmentByteLength: 224,
        entries: [
          { kind: 'commit', homeOffset: 64, storedLength: 80 },
          { kind: 'inode_index_page', homeOffset: 144, storedLength: 80 },
        ],
      },
    });

    await expect(decodeHizoFSSegmentIndex({
      rootKey,
      fileSystemId: FILE_SYSTEM_ID,
      expectedSegmentType: 'metadata',
      expectedSegmentId: segmentId,
      expectedSegmentByteLength: 224,
      bytes,
    })).resolves.toEqual({
      segmentType: 'metadata',
      segmentId,
      segmentByteLength: 224,
      entries: [
        { kind: 'commit', homeOffset: 64, storedLength: 80 },
        { kind: 'inode_index_page', homeOffset: 144, storedLength: 80 },
      ],
    });
  });

  it('rejects authentication failure and stale physical lengths', async () => {
    const rootKey = await createRootKey();
    const segmentId = new Uint8Array(16).fill(5);
    const bytes = await encodeHizoFSSegmentIndex({
      rootKey,
      fileSystemId: FILE_SYSTEM_ID,
      index: {
        segmentType: 'data',
        segmentId,
        segmentByteLength: 144,
        entries: [{ kind: 'file_chunk', homeOffset: 64, storedLength: 80 }],
      },
    });
    const corrupted = bytes.slice();
    corrupted[corrupted.byteLength - 1] ^= 1;

    await expect(decodeHizoFSSegmentIndex({
      rootKey,
      fileSystemId: FILE_SYSTEM_ID,
      expectedSegmentType: 'data',
      expectedSegmentId: segmentId,
      expectedSegmentByteLength: 144,
      bytes: corrupted,
    })).rejects.toThrow('authentication failed');
    await expect(decodeHizoFSSegmentIndex({
      rootKey,
      fileSystemId: FILE_SYSTEM_ID,
      expectedSegmentType: 'data',
      expectedSegmentId: segmentId,
      expectedSegmentByteLength: 145,
      bytes,
    })).rejects.toThrow('physical length is stale');
  });

  it('rejects gaps, overlaps, and unbounded ranges before encryption', async () => {
    const rootKey = await createRootKey();
    const segmentId = new Uint8Array(16).fill(4);
    await expect(encodeHizoFSSegmentIndex({
      rootKey,
      fileSystemId: FILE_SYSTEM_ID,
      index: {
        segmentType: 'metadata',
        segmentId,
        segmentByteLength: 200,
        entries: [
          { kind: 'commit', homeOffset: 64, storedLength: 80 },
          { kind: 'commit', homeOffset: 140, storedLength: 60 },
        ],
      },
    })).rejects.toThrow('not strictly ordered');

    await expect(encodeHizoFSSegmentIndex({
      rootKey,
      fileSystemId: FILE_SYSTEM_ID,
      index: {
        segmentType: 'metadata',
        segmentId,
        segmentByteLength: 65,
        entries: [],
      },
    })).rejects.toThrow('header length');

    await expect(encodeHizoFSSegmentIndex({
      rootKey,
      fileSystemId: FILE_SYSTEM_ID,
      index: {
        segmentType: 'metadata',
        segmentId,
        segmentByteLength: 0x1_0000_0040,
        entries: [{ kind: 'commit', homeOffset: 64, storedLength: 0x1_0000_0000 }],
      },
    })).rejects.toThrow('encoded range');
  });
});
