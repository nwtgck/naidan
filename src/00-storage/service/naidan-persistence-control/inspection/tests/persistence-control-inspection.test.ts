import { describe, expect, it } from 'vitest';
import { parsePortableFileSystemId } from '@/00-storage/service/hizofs/compatibility';
import {
  createPlainControlProtection,
  type PersistenceControlRootKeyDerivationCapability,
} from '@/00-storage/service/naidan-persistence-control/crypto';
import {
  decodePersistenceControl,
  encodePersistenceControl,
  NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import { inspectPersistenceControl } from '@/00-storage/service/naidan-persistence-control/inspection';
import {
  publishPersistenceControl,
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
  public readonly reads: Array<{ copy: 0 | 1; maximumByteLength: number }> = [];

  public async readFileBounded({ copy, maximumByteLength }: { copy: 0 | 1; maximumByteLength: number }): Promise<Uint8Array | undefined> {
    this.reads.push({ copy, maximumByteLength });
    const bytes = this.files.get(copy);
    if (bytes === undefined) return undefined;
    if (bytes.byteLength > maximumByteLength) throw new RangeError('bounded read exceeded');
    return Uint8Array.from(bytes);
  }

  public async publishWholeFileDurably({ bytes, copy }: { bytes: Uint8Array; copy: 0 | 1 }): Promise<void> {
    this.files.set(copy, Uint8Array.from(bytes));
  }

  public async runExclusive<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
    return await operation();
  }
}

function deterministicRandom({ bytes }: { bytes: Uint8Array }): void {
  bytes.fill(3);
}

describe('Persistence Control physical inspection', () => {
  it('shows both physical copies and the selected converged authority', async () => {
    const physical = new MemoryPhysicalPort();
    await publishPersistenceControl({
      bootstrapAuthorization: 'verified_plain_namespace',
      physical,
      proofAuthority: proofAuthority(),
      randomSource: deterministicRandom,
      semanticState: { mode: { type: 'plain' }, retiredFileSystemIds: [] },
    });
    physical.reads.length = 0;
    const inspection = await inspectPersistenceControl({ physical, proofAuthority: proofAuthority() });
    expect(physical.reads).toEqual([
      { copy: 0, maximumByteLength: NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.limits.persistenceControlJsonBytes },
      { copy: 1, maximumByteLength: NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.limits.persistenceControlJsonBytes },
    ]);
    expect(inspection.selection).toEqual({ copy: 1, redundancy: 'converged', sequence: 2, state: 'selected' });
    expect(inspection.copies.map(copy => ({ copy: copy.copy, selected: copy.selected, sequence: copy.sequence, state: copy.state }))).toEqual([
      { copy: 0, selected: false, sequence: 1, state: 'proof_valid' },
      { copy: 1, selected: true, sequence: 2, state: 'proof_valid' },
    ]);
  });

  it('preserves both unresolved copies when authority selection is blocked', async () => {
    const physical = new MemoryPhysicalPort();
    await publishPersistenceControl({
      bootstrapAuthorization: 'verified_plain_namespace',
      physical,
      proofAuthority: proofAuthority(),
      randomSource: deterministicRandom,
      semanticState: { mode: { activeFileSystemId: FILE_SYSTEM_ID, type: 'hizofs' }, retiredFileSystemIds: [] },
    });
    const inspection = await inspectPersistenceControl({ physical, proofAuthority: proofAuthority({ unresolved: true }) });
    expect(inspection.selection).toMatchObject({ code: 'higher_protection_unresolved', state: 'rejected' });
    expect(inspection.copies.map(copy => ({ authenticationFileSystemId: copy.authenticationFileSystemId, selected: copy.selected, state: copy.state }))).toEqual([
      { authenticationFileSystemId: FILE_SYSTEM_ID, selected: false, state: 'protection_unresolved' },
      { authenticationFileSystemId: FILE_SYSTEM_ID, selected: false, state: 'protection_unresolved' },
    ]);
  });

  it('reports missing and structurally invalid copies without inventing a plain fallback', async () => {
    const physical = new MemoryPhysicalPort();
    physical.files.set(1, new TextEncoder().encode('{}\n'));
    const inspection = await inspectPersistenceControl({ physical, proofAuthority: proofAuthority() });
    expect(inspection.selection).toMatchObject({ code: 'no_proof_valid_authority', state: 'rejected' });
    expect(inspection.copies[0]).toMatchObject({ copy: 0, reason: 'missing', state: 'structurally_invalid' });
    expect(inspection.copies[1]).toMatchObject({ copy: 1, state: 'structurally_invalid' });
    expect(inspection.observedSequences).toEqual([undefined, undefined]);
  });

  it('keeps a proof-invalid sibling visible while selecting the surviving copy as degraded', async () => {
    const physical = new MemoryPhysicalPort();
    await publishPersistenceControl({
      bootstrapAuthorization: 'verified_plain_namespace',
      physical,
      proofAuthority: proofAuthority(),
      randomSource: deterministicRandom,
      semanticState: { mode: { type: 'plain' }, retiredFileSystemIds: [] },
    });
    const bytes = physical.files.get(1);
    if (bytes === undefined) throw new Error('expected copy 1');
    const control = decodePersistenceControl({ bytes });
    if (control.protection.type !== 'plain_sha256') throw new Error('expected plain protection');
    physical.files.set(1, encodePersistenceControl({
      control: { ...control, protection: { digest: 'A'.repeat(43), type: 'plain_sha256' } },
    }));

    const inspection = await inspectPersistenceControl({ physical, proofAuthority: proofAuthority() });
    expect(inspection.selection).toEqual({ copy: 0, redundancy: 'degraded', sequence: 1, state: 'selected' });
    expect(inspection.copies.map(copy => ({ copy: copy.copy, selected: copy.selected, state: copy.state }))).toEqual([
      { copy: 0, selected: true, state: 'proof_valid' },
      { copy: 1, selected: false, state: 'proof_invalid' },
    ]);
  });

  it('shows both proof-valid copies when sequence reuse makes authority selection corrupt', async () => {
    const physical = new MemoryPhysicalPort();
    await publishPersistenceControl({
      bootstrapAuthorization: 'verified_plain_namespace',
      physical,
      proofAuthority: proofAuthority(),
      randomSource: deterministicRandom,
      semanticState: { mode: { type: 'plain' }, retiredFileSystemIds: [] },
    });
    const bytes = physical.files.get(1);
    if (bytes === undefined) throw new Error('expected copy 1');
    const control = decodePersistenceControl({ bytes });
    const core = {
      copy: control.copy,
      format: control.format,
      formatVersion: control.formatVersion,
      mode: control.mode,
      retiredFileSystemIds: control.retiredFileSystemIds,
      sequence: 1,
    } as const;
    physical.files.set(1, encodePersistenceControl({
      control: { ...core, protection: await createPlainControlProtection({ core }) },
    }));

    const inspection = await inspectPersistenceControl({ physical, proofAuthority: proofAuthority() });
    expect(inspection.selection).toMatchObject({ code: 'sequence_reuse_corruption', state: 'rejected' });
    expect(inspection.copies.map(copy => ({ selected: copy.selected, sequence: copy.sequence, state: copy.state }))).toEqual([
      { selected: false, sequence: 1, state: 'proof_valid' },
      { selected: false, sequence: 1, state: 'proof_valid' },
    ]);
  });

  it('re-reads both physical copies instead of returning a cached authority view', async () => {
    const physical = new MemoryPhysicalPort();
    await publishPersistenceControl({
      bootstrapAuthorization: 'verified_plain_namespace',
      physical,
      proofAuthority: proofAuthority(),
      randomSource: deterministicRandom,
      semanticState: { mode: { type: 'plain' }, retiredFileSystemIds: [] },
    });
    const first = await inspectPersistenceControl({ physical, proofAuthority: proofAuthority() });
    await publishPersistenceControl({
      bootstrapAuthorization: undefined,
      physical,
      proofAuthority: proofAuthority(),
      randomSource: deterministicRandom,
      semanticState: { mode: { activeFileSystemId: FILE_SYSTEM_ID, type: 'hizofs' }, retiredFileSystemIds: [] },
    });
    const second = await inspectPersistenceControl({ physical, proofAuthority: proofAuthority() });
    expect(first.selection).toMatchObject({ sequence: 2, state: 'selected' });
    expect(second.selection).toMatchObject({ sequence: 4, state: 'selected' });
    expect(second.copies.every(copy => copy.mode?.type === 'hizofs')).toBe(true);
  });

  it('retains exact persisted proof fields without exposing root-key capabilities', async () => {
    const physical = new MemoryPhysicalPort();
    await publishPersistenceControl({
      bootstrapAuthorization: 'verified_plain_namespace',
      physical,
      proofAuthority: proofAuthority(),
      randomSource: deterministicRandom,
      semanticState: { mode: { activeFileSystemId: FILE_SYSTEM_ID, type: 'hizofs' }, retiredFileSystemIds: [] },
    });
    const inspection = await inspectPersistenceControl({ physical, proofAuthority: proofAuthority() });
    expect(Object.keys(inspection.copies[1] ?? {}).toSorted()).toEqual([
      'authenticationFileSystemId',
      'control',
      'copy',
      'mode',
      'physicalPath',
      'protection',
      'reason',
      'retiredFileSystemIds',
      'selected',
      'sequence',
      'state',
    ]);
    expect(inspection.copies.map(copy => copy.physicalPath)).toEqual([
      ['persistence-control', 'state-0.json'],
      ['persistence-control', 'state-1.json'],
    ]);
    const serialized = JSON.stringify(inspection);
    expect(serialized).toContain('authenticatorTag');
    expect(serialized).toContain('nonce');
    expect(serialized).not.toContain('deriveAesGcmKey');
    expect(serialized).not.toContain('rootKey');
  });
});
