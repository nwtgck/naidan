import { describe, expect, it } from 'vitest';
import {
  createUnlockSequence,
  credentialSlotsSemanticallyEqual,
  maximumStructurallyObservedUnlockSequence,
  parseCredentialSlotId,
  parseFileSystemId,
  reserveNextUnlockEnvelopeSequence,
  selectAuthenticatedUnlockEnvelopeAuthority,
  unlockEnvelopeCredentialSetsSemanticallyEqual,
  unlockEnvelopesSemanticallyEqual,
  unlockEnvelopePublicationFailureOutcome,
  type CredentialSlotV1,
  type UnlockEnvelopeV1,
} from '@/00-storage/service/hizofs/00-format';

function credentialSlot({ seed }: { seed: string }): CredentialSlotV1 {
  return {
    method: 'future_method',
    methodParameters: `parameters-${seed}`,
    methodVersion: 2,
    slotId: parseCredentialSlotId({ value: `${seed}bcdefghij_klmnopq-12` }),
    type: 'credential',
    wrappedFileSystemRootKey: `wrapped-${seed}`,
  };
}

function envelope({ copy, credentialSlots, sequence }: {
  copy: 0 | 1;
  credentialSlots: readonly CredentialSlotV1[];
  sequence: number;
}): UnlockEnvelopeV1 {
  return {
    authenticatorNonce: `nonce-${copy}-${sequence}`,
    authenticatorTag: `tag-${copy}-${sequence}`,
    copy,
    credentialSlots,
    fileSystemId: parseFileSystemId({ value: 'Zbcdefghij_klmnopq-12' }),
    format: 'hizofs-unlock',
    formatVersion: 1,
    sequence,
  };
}

describe('HizoFS V1 Unlock Envelope authority', () => {
  it('selects the highest authenticated semantic generation and reports redundancy', () => {
    const slot = credentialSlot({ seed: 'A' });
    const lower = envelope({ copy: 0, credentialSlots: [slot], sequence: 3 });
    const selected0 = envelope({ copy: 0, credentialSlots: [slot], sequence: 4 });
    const selected1 = envelope({ copy: 1, credentialSlots: [slot], sequence: 4 });
    const result = selectAuthenticatedUnlockEnvelopeAuthority({
      authenticatedCopies: [
        { envelope: lower, physicalCopy: 0 },
        { envelope: selected0, physicalCopy: 0 },
        { envelope: selected1, physicalCopy: 1 },
      ],
      minimumUnlockSequence: createUnlockSequence({ value: 2n }),
      requiredCredentialSlot: slot,
    });
    expect(result).toMatchObject({ copyState: 'normal', selectedPhysicalCopy: 0, type: 'selected' });
    if (result.type !== 'selected') throw new Error('expected selected Unlock Envelope authority');
    expect(result.envelope).not.toBe(selected0);
    expect(unlockEnvelopesSemanticallyEqual({ left: result.envelope, right: selected1 })).toBe(true);
  });

  it('distinguishes rollback, floor rejection, and same-sequence conflict', () => {
    const slotA = credentialSlot({ seed: 'A' });
    const slotB = credentialSlot({ seed: 'B' });
    const copy0 = envelope({ copy: 0, credentialSlots: [slotA], sequence: 4 });
    expect(selectAuthenticatedUnlockEnvelopeAuthority({
      authenticatedCopies: [{ envelope: copy0, physicalCopy: 0 }],
      minimumUnlockSequence: createUnlockSequence({ value: 5n }),
      requiredCredentialSlot: slotA,
    })).toEqual({ type: 'no_eligible_authority' });
    expect(selectAuthenticatedUnlockEnvelopeAuthority({
      authenticatedCopies: [{ envelope: copy0, physicalCopy: 0 }],
      minimumUnlockSequence: createUnlockSequence({ value: 1n }),
      requiredCredentialSlot: slotB,
    })).toEqual({ type: 'credential_rolled_back' });
    expect(selectAuthenticatedUnlockEnvelopeAuthority({
      authenticatedCopies: [
        { envelope: copy0, physicalCopy: 0 },
        { envelope: envelope({ copy: 1, credentialSlots: [slotB], sequence: 4 }), physicalCopy: 1 },
      ],
      minimumUnlockSequence: createUnlockSequence({ value: 1n }),
      requiredCredentialSlot: undefined,
    })).toEqual({ type: 'sequence_reuse_conflict' });
  });

  it('owns slot equality, sequence reservation, and publication outcome facts', () => {
    const slot = credentialSlot({ seed: 'A' });
    expect(credentialSlotsSemanticallyEqual({ left: slot, right: { ...slot } })).toBe(true);
    expect(unlockEnvelopeCredentialSetsSemanticallyEqual({ left: [slot], right: [{ ...slot }] })).toBe(true);
    expect(maximumStructurallyObservedUnlockSequence({ copies: [
      { envelope: envelope({ copy: 0, credentialSlots: [slot], sequence: 7 }), physicalCopy: 0 },
    ] })).toBe(7n);
    expect(reserveNextUnlockEnvelopeSequence({
      maximumStructurallyObservedUnlockSequence: createUnlockSequence({ value: 7n }),
      minimumUnlockSequence: createUnlockSequence({ value: 9n }),
      unlockSequence: createUnlockSequence({ value: 8n }),
    })).toBe(10n);
    expect(unlockEnvelopePublicationFailureOutcome({ phase: 'prepared' })).toBe('not_published');
    expect(unlockEnvelopePublicationFailureOutcome({ phase: 'first_write_started' })).toBe('outcome_resolution_required');
    expect(unlockEnvelopePublicationFailureOutcome({ phase: 'first_authority_verified' })).toBe('published_redundancy_degraded');
    expect(() => unlockEnvelopePublicationFailureOutcome({ phase: 'second_copy_converged' })).toThrow();
  });
});
