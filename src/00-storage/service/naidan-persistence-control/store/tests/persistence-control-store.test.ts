import { describe, expect, it, vi } from 'vitest';
import { parsePortableFileSystemId } from '@/00-storage/service/hizofs/compatibility';
import type { PersistenceControlRootKeyDerivationCapability } from '@/00-storage/service/naidan-persistence-control/crypto';
import {
  openPersistenceControl,
  PersistenceControlPublicationError,
  publishPersistenceControl,
  readPersistenceControlCandidates,
  resolvePersistenceControlPublicationOutcome,
  type PersistenceControlPhysicalPort,
  type PersistenceControlProofAuthority,
} from '@/00-storage/service/naidan-persistence-control/store';

const FILE_SYSTEM_ID = parsePortableFileSystemId({ value: '0123456789_ABCDEFGHIJ' });

function rootKey(): PersistenceControlRootKeyDerivationCapability {
  return {
    deriveAesGcmKey: async ({ info }) => {
      const material = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(9), 'HKDF', false, ['deriveKey']);
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

function proofAuthority({ unresolved = false }: { unresolved?: boolean } = {}): PersistenceControlProofAuthority {
  return {
    resolveRootKey: async () => unresolved ? { state: 'unresolved' } : { rootKey: rootKey(), state: 'resolved' },
    validateEndpointReadiness: async () => 'valid',
  };
}

class MemoryPhysicalPort implements PersistenceControlPhysicalPort {
  public readonly files = new Map<0 | 1, Uint8Array>();
  public readonly publications: Array<{ copy: 0 | 1; bytes: Uint8Array }> = [];
  public failPublicationNumber: number | undefined;
  private publicationCount = 0;
  private locked = false;

  public async readFileBounded({ copy, maximumByteLength }: { copy: 0 | 1; maximumByteLength: number }): Promise<Uint8Array | undefined> {
    const bytes = this.files.get(copy);
    if (bytes === undefined) return undefined;
    if (bytes.byteLength > maximumByteLength) throw new RangeError('bounded read exceeded');
    return Uint8Array.from(bytes);
  }

  public async publishWholeFileDurably({ bytes, copy }: { bytes: Uint8Array; copy: 0 | 1 }): Promise<void> {
    this.publicationCount += 1;
    if (this.publicationCount === this.failPublicationNumber) throw new Error('injected durable publication failure');
    const owned = Uint8Array.from(bytes);
    this.files.set(copy, owned);
    this.publications.push({ bytes: owned, copy });
  }

  public async runExclusive<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
    if (this.locked) throw new Error('exclusive publication overlap');
    this.locked = true;
    try {
      return await operation();
    } finally {
      this.locked = false;
    }
  }
}

function deterministicRandom({ bytes }: { bytes: Uint8Array }): void {
  bytes.fill(3);
}

describe('Naidan Persistence Control A/B store', () => {
  it('bootstraps verified plain state as copy 0 sequence 1 then converges copy 1 sequence 2', async () => {
    const physical = new MemoryPhysicalPort();
    const selected = await publishPersistenceControl({
      bootstrapAuthorization: 'verified_plain_namespace',
      physical,
      proofAuthority: proofAuthority(),
      randomSource: deterministicRandom,
      semanticState: { mode: { type: 'plain' }, retiredFileSystemIds: [] },
    });
    expect(physical.publications.map(({ copy }) => copy)).toEqual([0, 1]);
    expect(selected.control.sequence).toBe(2);
    expect(selected.redundancy).toBe('converged');
  });

  it('rejects implicit bootstrap over any existing bytes', async () => {
    const physical = new MemoryPhysicalPort();
    physical.files.set(0, new TextEncoder().encode('{}\n'));
    await expect(publishPersistenceControl({
      bootstrapAuthorization: 'verified_plain_namespace',
      physical,
      proofAuthority: proofAuthority(),
      randomSource: deterministicRandom,
      semanticState: { mode: { type: 'plain' }, retiredFileSystemIds: [] },
    })).rejects.toThrow();
  });

  it('publishes HizoFS state with proof-valid read-back and fresh copy-specific tags', async () => {
    const physical = new MemoryPhysicalPort();
    await publishPersistenceControl({
      bootstrapAuthorization: 'verified_plain_namespace',
      physical,
      proofAuthority: proofAuthority(),
      randomSource: deterministicRandom,
      semanticState: { mode: { type: 'plain' }, retiredFileSystemIds: [] },
    });
    const selected = await publishPersistenceControl({
      bootstrapAuthorization: undefined,
      physical,
      proofAuthority: proofAuthority(),
      randomSource: deterministicRandom,
      semanticState: { mode: { activeFileSystemId: FILE_SYSTEM_ID, type: 'hizofs' }, retiredFileSystemIds: [] },
    });
    expect(selected.control.mode).toEqual({ activeFileSystemId: FILE_SYSTEM_ID, type: 'hizofs' });
    expect(selected.control.sequence).toBe(4);
    expect(selected.redundancy).toBe('converged');
    expect(physical.publications).toHaveLength(4);
  });

  it('does not route lower when highest protection is unresolved', async () => {
    const physical = new MemoryPhysicalPort();
    await publishPersistenceControl({
      bootstrapAuthorization: 'verified_plain_namespace',
      physical,
      proofAuthority: proofAuthority(),
      randomSource: deterministicRandom,
      semanticState: { mode: { activeFileSystemId: FILE_SYSTEM_ID, type: 'hizofs' }, retiredFileSystemIds: [] },
    });
    const validateEndpointReadiness = vi.fn(async () => 'valid' as const);
    const unresolvedAuthority: PersistenceControlProofAuthority = {
      resolveRootKey: async () => ({ state: 'unresolved' }),
      validateEndpointReadiness,
    };
    const read = await readPersistenceControlCandidates({ physical, proofAuthority: unresolvedAuthority });
    expect(read.candidates.every(candidate => candidate.state === 'protection_unresolved')).toBe(true);
    expect(validateEndpointReadiness).not.toHaveBeenCalled();
    await expect(openPersistenceControl({ physical, proofAuthority: unresolvedAuthority })).rejects.toMatchObject({ code: 'higher_protection_unresolved' });
    expect(validateEndpointReadiness).not.toHaveBeenCalled();
  });

  it('returns the committed authority when second-copy convergence fails', async () => {
    const physical = new MemoryPhysicalPort();
    physical.failPublicationNumber = 2;
    let caught: unknown;
    try {
      await publishPersistenceControl({
        bootstrapAuthorization: 'verified_plain_namespace',
        physical,
        proofAuthority: proofAuthority(),
        randomSource: deterministicRandom,
        semanticState: { mode: { type: 'plain' }, retiredFileSystemIds: [] },
      });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PersistenceControlPublicationError);
    expect(caught).toMatchObject({ code: 'convergence_failed' });
    const error = caught as PersistenceControlPublicationError;
    expect(error.committedAuthority?.control.sequence).toBe(1);
    expect(await resolvePersistenceControlPublicationOutcome({
      desiredState: { mode: { type: 'plain' }, retiredFileSystemIds: [] },
      physical,
      proofAuthority: proofAuthority(),
    })).toBe('committed_degraded');
  });

  it('reports first-copy failure as not committed', async () => {
    const physical = new MemoryPhysicalPort();
    physical.failPublicationNumber = 1;
    await expect(publishPersistenceControl({
      bootstrapAuthorization: 'verified_plain_namespace',
      physical,
      proofAuthority: proofAuthority(),
      randomSource: deterministicRandom,
      semanticState: { mode: { type: 'plain' }, retiredFileSystemIds: [] },
    })).rejects.toMatchObject({ code: 'authority_commit_failed', committedAuthority: undefined });
  });
});
