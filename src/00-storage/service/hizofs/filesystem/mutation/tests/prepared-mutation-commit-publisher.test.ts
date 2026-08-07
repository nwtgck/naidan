import { describe, expect, it, vi } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFeatureBits,
  createFileSystemCommitPayload,
  createHomeRecordReference,
  createInodeNumber,
  createPublicationSequence,
  createUInt64,
  createSubvolumeId,
  createUnlockSequence,
  parseMutationId,
  parsePublicationId,
  parseSegmentId,
} from "@/00-storage/service/hizofs/00-format";
import type { OpenedSuperblockCopies } from "@/00-storage/service/hizofs/authenticated-store/superblock-store";
import {
  appendPreparedMutationCommitCandidateThroughPort,
  prepareDeferredMutationCommitPublication,
  publishPreparedMutationCommit,
  publishPreparedMutationCommitCandidateThroughPort,
  type PreparedMutationCommitPublicationPort,
} from "@/00-storage/service/hizofs/filesystem/mutation/prepared-mutation-commit-publisher";
import { WriterMutationLifecycleError } from "@/00-storage/service/hizofs/filesystem/mutation/writer-mutation-lifecycle";

function homeReference({ kind = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit, offset }: { kind?: number; offset: bigint }) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 128,
    recordKind: kind,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
  } });
}

function baseAuthority(): OpenedSuperblockCopies {
  const logicalState = {
    activeCommitHomeRef: homeReference({ offset: 64n }),
    activeCommitSequence: createCommitSequence({ value: 1n }),
    activeMutationId: parseMutationId({ bytes: new Uint8Array(16).fill(3) }),
    fallbackCommitHomeRef: null,
    minimumUnlockSequence: createUnlockSequence({ value: 1n }),
    relocationIndexRootPhysicalRef: null,
    requiredFeatureBits: createFeatureBits({ value: 0n }),
  };
  return {
    authenticatedLogicalStates: [logicalState],
    copyState: "normal",
    historicalRootFeatureState: "supported_or_absent",
    logicalState,
    maximumStructurallyObservedPublicationSequence: createPublicationSequence({ value: 2n }),
    selectedCopy: 1,
    selectedPublicationId: parsePublicationId({ bytes: new Uint8Array(16).fill(4) }),
    selectedPublicationSequence: createPublicationSequence({ value: 2n }),
  };
}

function preparedCommit() {
  return createFileSystemCommitPayload({ payload: {
    commitSequence: createCommitSequence({ value: 2n }),
    mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(17) }),
    nestedSubvolumeTableRootHomeRef: null,
    nextInodeNumber: createInodeNumber({ value: 2n }),
    nextSubvolumeId: createSubvolumeId({ value: 2n }),
    rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
    rootInodeTableRootHomeRef: homeReference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      offset: 192n,
    }),
  } });
}

function successfulPort(): {
  appendCandidate: ReturnType<typeof vi.fn>;
  port: PreparedMutationCommitPublicationPort;
  publishCandidate: ReturnType<typeof vi.fn>;
  } {
  const appendCandidate = vi.fn(async ({ commitPayload }: Parameters<PreparedMutationCommitPublicationPort["appendCandidate"]>[0]) => ({
    commitHomeRef: homeReference({ offset: 320n }),
    commitPayload,
  }));
  const publishCandidate = vi.fn(async (request: Parameters<PreparedMutationCommitPublicationPort["publishCandidate"]>[0]) => {
    request.beforeFirstAuthorityWrite();
    return {
      commitHomeRef: request.candidate.commitHomeRef,
      superblock: {
        ...request.base,
        logicalState: {
          ...request.base.logicalState,
          activeCommitHomeRef: request.candidate.commitHomeRef,
          activeCommitSequence: request.candidate.commitPayload.commitSequence,
          activeMutationId: request.candidate.commitPayload.mutationId,
          fallbackCommitHomeRef: request.base.logicalState.activeCommitHomeRef,
        },
        maximumStructurallyObservedPublicationSequence: request.secondPublicationSequence,
        selectedPublicationSequence: request.secondPublicationSequence,
      },
    };
  });
  return { port: { appendCandidate, publishCandidate }, appendCandidate, publishCandidate };
}

describe("prepared mutation Commit publisher", () => {
  it("passes the exact reserved publication plan through the injected port", async () => {
    const base = baseAuthority();
    const commitPayload = preparedCommit();
    const { appendCandidate, port, publishCandidate } = successfulPort();
    const published = await publishPreparedMutationCommit({
      assertPublicationAllowed: () => undefined,
      base,
      commitPayload,
      onCandidatePrepared: undefined,
      publicationPort: port,
    });

    expect(published.superblock.logicalState.activeCommitSequence).toBe(2n);
    expect(appendCandidate).toHaveBeenCalledWith({ commitPayload });
    expect(publishCandidate).toHaveBeenCalledWith(expect.objectContaining({
      base,
      candidate: expect.objectContaining({ commitPayload }),
      firstPublicationSequence: 3n,
      secondPublicationSequence: 4n,
    }));
  });

  it("can append and later publish the exact authenticated candidate as separate steps", async () => {
    const base = baseAuthority();
    const commitPayload = preparedCommit();
    const { appendCandidate, port, publishCandidate } = successfulPort();

    const candidate = await appendPreparedMutationCommitCandidateThroughPort({
      assertPublicationAllowed: () => undefined,
      base,
      commitPayload,
      publicationPort: port,
    });
    expect(appendCandidate).toHaveBeenCalledOnce();
    expect(publishCandidate).not.toHaveBeenCalled();

    const publication = await publishPreparedMutationCommitCandidateThroughPort({
      assertPublicationAllowed: () => undefined,
      base,
      candidate,
      publicationPort: port,
    });
    expect(publication.commitHomeRef).toEqual(candidate.commitHomeRef);
    expect(publishCandidate).toHaveBeenCalledWith(expect.objectContaining({ candidate }));
  });


  it("prepares a detached candidate without starting durable publication", async () => {
    const events: string[] = [];
    const commitPayload = preparedCommit();
    const { port } = successfulPort();
    const detachedPublish = vi.fn();
    const detachedResolve = vi.fn();
    const abandon = vi.fn();
    const prepared = await prepareDeferredMutationCommitPublication({
      assertPublicationAllowed: () => events.push("gate"),
      base: baseAuthority(),
      commitPayload,
      onCandidatePrepared: ({ candidate }) => {
        events.push("install");
        return candidate;
      },
      publicationPort: {
        appendCandidate: async request => {
          events.push("append");
          return await port.appendCandidate(request);
        },
        detachPreparedCandidatePublication: ({ candidate }) => {
          events.push("detach");
          expect(candidate.commitPayload).toEqual(commitPayload);
          return {
            abandon,
            completeWorkingAcceptance: vi.fn(),
            completeExternallyResolvedPublication: vi.fn(),
            publishCandidate: detachedPublish,
            resolvePublication: detachedResolve,
          };
        },
        publishCandidate: port.publishCandidate,
      },
    });

    expect(prepared.candidate.commitPayload).toEqual(commitPayload);
    expect(prepared.publicationPort.publishCandidate).toBe(detachedPublish);
    expect(events).toEqual(["gate", "append", "install", "gate", "detach"]);
    expect(port.publishCandidate).not.toHaveBeenCalled();
    expect(detachedPublish).not.toHaveBeenCalled();
    expect(detachedResolve).not.toHaveBeenCalled();
    expect(abandon).not.toHaveBeenCalled();
  });

  it("does not detach when the final runtime authority gate is revoked", async () => {
    let gateChecks = 0;
    const { port } = successfulPort();
    const detach = vi.fn();

    await expect(prepareDeferredMutationCommitPublication({
      assertPublicationAllowed: () => {
        gateChecks += 1;
        if (gateChecks === 2) throw new Error("runtime authority changed before detach");
      },
      base: baseAuthority(),
      commitPayload: preparedCommit(),
      onCandidatePrepared: undefined,
      publicationPort: {
        appendCandidate: port.appendCandidate,
        detachPreparedCandidatePublication: detach,
        publishCandidate: port.publishCandidate,
      },
    })).rejects.toThrow("runtime authority changed before detach");

    expect(detach).not.toHaveBeenCalled();
    expect(port.publishCandidate).not.toHaveBeenCalled();
  });

  it("rejects publication when the working selector substitutes a different candidate", async () => {
    const commitPayload = preparedCommit();
    const { port, publishCandidate } = successfulPort();

    await expect(publishPreparedMutationCommit({
      assertPublicationAllowed: () => undefined,
      base: baseAuthority(),
      commitPayload,
      onCandidatePrepared: ({ candidate }) => ({
        commitHomeRef: homeReference({ offset: 448n }),
        commitPayload: candidate.commitPayload,
      }),
      publicationPort: port,
    })).rejects.toThrow("selection did not return the authenticated candidate");
    expect(publishCandidate).not.toHaveBeenCalled();
  });

  it("installs the authenticated candidate before durable publication starts", async () => {
    const events: string[] = [];
    const commitPayload = preparedCommit();
    const { port } = successfulPort();
    const publicationPort: PreparedMutationCommitPublicationPort = {
      appendCandidate: async request => {
        events.push("append");
        return await port.appendCandidate(request);
      },
      publishCandidate: async request => {
        events.push("publish");
        return await port.publishCandidate(request);
      },
    };

    await publishPreparedMutationCommit({
      assertPublicationAllowed: () => undefined,
      base: baseAuthority(),
      commitPayload,
      onCandidatePrepared: ({ candidate }) => {
        events.push("install");
        expect(candidate.commitPayload).toEqual(commitPayload);
        return candidate;
      },
      publicationPort,
    });

    expect(events).toEqual(["append", "install", "publish"]);
  });

  it("publishes through a detached candidate authority after working-candidate installation", async () => {
    const events: string[] = [];
    const commitPayload = preparedCommit();
    const { port } = successfulPort();
    const detachedPublish = vi.fn(async (request: Parameters<PreparedMutationCommitPublicationPort["publishCandidate"]>[0]) => {
      events.push("detached_publish");
      return await port.publishCandidate(request);
    });
    const abandon = vi.fn();
    const originalPublish = vi.fn(async () => {
      throw new Error("operation-scoped publication port must not be used after detach");
    });
    const publicationPort: PreparedMutationCommitPublicationPort = {
      appendCandidate: async request => {
        events.push("append");
        return await port.appendCandidate(request);
      },
      detachPreparedCandidatePublication: ({ candidate }) => {
        events.push("detach");
        expect(candidate.commitPayload).toEqual(commitPayload);
        return { abandon, publishCandidate: detachedPublish };
      },
      publishCandidate: originalPublish,
    };

    await publishPreparedMutationCommit({
      assertPublicationAllowed: () => undefined,
      base: baseAuthority(),
      commitPayload,
      onCandidatePrepared: ({ candidate }) => {
        events.push("install");
        return candidate;
      },
      onPublicationAuthorityDetached: ({ candidate, publicationPort: detached }) => {
        events.push("runtime_capture");
        expect(candidate.commitPayload).toEqual(commitPayload);
        expect(detached.publishCandidate).toBe(detachedPublish);
      },
      publicationPort,
    });

    expect(events).toEqual(["append", "install", "detach", "runtime_capture", "detached_publish"]);
    expect(originalPublish).not.toHaveBeenCalled();
    expect(abandon).not.toHaveBeenCalled();
  });

  it("abandons a detached authority when publication is revoked before its first call", async () => {
    let gateChecks = 0;
    const commitPayload = preparedCommit();
    const { port } = successfulPort();
    const detachedPublish = vi.fn();
    const abandon = vi.fn();
    const publicationPort: PreparedMutationCommitPublicationPort = {
      appendCandidate: port.appendCandidate,
      detachPreparedCandidatePublication: () => ({ abandon, publishCandidate: detachedPublish }),
      publishCandidate: port.publishCandidate,
    };

    await expect(publishPreparedMutationCommit({
      assertPublicationAllowed: () => {
        gateChecks += 1;
        if (gateChecks === 2) {
          throw new WriterMutationLifecycleError({
            code: "publication_revoked",
            message: "runtime authority changed after candidate detach",
          });
        }
      },
      base: baseAuthority(),
      commitPayload,
      onCandidatePrepared: undefined,
      publicationPort,
    })).rejects.toMatchObject({ code: "publication_revoked" });

    expect(detachedPublish).not.toHaveBeenCalled();
    expect(abandon).toHaveBeenCalledOnce();
  });

  it("does not start durable publication when working-candidate installation fails", async () => {
    const installFailure = new Error("working candidate install failed");
    const { appendCandidate, port, publishCandidate } = successfulPort();

    await expect(publishPreparedMutationCommit({
      assertPublicationAllowed: () => undefined,
      base: baseAuthority(),
      commitPayload: preparedCommit(),
      onCandidatePrepared: () => {
        throw installFailure;
      },
      publicationPort: port,
    })).rejects.toBe(installFailure);

    expect(appendCandidate).toHaveBeenCalledTimes(1);
    expect(publishCandidate).not.toHaveBeenCalled();
  });

  it("rejects owner closing before invoking the publication port", async () => {
    const { appendCandidate, port, publishCandidate } = successfulPort();
    await expect(publishPreparedMutationCommit({
      assertPublicationAllowed: () => {
        throw new WriterMutationLifecycleError({ code: "publication_revoked", message: "writer owner is closing" });
      },
      base: baseAuthority(),
      commitPayload: preparedCommit(),
      onCandidatePrepared: undefined,
      publicationPort: port,
    })).rejects.toMatchObject({ code: "publication_revoked" });
    expect(appendCandidate).not.toHaveBeenCalled();
    expect(publishCandidate).not.toHaveBeenCalled();
  });

  it("leaves an appended candidate unpublished when owner closes before durable publication", async () => {
    let gateChecks = 0;
    const { appendCandidate, port, publishCandidate } = successfulPort();
    await expect(publishPreparedMutationCommit({
      assertPublicationAllowed: () => {
        gateChecks += 1;
        if (gateChecks === 2) {
          throw new WriterMutationLifecycleError({
            code: "publication_revoked",
            message: "writer owner closed after candidate append",
          });
        }
      },
      base: baseAuthority(),
      commitPayload: preparedCommit(),
      onCandidatePrepared: undefined,
      publicationPort: port,
    })).rejects.toMatchObject({ code: "publication_revoked" });
    expect(gateChecks).toBe(2);
    expect(appendCandidate).toHaveBeenCalledTimes(1);
    expect(publishCandidate).not.toHaveBeenCalled();
  });

  it("rethrows late owner revocation immediately before the first authority write", async () => {
    let gateChecks = 0;
    const commitPayload = preparedCommit();
    const publicationPort: PreparedMutationCommitPublicationPort = {
      appendCandidate: async () => ({
        commitHomeRef: homeReference({ offset: 320n }),
        commitPayload,
      }),
      publishCandidate: async request => {
        request.beforeFirstAuthorityWrite();
        throw new Error("unreachable after final gate");
      },
    };
    await expect(publishPreparedMutationCommit({
      assertPublicationAllowed: () => {
        gateChecks += 1;
        if (gateChecks === 3) {
          throw new WriterMutationLifecycleError({ code: "publication_revoked", message: "writer owner started closing" });
        }
      },
      base: baseAuthority(),
      commitPayload,
      onCandidatePrepared: undefined,
      publicationPort,
    })).rejects.toMatchObject({ code: "publication_revoked" });
    expect(gateChecks).toBe(3);
  });
});
