import { describe, expect, it } from "vitest";
import {
  createCommitSequence,
  parseMutationId,
} from "@/00-storage/service/hizofs/00-format";
import { createTestingHomeRecordReference } from "@/00-storage/service/hizofs/runtime/testing/home-record-reference-fixture";
import {
  createDurableGenerationIdentity,
  createSuccessorWorkingGenerationIdentity,
  createWorkingGenerationAuthorityEpoch,
  createWorkingGenerationIdentity,
  createWorkingGenerationNumber,
  sameDurableGenerationIdentity,
  sameWorkingGenerationIdentity,
} from "@/00-storage/service/hizofs/runtime/application-generation-identity";

function reference({ offset }: { offset: bigint }) {
  return createTestingHomeRecordReference({ offset });
}

function mutationId({ seed }: { seed: number }) {
  return parseMutationId({ bytes: new Uint8Array(16).fill(seed) });
}

describe("application generation identity", () => {
  it("distinguishes runtime working generations from persisted Commit Sequence", () => {
    const authorityEpoch = createWorkingGenerationAuthorityEpoch();
    const initial = createWorkingGenerationIdentity({
      authorityEpoch,
      generationNumber: createWorkingGenerationNumber({ value: 0n }),
      mutationId: mutationId({ seed: 1 }),
    });
    const successor = createSuccessorWorkingGenerationIdentity({
      mutationId: mutationId({ seed: 2 }),
      previous: initial,
    });

    expect(successor.authorityEpoch).toBe(initial.authorityEpoch);
    expect(successor.generationNumber).toBe(1n);
    expect(sameWorkingGenerationIdentity({ left: initial, right: successor })).toBe(false);
  });

  it("requires exact authority epoch, generation number, and Mutation ID", () => {
    const authorityEpoch = createWorkingGenerationAuthorityEpoch();
    const base = createWorkingGenerationIdentity({
      authorityEpoch,
      generationNumber: createWorkingGenerationNumber({ value: 4n }),
      mutationId: mutationId({ seed: 1 }),
    });
    const exactCopy = createWorkingGenerationIdentity({
      authorityEpoch,
      generationNumber: createWorkingGenerationNumber({ value: 4n }),
      mutationId: mutationId({ seed: 1 }),
    });

    expect(sameWorkingGenerationIdentity({ left: base, right: exactCopy })).toBe(true);
    expect(sameWorkingGenerationIdentity({
      left: base,
      right: createWorkingGenerationIdentity({
        authorityEpoch: createWorkingGenerationAuthorityEpoch(),
        generationNumber: createWorkingGenerationNumber({ value: 4n }),
        mutationId: mutationId({ seed: 1 }),
      }),
    })).toBe(false);
    expect(sameWorkingGenerationIdentity({
      left: base,
      right: createWorkingGenerationIdentity({
        authorityEpoch,
        generationNumber: createWorkingGenerationNumber({ value: 5n }),
        mutationId: mutationId({ seed: 1 }),
      }),
    })).toBe(false);
    expect(sameWorkingGenerationIdentity({
      left: base,
      right: createWorkingGenerationIdentity({
        authorityEpoch,
        generationNumber: createWorkingGenerationNumber({ value: 4n }),
        mutationId: mutationId({ seed: 2 }),
      }),
    })).toBe(false);
  });

  it("models durable authority independently from runtime generation numbering", () => {
    const left = createDurableGenerationIdentity({
      commitReference: reference({ offset: 64n }),
      commitSequence: createCommitSequence({ value: 7n }),
      mutationId: mutationId({ seed: 1 }),
    });
    const right = createDurableGenerationIdentity({
      commitReference: reference({ offset: 64n }),
      commitSequence: createCommitSequence({ value: 7n }),
      mutationId: mutationId({ seed: 1 }),
    });
    const differentReference = createDurableGenerationIdentity({
      commitReference: reference({ offset: 128n }),
      commitSequence: createCommitSequence({ value: 7n }),
      mutationId: mutationId({ seed: 1 }),
    });

    expect(sameDurableGenerationIdentity({ left, right })).toBe(true);
    expect(sameDurableGenerationIdentity({ left, right: differentReference })).toBe(false);
  });

  it("copies mutable binary identity inputs at the authority boundary", () => {
    const sourceMutationId = mutationId({ seed: 3 });
    const identity = createWorkingGenerationIdentity({
      authorityEpoch: createWorkingGenerationAuthorityEpoch(),
      generationNumber: createWorkingGenerationNumber({ value: 0n }),
      mutationId: sourceMutationId,
    });

    sourceMutationId.fill(9);

    expect([...identity.mutationId]).toEqual([...mutationId({ seed: 3 })]);
  });

  it("rejects negative runtime generation numbers", () => {
    expect(() => createWorkingGenerationNumber({ value: -1n })).toThrowError(RangeError);
  });
});
