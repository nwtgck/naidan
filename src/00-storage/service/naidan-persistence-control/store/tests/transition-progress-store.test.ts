import { describe, expect, it } from 'vitest';
import { parsePortableFileSystemId } from '@/00-storage/service/hizofs/compatibility';
import {
  encodeTransitionProgressEnvelope,
  parseTransitionOperationId,
  type TransitionOperationId,
  type TransitionProgressPayloadV1,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import {
  protectTransitionProgress,
  type PersistenceControlRootKeyDerivationCapability,
} from '@/00-storage/service/naidan-persistence-control/crypto';
import {
  clearTransitionProgress,
  openTransitionProgress,
  publishTransitionProgress,
  type TransitionProgressPhysicalPort,
  type TransitionProgressProofAuthority,
} from '@/00-storage/service/naidan-persistence-control/store';

const SOURCE_ID = parsePortableFileSystemId({ value: 'a00000000000000000000' });
const TARGET_ID = parsePortableFileSystemId({ value: 'b00000000000000000000' });
const UNKNOWN_ID = parsePortableFileSystemId({ value: 'c00000000000000000000' });
const OPERATION_ID = parseTransitionOperationId({ value: 'operation000000000000' });
const OTHER_OPERATION_ID = parseTransitionOperationId({ value: 'operation000000000001' });

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

function proofAuthority({ includeUnknown = false }: { includeUnknown?: boolean } = {}): TransitionProgressProofAuthority {
  return {
    async resolveRootKey({ fileSystemId }) {
      if (fileSystemId === TARGET_ID) return { rootKey: rootKey({ fill: 7 }), state: 'resolved' };
      if (includeUnknown && fileSystemId === UNKNOWN_ID) return { rootKey: rootKey({ fill: 8 }), state: 'resolved' };
      return { state: 'unresolved' };
    },
  };
}

function payload({ generation, targetId = TARGET_ID }: {
  generation: bigint;
  targetId?: typeof TARGET_ID;
}): TransitionProgressPayloadV1 {
  return {
    journalGeneration: generation,
    portableProgressBytes: Uint8Array.of(1, Number(generation)),
    providerCheckpointCodec: 'hizofs-streaming-namespace-import-v1',
    providerCheckpointBytes: Uint8Array.of(2, Number(generation)),
    providerCheckpointState: generation % 2n === 0n ? 'active' : 'sealed',
    sourceAuthorityIdentity: 'source-authority-v1',
    sourceEndpoint: { fileSystemId: SOURCE_ID, type: 'hizofs' },
    targetAuthorityIdentity: 'target-authority-v1',
    targetEndpoint: { fileSystemId: targetId, type: 'hizofs' },
  };
}

class MemoryPhysical implements TransitionProgressPhysicalPort {
  readonly copies: [Uint8Array | undefined, Uint8Array | undefined] = [undefined, undefined];
  failPublishBeforeWriteAt: number | undefined;
  failPublishAfterWriteAt: number | undefined;
  failRemoveAfterDeleteCopy: 0 | 1 | undefined;
  failRemoveCopy: 0 | 1 | undefined;
  publishCount = 0;

  async publishWholeFileDurably({ bytes, copy }: { bytes: Uint8Array; copy: 0 | 1 }): Promise<void> {
    this.publishCount += 1;
    if (this.failPublishBeforeWriteAt === this.publishCount) throw new Error('publish before write');
    this.copies[copy] = Uint8Array.from(bytes);
    if (this.failPublishAfterWriteAt === this.publishCount) throw new Error('publish response lost');
  }

  async readFileBounded({ copy, maximumByteLength }: { copy: 0 | 1; maximumByteLength: number }): Promise<Uint8Array | undefined> {
    const bytes = this.copies[copy];
    if (bytes !== undefined && bytes.byteLength > maximumByteLength) throw new RangeError('bounded read exceeded');
    return bytes === undefined ? undefined : Uint8Array.from(bytes);
  }

  async removeFile({ copy }: { copy: 0 | 1 }): Promise<void> {
    if (this.failRemoveCopy === copy) throw new Error('remove failed');
    this.copies[copy] = undefined;
    if (this.failRemoveAfterDeleteCopy === copy) throw new Error('remove response lost');
  }

  async runExclusive<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
    return await operation();
  }
}

async function publish({ expected, generation, operationId = OPERATION_ID, physical }: {
  expected: bigint | undefined;
  generation: bigint;
  operationId?: TransitionOperationId;
  physical: MemoryPhysical;
}) {
  return await publishTransitionProgress({
    expectedJournalGeneration: expected,
    operationId,
    payload: payload({ generation }),
    physical,
    proofAuthority: proofAuthority(),
    randomSource: ({ bytes }) => bytes.fill(Number(generation) + 1),
  });
}

describe('authenticated transition-progress A/B store', () => {
  it('publishes a commit point, converges both copies, and advances generation by CAS', async () => {
    const physical = new MemoryPhysical();
    const first = await publish({ expected: undefined, generation: 0n, physical });
    expect(first.redundancy).toBe('converged');
    expect(physical.copies.every(Boolean)).toBe(true);
    const opened = await openTransitionProgress({ operationId: OPERATION_ID, physical, proofAuthority: proofAuthority() });
    expect(opened?.payload).toMatchObject({
      journalGeneration: 0n,
      providerCheckpointState: 'active',
      sourceAuthorityIdentity: 'source-authority-v1',
      targetAuthorityIdentity: 'target-authority-v1',
    });
    expect(Array.from(opened?.payload.portableProgressBytes ?? [])).toEqual([1, 0]);
    expect(Array.from(opened?.payload.providerCheckpointBytes ?? [])).toEqual([2, 0]);
    expect(opened?.envelope.sequence).toBe(2);

    await publish({ expected: 0n, generation: 1n, physical });
    const updated = await openTransitionProgress({ operationId: OPERATION_ID, physical, proofAuthority: proofAuthority() });
    expect(updated?.payload.journalGeneration).toBe(1n);
    expect(updated?.envelope.sequence).toBe(4);
    await expect(publish({ expected: 0n, generation: 1n, physical })).rejects.toMatchObject({
      code: 'generation_conflict',
    });
  });

  it('resolves durable-write response loss by exact authenticated read-back', async () => {
    const physical = new MemoryPhysical();
    physical.failPublishAfterWriteAt = 1;
    await expect(publish({ expected: undefined, generation: 0n, physical })).resolves.toMatchObject({ redundancy: 'converged' });
  });

  it('reports convergence failure without losing the committed authority', async () => {
    const physical = new MemoryPhysical();
    physical.failPublishBeforeWriteAt = 2;
    await expect(publish({ expected: undefined, generation: 0n, physical })).rejects.toMatchObject({
      code: 'convergence_failed',
      committedAuthority: expect.objectContaining({ payload: expect.objectContaining({ journalGeneration: 0n }) }),
    });
    const opened = await openTransitionProgress({ operationId: OPERATION_ID, physical, proofAuthority: proofAuthority() });
    expect(opened?.redundancy).toBe('degraded');
  });

  it('blocks fallback when the highest structural candidate protection is unresolved', async () => {
    const physical = new MemoryPhysical();
    await publish({ expected: undefined, generation: 0n, physical });
    const higher = await protectTransitionProgress({
      authenticationFileSystemId: UNKNOWN_ID,
      copy: 0,
      operationId: OPERATION_ID,
      payload: payload({ generation: 1n, targetId: UNKNOWN_ID }),
      randomSource: ({ bytes }) => bytes.fill(9),
      rootKey: rootKey({ fill: 8 }),
      sequence: 3,
    });
    physical.copies[0] = encodeTransitionProgressEnvelope({ envelope: higher });
    await expect(openTransitionProgress({ operationId: OPERATION_ID, physical, proofAuthority: proofAuthority() }))
      .rejects.toMatchObject({ code: 'higher_protection_unresolved' });
  });

  it('never adopts a fixed-path companion belonging to another operation', async () => {
    const physical = new MemoryPhysical();
    await publish({ expected: undefined, generation: 0n, operationId: OTHER_OPERATION_ID, physical });
    await expect(openTransitionProgress({ operationId: OPERATION_ID, physical, proofAuthority: proofAuthority() }))
      .rejects.toMatchObject({ code: 'operation_mismatch' });
  });

  it('resolves clear response loss after both fixed copies are physically absent', async () => {
    const physical = new MemoryPhysical();
    await publish({ expected: undefined, generation: 0n, physical });
    physical.failRemoveAfterDeleteCopy = 0;

    await expect(clearTransitionProgress({
      expectedJournalGeneration: 0n,
      operationId: OPERATION_ID,
      physical,
      proofAuthority: proofAuthority(),
    })).resolves.toBeUndefined();

    expect(physical.copies).toEqual([undefined, undefined]);
  });

  it('requires exact generation before clear and safely retries a partial clear', async () => {
    const physical = new MemoryPhysical();
    await publish({ expected: undefined, generation: 0n, physical });
    await expect(clearTransitionProgress({
      expectedJournalGeneration: 1n,
      operationId: OPERATION_ID,
      physical,
      proofAuthority: proofAuthority(),
    })).rejects.toMatchObject({ code: 'generation_conflict' });

    physical.failRemoveCopy = 1;
    await expect(clearTransitionProgress({
      expectedJournalGeneration: 0n,
      operationId: OPERATION_ID,
      physical,
      proofAuthority: proofAuthority(),
    })).rejects.toThrow('remove failed');
    expect(physical.copies[0]).toBeUndefined();
    expect(physical.copies[1]).toBeDefined();

    physical.failRemoveCopy = undefined;
    await clearTransitionProgress({
      expectedJournalGeneration: 0n,
      operationId: OPERATION_ID,
      physical,
      proofAuthority: proofAuthority(),
    });
    expect(physical.copies).toEqual([undefined, undefined]);
  });
});
