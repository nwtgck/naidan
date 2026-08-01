import { describe, expect, it } from 'vitest';
import { parsePortableFileSystemId } from '@/00-storage/service/hizofs/compatibility';
import {
  createHizoFSControlProtection,
  createPlainControlProtection,
  verifyHizoFSControlProtection,
  verifyPlainControlProtection,
  type PersistenceControlRootKeyDerivationCapability,
} from '@/00-storage/service/naidan-persistence-control/crypto';
import type { NaidanPersistenceControlCoreV1, NaidanPersistenceControlV1 } from '@/00-storage/service/naidan-persistence-control/00-format';

const FILE_SYSTEM_ID = parsePortableFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
const RETIRED_FILE_SYSTEM_ID = parsePortableFileSystemId({ value: '1123456789_ABCDEFGHIJ' });

function core({ copy, sequence }: { copy: 0 | 1; sequence: number }): NaidanPersistenceControlCoreV1 {
  return {
    copy,
    format: 'naidan-persistence-control',
    formatVersion: 1,
    mode: { activeFileSystemId: FILE_SYSTEM_ID, type: 'hizofs' },
    retiredFileSystemIds: [],
    sequence,
  };
}

function rootKey({ fill }: { fill: number }): PersistenceControlRootKeyDerivationCapability {
  return {
    deriveAesGcmKey: async ({ info }) => {
      const material = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(fill), 'HKDF', false, ['deriveKey']);
      return await crypto.subtle.deriveKey(
        { hash: 'SHA-256', info: new Uint8Array(info).buffer, name: 'HKDF', salt: new ArrayBuffer(0) },
        material,
        { length: 256, name: 'AES-GCM' },
        false,
        ['decrypt', 'encrypt'],
      );
    },
  };
}

function deterministicRandom({ bytes }: { bytes: Uint8Array }): void {
  for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = index + 1;
}

describe('Naidan Persistence Control protection', () => {
  it('creates and verifies a context-bound plain digest', async () => {
    const plainCore: NaidanPersistenceControlCoreV1 = { ...core({ copy: 0, sequence: 1 }), mode: { type: 'plain' } };
    const protection = await createPlainControlProtection({ core: plainCore });
    const control: NaidanPersistenceControlV1 = { ...plainCore, protection };
    expect(await verifyPlainControlProtection({ control })).toBe(true);
    expect(await verifyPlainControlProtection({ control: { ...control, sequence: 2 } })).toBe(false);
  });

  it('creates an empty-plaintext AES-GCM tag and verifies it with the selected root key', async () => {
    const value = core({ copy: 1, sequence: 42 });
    const protection = await createHizoFSControlProtection({
      authenticationFileSystemId: FILE_SYSTEM_ID,
      core: value,
      randomSource: deterministicRandom,
      rootKey: rootKey({ fill: 7 }),
    });
    if (protection.type !== 'hizofs_aes_256_gcm') throw new Error('test fixture protection mismatch');
    const control: NaidanPersistenceControlV1 = { ...value, protection };
    expect(protection.nonce).toBe('AQIDBAUGBwgJCgsM');
    expect(protection.type).toBe('hizofs_aes_256_gcm');
    expect(await verifyHizoFSControlProtection({ control, rootKey: rootKey({ fill: 7 }) })).toBe(true);
    expect(await verifyHizoFSControlProtection({ control, rootKey: rootKey({ fill: 8 }) })).toBe(false);
  });

  it('binds copy, sequence, semantic state, nonce, and authentication endpoint', async () => {
    const value = core({ copy: 0, sequence: 5 });
    const control: NaidanPersistenceControlV1 = {
      ...value,
      protection: await createHizoFSControlProtection({
        authenticationFileSystemId: FILE_SYSTEM_ID,
        core: value,
        randomSource: deterministicRandom,
        rootKey: rootKey({ fill: 1 }),
      }),
    };
    const protection = control.protection;
    if (protection.type !== 'hizofs_aes_256_gcm') throw new Error('test fixture protection mismatch');
    const tampered: NaidanPersistenceControlV1[] = [
      { ...control, copy: 1 },
      { ...control, sequence: 6 },
      { ...control, retiredFileSystemIds: [RETIRED_FILE_SYSTEM_ID] },
      { ...control, protection: { ...protection, nonce: 'AgIDBAUGBwgJCgsM' } },
    ];
    for (const candidate of tampered) {
      expect(await verifyHizoFSControlProtection({ control: candidate, rootKey: rootKey({ fill: 1 }) })).toBe(false);
    }
  });
});
