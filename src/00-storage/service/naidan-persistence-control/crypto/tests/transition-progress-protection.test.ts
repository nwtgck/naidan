import { describe, expect, it } from 'vitest';
import { parsePortableFileSystemId } from '@/00-storage/service/hizofs/compatibility';
import {
  parseTransitionOperationId,
  type TransitionProgressPayloadV1,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import {
  openProtectedTransitionProgress,
  protectTransitionProgress,
  type PersistenceControlRootKeyDerivationCapability,
} from '@/00-storage/service/naidan-persistence-control/crypto';

const SOURCE_ID = parsePortableFileSystemId({ value: 'a00000000000000000000' });
const TARGET_ID = parsePortableFileSystemId({ value: 'b00000000000000000000' });
const OPERATION_ID = parseTransitionOperationId({ value: 'operation000000000000' });

function rootKey({ fill }: { fill: number }): PersistenceControlRootKeyDerivationCapability {
  return {
    async deriveAesGcmKey({ info }) {
      const material = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(fill), 'HKDF', false, ['deriveKey']);
      return await crypto.subtle.deriveKey(
        { hash: 'SHA-256', info: Uint8Array.from(info), name: 'HKDF', salt: new Uint8Array(32) },
        material,
        { length: 256, name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt'],
      );
    },
  };
}

function payload(): TransitionProgressPayloadV1 {
  return {
    journalGeneration: 12n,
    portableProgressBytes: Uint8Array.of(1, 3, 5),
    providerCheckpointCodec: 'hizofs-streaming-namespace-import-v1',
    providerCheckpointBytes: Uint8Array.of(2, 4, 6),
    providerCheckpointState: 'sealed',
    sourceAuthorityIdentity: 'source-authority-v1',
    sourceEndpoint: { fileSystemId: SOURCE_ID, type: 'hizofs' },
    targetAuthorityIdentity: 'target-authority-v1',
    targetEndpoint: { fileSystemId: TARGET_ID, type: 'hizofs' },
  };
}

describe('transition-progress protection', () => {
  it('encrypts and authenticates the complete companion payload', async () => {
    const envelope = await protectTransitionProgress({
      authenticationFileSystemId: TARGET_ID,
      copy: 0,
      operationId: OPERATION_ID,
      payload: payload(),
      randomSource: ({ bytes }) => bytes.fill(7),
      rootKey: rootKey({ fill: 8 }),
      sequence: 3,
    });
    expect(envelope.ciphertext).not.toContain('source-authority-v1');
    await expect(openProtectedTransitionProgress({
      envelope,
      rootKey: rootKey({ fill: 8 }),
    })).resolves.toEqual(payload());
  });

  it('rejects a wrong root key, ciphertext tamper, and AAD tamper', async () => {
    const envelope = await protectTransitionProgress({
      authenticationFileSystemId: TARGET_ID,
      copy: 1,
      operationId: OPERATION_ID,
      payload: payload(),
      randomSource: ({ bytes }) => bytes.fill(9),
      rootKey: rootKey({ fill: 10 }),
      sequence: 5,
    });
    await expect(openProtectedTransitionProgress({
      envelope,
      rootKey: rootKey({ fill: 11 }),
    })).resolves.toBeUndefined();
    const replacement = envelope.ciphertext.endsWith('A') ? 'B' : 'A';
    await expect(openProtectedTransitionProgress({
      envelope: { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -1)}${replacement}` },
      rootKey: rootKey({ fill: 10 }),
    })).resolves.toBeUndefined();
    await expect(openProtectedTransitionProgress({
      envelope: { ...envelope, sequence: 6 },
      rootKey: rootKey({ fill: 10 }),
    })).resolves.toBeUndefined();
  });

  it('uses copy and operation identity in independent key contexts', async () => {
    const values = await Promise.all([0, 1].map(async copy => await protectTransitionProgress({
      authenticationFileSystemId: TARGET_ID,
      copy: copy as 0 | 1,
      operationId: OPERATION_ID,
      payload: payload(),
      randomSource: ({ bytes }) => bytes.fill(4),
      rootKey: rootKey({ fill: 12 }),
      sequence: 7,
    })));
    expect(values[0]?.ciphertext).not.toBe(values[1]?.ciphertext);
  });
});
