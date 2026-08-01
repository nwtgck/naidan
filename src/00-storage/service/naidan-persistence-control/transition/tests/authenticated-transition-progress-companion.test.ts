import { describe, expect, it } from 'vitest';
import { parsePortableFileSystemId } from '@/00-storage/service/hizofs/compatibility';
import { parseTransitionOperationId } from '@/00-storage/service/naidan-persistence-control/00-format';
import type { PersistenceControlRootKeyDerivationCapability } from '@/00-storage/service/naidan-persistence-control/crypto';
import type { TransitionProgressPhysicalPort } from '@/00-storage/service/naidan-persistence-control/store';
import {
  AuthenticatedTransitionProgressCompanion,
  type AuthenticatedTransitionProgressBinding,
  type TransitionProgressRootKeyProofScope,
} from '@/00-storage/service/naidan-persistence-control/transition/authenticated-transition-progress-companion';

const SOURCE_ID = parsePortableFileSystemId({ value: 'a00000000000000000000' });
const TARGET_ID = parsePortableFileSystemId({ value: 'b00000000000000000000' });
const OPERATION_ID = parseTransitionOperationId({ value: 'operation000000000000' });

function rootKey(): PersistenceControlRootKeyDerivationCapability {
  return {
    async deriveAesGcmKey({ info }) {
      const material = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), 'HKDF', false, ['deriveKey']);
      return await crypto.subtle.deriveKey(
        { hash: 'SHA-256', info, name: 'HKDF', salt: new Uint8Array(32) },
        material,
        { length: 256, name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt'],
      );
    },
  };
}

class MemoryPhysical implements TransitionProgressPhysicalPort {
  readonly copies: [Uint8Array | undefined, Uint8Array | undefined] = [undefined, undefined];

  async publishWholeFileDurably({ bytes, copy }: { bytes: Uint8Array; copy: 0 | 1 }): Promise<void> {
    this.copies[copy] = Uint8Array.from(bytes);
  }

  async readFileBounded({ copy, maximumByteLength }: { copy: 0 | 1; maximumByteLength: number }): Promise<Uint8Array | undefined> {
    const bytes = this.copies[copy];
    if (bytes !== undefined && bytes.byteLength > maximumByteLength) throw new RangeError('bounded read exceeded');
    return bytes === undefined ? undefined : Uint8Array.from(bytes);
  }

  async removeFile({ copy }: { copy: 0 | 1 }): Promise<void> {
    this.copies[copy] = undefined;
  }

  async runExclusive<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
    return await operation();
  }
}

function binding({ targetAuthorityIdentity = 'target-v1' }: {
  targetAuthorityIdentity?: string;
} = {}): AuthenticatedTransitionProgressBinding {
  return {
    operationId: OPERATION_ID,
    providerCheckpointCodec: 'hizofs-streaming-namespace-import-v1',
    sourceAuthorityIdentity: 'source-v1',
    sourceEndpoint: { fileSystemId: SOURCE_ID, type: 'hizofs' },
    targetAuthorityIdentity,
    targetEndpoint: { fileSystemId: TARGET_ID, type: 'hizofs' },
  };
}

function proofScope({ observed }: { observed: string[] }): TransitionProgressRootKeyProofScope {
  return {
    async withRootKeyProof({ fileSystemId, operation }) {
      observed.push(fileSystemId);
      return await operation({ rootKey: rootKey() });
    },
  };
}

describe('authenticated transition-progress companion composition', () => {
  it('publishes and loads detached opaque progress under one exact binding', async () => {
    const physical = new MemoryPhysical();
    const observed: string[] = [];
    const companion = new AuthenticatedTransitionProgressCompanion({
      binding: binding(),
      physical,
      proofScope: proofScope({ observed }),
      randomSource: ({ bytes }) => bytes.fill(3),
    });
    const portable = Uint8Array.of(1, 2);
    const provider = Uint8Array.of(3, 4);
    await expect(companion.publish({
      expectedJournalGeneration: undefined,
      progress: {
        journalGeneration: 0n,
        portableProgressBytes: portable,
        providerCheckpointBytes: provider,
        providerCheckpointState: 'active',
      },
    })).resolves.toMatchObject({ journalGeneration: 0n, providerCheckpointState: 'active' });
    portable.fill(9);
    provider.fill(9);
    const loaded = await companion.load();
    expect(Array.from(loaded?.portableProgressBytes ?? [])).toEqual([1, 2]);
    expect(Array.from(loaded?.providerCheckpointBytes ?? [])).toEqual([3, 4]);
    expect(observed).toEqual([TARGET_ID, TARGET_ID]);
  });

  it('rejects the same operation journal under a different authority binding', async () => {
    const physical = new MemoryPhysical();
    const observed: string[] = [];
    const first = new AuthenticatedTransitionProgressCompanion({ binding: binding(), physical, proofScope: proofScope({ observed }), randomSource: undefined });
    await first.publish({
      expectedJournalGeneration: undefined,
      progress: {
        journalGeneration: 0n,
        portableProgressBytes: new Uint8Array(),
        providerCheckpointBytes: new Uint8Array(),
        providerCheckpointState: 'sealed',
      },
    });
    const conflicting = new AuthenticatedTransitionProgressCompanion({
      binding: binding({ targetAuthorityIdentity: 'target-v2' }),
      physical,
      proofScope: proofScope({ observed }),
      randomSource: undefined,
    });
    await expect(conflicting.load()).rejects.toThrow('another authority or endpoint binding');
  });

  it('clears through the same proof scope and generation CAS', async () => {
    const physical = new MemoryPhysical();
    const observed: string[] = [];
    const companion = new AuthenticatedTransitionProgressCompanion({ binding: binding(), physical, proofScope: proofScope({ observed }), randomSource: undefined });
    await companion.publish({
      expectedJournalGeneration: undefined,
      progress: {
        journalGeneration: 0n,
        portableProgressBytes: new Uint8Array(),
        providerCheckpointBytes: new Uint8Array(),
        providerCheckpointState: 'active',
      },
    });
    await companion.clear({ expectedJournalGeneration: 0n });
    await expect(companion.load()).resolves.toBeUndefined();
    expect(physical.copies).toEqual([undefined, undefined]);
  });
});
