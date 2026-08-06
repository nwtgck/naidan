import {
  copyBinaryId,
  decodeRequiredHomeRecordReference,
  encodeHomeRecordReference,
  parseMutationId,
  type CommitSequence,
  type HomeRecordReference,
  type MutationId,
} from "@/00-storage/service/hizofs/00-format";

const workingGenerationAuthorityEpochBrand: unique symbol = Symbol("workingGenerationAuthorityEpoch");
const workingGenerationNumberBrand: unique symbol = Symbol("workingGenerationNumber");

export type WorkingGenerationAuthorityEpoch = Readonly<{
  readonly [workingGenerationAuthorityEpochBrand]: true;
}>;

export type WorkingGenerationNumber = bigint & {
  readonly [workingGenerationNumberBrand]: true;
};

export type DurableGenerationIdentity = Readonly<{
  commitReference: HomeRecordReference;
  commitSequence: CommitSequence;
  mutationId: MutationId;
}>;

export type WorkingGenerationIdentity = Readonly<{
  authorityEpoch: WorkingGenerationAuthorityEpoch;
  commitReference: HomeRecordReference;
  generationNumber: WorkingGenerationNumber;
  mutationId: MutationId;
}>;

function cloneCommitReference({ reference }: { reference: HomeRecordReference }): HomeRecordReference {
  return decodeRequiredHomeRecordReference({
    bytes: encodeHomeRecordReference({ reference }).slice(),
  });
}

function cloneMutationId({ mutationId }: { mutationId: MutationId }): MutationId {
  return parseMutationId({ bytes: copyBinaryId({ id: mutationId }) });
}

function sameBytes({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameCommitReference({ left, right }: {
  left: HomeRecordReference;
  right: HomeRecordReference;
}): boolean {
  return sameBytes({
    left: encodeHomeRecordReference({ reference: left }),
    right: encodeHomeRecordReference({ reference: right }),
  });
}

export function createWorkingGenerationAuthorityEpoch(): WorkingGenerationAuthorityEpoch {
  return Object.freeze({}) as WorkingGenerationAuthorityEpoch;
}

export function createWorkingGenerationNumber({ value }: { value: bigint }): WorkingGenerationNumber {
  if (value < 0n) throw new RangeError("working generation number must be non-negative");
  return value as WorkingGenerationNumber;
}

export function createDurableGenerationIdentity({ commitReference, commitSequence, mutationId }: {
  commitReference: HomeRecordReference;
  commitSequence: CommitSequence;
  mutationId: MutationId;
}): DurableGenerationIdentity {
  return Object.freeze({
    commitReference: cloneCommitReference({ reference: commitReference }),
    commitSequence,
    mutationId: cloneMutationId({ mutationId }),
  });
}

export function createWorkingGenerationIdentity({
  authorityEpoch,
  commitReference,
  generationNumber,
  mutationId,
}: {
  authorityEpoch: WorkingGenerationAuthorityEpoch;
  commitReference: HomeRecordReference;
  generationNumber: WorkingGenerationNumber;
  mutationId: MutationId;
}): WorkingGenerationIdentity {
  return Object.freeze({
    authorityEpoch,
    commitReference: cloneCommitReference({ reference: commitReference }),
    generationNumber,
    mutationId: cloneMutationId({ mutationId }),
  });
}

export function createSuccessorWorkingGenerationIdentity({ commitReference, mutationId, previous }: {
  commitReference: HomeRecordReference;
  mutationId: MutationId;
  previous: WorkingGenerationIdentity;
}): WorkingGenerationIdentity {
  return createWorkingGenerationIdentity({
    authorityEpoch: previous.authorityEpoch,
    commitReference,
    generationNumber: createWorkingGenerationNumber({ value: previous.generationNumber + 1n }),
    mutationId,
  });
}

export function sameDurableGenerationIdentity({ left, right }: {
  left: DurableGenerationIdentity;
  right: DurableGenerationIdentity;
}): boolean {
  return left.commitSequence === right.commitSequence
    && sameCommitReference({ left: left.commitReference, right: right.commitReference })
    && sameBytes({ left: left.mutationId, right: right.mutationId });
}

export function sameWorkingGenerationIdentity({ left, right }: {
  left: WorkingGenerationIdentity;
  right: WorkingGenerationIdentity;
}): boolean {
  return left.authorityEpoch === right.authorityEpoch
    && left.generationNumber === right.generationNumber
    && sameCommitReference({ left: left.commitReference, right: right.commitReference })
    && sameBytes({ left: left.mutationId, right: right.mutationId });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
