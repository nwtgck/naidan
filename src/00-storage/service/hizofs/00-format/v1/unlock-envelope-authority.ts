import type { CredentialSlotV1, UnlockEnvelopeV1 } from './canonical-json/unlock-envelope';
import { createUnlockSequence, type UnlockSequence } from './scalars';

export type CredentialCopyState = 'credential_redundancy_degraded' | 'normal';

export type AuthenticatedUnlockEnvelopeCopy = Readonly<{
  envelope: UnlockEnvelopeV1;
  physicalCopy: 0 | 1;
}>;

export type AuthenticatedUnlockEnvelopeAuthority = Readonly<{
  copyState: CredentialCopyState;
  credentialSlots: readonly CredentialSlotV1[];
  envelope: UnlockEnvelopeV1;
  fileSystemId: UnlockEnvelopeV1['fileSystemId'];
  maximumStructurallyObservedUnlockSequence: UnlockSequence;
  minimumUnlockSequence: UnlockSequence;
  selectedPhysicalCopy: 0 | 1;
  unlockSequence: UnlockSequence;
}>;

export type UnlockEnvelopeAuthoritySelection =
  | Readonly<{ type: 'credential_rolled_back' }>
  | Readonly<{ type: 'no_eligible_authority' }>
  | Readonly<{ type: 'sequence_reuse_conflict' }>
  | Readonly<{
    copyState: CredentialCopyState;
    envelope: UnlockEnvelopeV1;
    selectedPhysicalCopy: 0 | 1;
    type: 'selected';
  }>;

export type UnlockEnvelopePublicationPhase =
  | 'prepared'
  | 'first_write_started'
  | 'first_authority_verified'
  | 'second_copy_converged';

export type UnlockEnvelopePublicationFailureOutcome =
  | 'not_published'
  | 'outcome_resolution_required'
  | 'published_redundancy_degraded';

export function credentialSlotsSemanticallyEqual({ left, right }: {
  left: CredentialSlotV1;
  right: CredentialSlotV1;
}): boolean {
  const {
    method: leftMethod,
    methodParameters: leftMethodParameters,
    methodVersion: leftMethodVersion,
    slotId: leftSlotId,
    type: leftType,
    wrappedFileSystemRootKey: leftWrappedFileSystemRootKey,
    ...unhandledLeft
  } = left;
  unhandledLeft satisfies Record<PropertyKey, never>;
  const {
    method: rightMethod,
    methodParameters: rightMethodParameters,
    methodVersion: rightMethodVersion,
    slotId: rightSlotId,
    type: rightType,
    wrappedFileSystemRootKey: rightWrappedFileSystemRootKey,
    ...unhandledRight
  } = right;
  unhandledRight satisfies Record<PropertyKey, never>;
  return leftType === rightType
    && leftSlotId === rightSlotId
    && leftMethod === rightMethod
    && leftMethodVersion === rightMethodVersion
    && leftMethodParameters === rightMethodParameters
    && leftWrappedFileSystemRootKey === rightWrappedFileSystemRootKey;
}

export function unlockEnvelopeCredentialSetsSemanticallyEqual({ left, right }: {
  left: readonly CredentialSlotV1[];
  right: readonly CredentialSlotV1[];
}): boolean {
  return left.length === right.length && left.every((slot, index) => {
    const other = right[index];
    return other !== undefined && credentialSlotsSemanticallyEqual({ left: slot, right: other });
  });
}

export function cloneCredentialSlot({ slot }: { slot: CredentialSlotV1 }): CredentialSlotV1 {
  return { ...slot };
}

export function unlockEnvelopesSemanticallyEqual({ left, right }: {
  left: UnlockEnvelopeV1;
  right: UnlockEnvelopeV1;
}): boolean {
  const {
    authenticatorNonce: _leftAuthenticatorNonce,
    authenticatorTag: _leftAuthenticatorTag,
    copy: _leftCopy,
    credentialSlots: leftCredentialSlots,
    fileSystemId: leftFileSystemId,
    format: leftFormat,
    formatVersion: leftFormatVersion,
    sequence: leftSequence,
    ...unhandledLeft
  } = left;
  unhandledLeft satisfies Record<PropertyKey, never>;
  const {
    authenticatorNonce: _rightAuthenticatorNonce,
    authenticatorTag: _rightAuthenticatorTag,
    copy: _rightCopy,
    credentialSlots: rightCredentialSlots,
    fileSystemId: rightFileSystemId,
    format: rightFormat,
    formatVersion: rightFormatVersion,
    sequence: rightSequence,
    ...unhandledRight
  } = right;
  unhandledRight satisfies Record<PropertyKey, never>;
  return leftFormat === rightFormat
    && leftFormatVersion === rightFormatVersion
    && leftSequence === rightSequence
    && leftFileSystemId === rightFileSystemId
    && unlockEnvelopeCredentialSetsSemanticallyEqual({ left: leftCredentialSlots, right: rightCredentialSlots });
}

export function cloneUnlockEnvelope({ envelope }: { envelope: UnlockEnvelopeV1 }): UnlockEnvelopeV1 {
  return {
    ...envelope,
    credentialSlots: envelope.credentialSlots.map(slot => cloneCredentialSlot({ slot })),
  };
}

export function selectAuthenticatedUnlockEnvelopeAuthority({
  authenticatedCopies,
  minimumUnlockSequence,
  requiredCredentialSlot,
}: {
  authenticatedCopies: readonly AuthenticatedUnlockEnvelopeCopy[];
  minimumUnlockSequence: UnlockSequence;
  requiredCredentialSlot: CredentialSlotV1 | undefined;
}): UnlockEnvelopeAuthoritySelection {
  const eligible = authenticatedCopies.filter(({ envelope }) => BigInt(envelope.sequence) >= minimumUnlockSequence);
  const highestSequence = eligible.reduce<number | undefined>(
    (highest, { envelope }) => highest === undefined || envelope.sequence > highest ? envelope.sequence : highest,
    undefined,
  );
  if (highestSequence === undefined) return { type: 'no_eligible_authority' };

  const selectedGroup = eligible.filter(({ envelope }) => envelope.sequence === highestSequence);
  const first = selectedGroup[0];
  if (first === undefined) throw new Error('selected Unlock Envelope group invariant failed');
  if (selectedGroup.some(({ envelope }) => !unlockEnvelopesSemanticallyEqual({ left: first.envelope, right: envelope }))) {
    return { type: 'sequence_reuse_conflict' };
  }
  if (requiredCredentialSlot !== undefined
    && !first.envelope.credentialSlots.some(slot => credentialSlotsSemanticallyEqual({
      left: slot,
      right: requiredCredentialSlot,
    }))) {
    return { type: 'credential_rolled_back' };
  }
  return {
    copyState: selectedGroup.length === 2 ? 'normal' : 'credential_redundancy_degraded',
    envelope: cloneUnlockEnvelope({ envelope: first.envelope }),
    selectedPhysicalCopy: first.physicalCopy,
    type: 'selected',
  };
}

export function maximumStructurallyObservedUnlockSequence({ copies }: {
  copies: readonly AuthenticatedUnlockEnvelopeCopy[];
}): UnlockSequence {
  const maximum = copies.reduce<bigint>((current, { envelope }) => {
    const sequence = BigInt(envelope.sequence);
    return sequence > current ? sequence : current;
  }, 1n);
  return createUnlockSequence({ value: maximum });
}

export function reserveNextUnlockEnvelopeSequence({
  maximumStructurallyObservedUnlockSequence,
  minimumUnlockSequence,
  unlockSequence,
}: {
  maximumStructurallyObservedUnlockSequence: UnlockSequence;
  minimumUnlockSequence: UnlockSequence;
  unlockSequence: UnlockSequence;
}): UnlockSequence {
  const maximum = [
    maximumStructurallyObservedUnlockSequence,
    minimumUnlockSequence,
    unlockSequence,
  ].reduce((current, candidate) => candidate > current ? candidate : current, 1n);
  if (maximum >= BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Unlock Sequence safe-integer space is exhausted; export into a fresh container is required');
  }
  return createUnlockSequence({ value: maximum + 1n });
}

export function unlockEnvelopePublicationFailureOutcome({ phase }: {
  phase: UnlockEnvelopePublicationPhase;
}): UnlockEnvelopePublicationFailureOutcome {
  switch (phase) {
  case 'prepared': return 'not_published';
  case 'first_write_started': return 'outcome_resolution_required';
  case 'first_authority_verified': return 'published_redundancy_degraded';
  case 'second_copy_converged': throw new Error('converged Unlock Envelope publication cannot fail');
  default: return phase satisfies never;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
