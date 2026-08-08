import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFileOffset,
  createHomeRecordReference,
  createFeatureBits,
  createFileSystemCommitPayload,
  createInodeNumber,
  createInodeRevision,
  createPublicationSequence,
  createSubvolumeId,
  createUInt64,
  createUnlockSequence,
  encodeFileExtentPage,
  encodeFileSystemCommitPayload,
  parseFileSystemId,
  parseSegmentId,
  parseMutationId,
} from "@/00-storage/service/hizofs/00-format";
import {
  createInitialBootstrapSegment,
  readBootstrapRoot,
} from "@/00-storage/service/hizofs/authenticated-store/bootstrap-segment-store";
import { readAuthenticatedDirectoryPage } from "@/00-storage/service/hizofs/authenticated-store/directory-page-store";
import { readAuthenticatedInodeTablePage } from "@/00-storage/service/hizofs/authenticated-store/inode-table-page-store";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import { createAuthenticatedMetadataMutationAuthority } from "@/00-storage/service/hizofs/authenticated-store/metadata-mutation-authority";
import { AuthenticatedSegmentWriterOwner } from "@/00-storage/service/hizofs/authenticated-store/active-segment-writer-owner";
import { PreparedMutationCommitPublicationError } from "@/00-storage/service/hizofs/authenticated-store/prepared-mutation-commit-store";
import type {
  AuthenticatedMutationScopeEventObservation,
  AuthenticatedSegmentWriterDiagnosticsObservation,
  AuthenticatedStoreDiagnosticsPort,
} from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";
import {
  createInitialSuperblockCopies,
  openSuperblockCopies,
} from "@/00-storage/service/hizofs/authenticated-store/superblock-store";
import {
  generateFileSystemRootKey,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";


class AuthenticatedStoreDiagnosticsProbe implements AuthenticatedStoreDiagnosticsPort {
  private readonly mutationMetadataCache = {
    currentBytes: 0,
    currentEntries: 0,
    evictions: 0,
    hits: 0,
    maximumBytes: 0,
    maximumEntries: 0,
    misses: 0,
  };
  private readonly mutation = { abandoned: 0, completed: 0, failed: 0, overlapping: 0 };
  private readonly metadataWriter = {
    appendOperations: 0,
    appendReadBackVerifications: 0,
    created: 0,
    descriptorValidations: 0,
    rollovers: 0,
    trustedTailMatches: 0,
    trustedTailMismatches: 0,
  };

  recordCodecOperation({ durationMs, format, operation }: Parameters<AuthenticatedStoreDiagnosticsPort["recordCodecOperation"]>[0]): void {
    void durationMs;
    void format;
    void operation;
  }

  recordCryptoOperation({ durationMs, operation }: Parameters<AuthenticatedStoreDiagnosticsPort["recordCryptoOperation"]>[0]): void {
    void durationMs;
    void operation;
  }

  recordPersistedRecord({ operation, physicalBytes, plaintextBytes, recordKind }: Parameters<AuthenticatedStoreDiagnosticsPort["recordPersistedRecord"]>[0]): void {
    void operation;
    void physicalBytes;
    void plaintextBytes;
    void recordKind;
  }

  recordMetadataCacheEvent({ event, scope }: NonNullable<Parameters<NonNullable<AuthenticatedStoreDiagnosticsPort["recordMetadataCacheEvent"]>>[0]>): void {
    if (scope !== "mutation") return;
    switch (event) {
    case "eviction": this.mutationMetadataCache.evictions += 1; break;
    case "hit": this.mutationMetadataCache.hits += 1; break;
    case "miss": this.mutationMetadataCache.misses += 1; break;
    default: event satisfies never;
    }
  }

  setMetadataCacheUsage({ bytes, entries, scope }: NonNullable<Parameters<NonNullable<AuthenticatedStoreDiagnosticsPort["setMetadataCacheUsage"]>>[0]>): void {
    if (scope !== "mutation") return;
    this.mutationMetadataCache.currentBytes = bytes;
    this.mutationMetadataCache.currentEntries = entries;
    this.mutationMetadataCache.maximumBytes = Math.max(this.mutationMetadataCache.maximumBytes, bytes);
    this.mutationMetadataCache.maximumEntries = Math.max(this.mutationMetadataCache.maximumEntries, entries);
  }

  recordPublicationOperation({ durationMs }: Parameters<AuthenticatedStoreDiagnosticsPort["recordPublicationOperation"]>[0]): void {
    void durationMs;
  }

  recordMutationScopeEvent({ observation }: {
    observation: AuthenticatedMutationScopeEventObservation;
  }): void {
    if (observation.event === "begin") return;
    switch (observation.outcome) {
    case "abandoned": this.mutation.abandoned += 1; break;
    case "failed": this.mutation.failed += 1; break;
    case "accepted":
    case "published": this.mutation.completed += 1; break;
    default: observation.outcome satisfies never;
    }
  }

  recordSegmentWriterEvent({ observation: { event, segmentClass } }: {
    observation: AuthenticatedSegmentWriterDiagnosticsObservation;
  }): void {
    if (segmentClass !== "metadata") return;
    switch (event) {
    case "append_started": this.metadataWriter.appendOperations += 1; break;
    case "append_read_back_verified": this.metadataWriter.appendReadBackVerifications += 1; break;
    case "created": this.metadataWriter.created += 1; break;
    case "descriptor_validated": this.metadataWriter.descriptorValidations += 1; break;
    case "rollover": this.metadataWriter.rollovers += 1; break;
    case "trusted_tail_match": this.metadataWriter.trustedTailMatches += 1; break;
    case "trusted_tail_mismatch": this.metadataWriter.trustedTailMismatches += 1; break;
    default: event satisfies never;
    }
  }

  snapshot() {
    return {
      caches: { mutationMetadata: { ...this.mutationMetadataCache } },
      mutation: { ...this.mutation },
      segmentWriters: { metadata: { ...this.metadataWriter } },
    };
  }
}

function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}


function persistedFrameLength({ plaintextBytes }: { plaintextBytes: number }): number {
  const unaligned = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordFrameHeader
    + plaintextBytes
    + HIZOFS_V1_FORMAT_CONSTANTS.crypto.tagBytes;
  return Math.ceil(unaligned / 8) * 8;
}

function exactCapacityFill({
  bytesAlreadyUsed,
  commitFrameLength,
  largeFrameLength,
  smallFrameLength,
}: {
  bytesAlreadyUsed: number;
  commitFrameLength: number;
  largeFrameLength: number;
  smallFrameLength: number;
}): Readonly<{ largeCount: number; remainingBytes: number; smallCount: number }> {
  const capacity = HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataSegmentDataBytes;
  const available = capacity - bytesAlreadyUsed;
  for (let largeCount = Math.floor(available / largeFrameLength); largeCount >= 0; largeCount -= 1) {
    const afterLarge = available - largeCount * largeFrameLength;
    const smallCount = Math.floor(afterLarge / smallFrameLength);
    const remainingBytes = afterLarge - smallCount * smallFrameLength;
    if (remainingBytes < commitFrameLength) return { largeCount, remainingBytes, smallCount };
  }
  throw new Error("metadata capacity fixture cannot force Commit rollover");
}

async function createCandidateAuthorityFixture({ diagnostics }: {
  diagnostics: AuthenticatedStoreDiagnosticsProbe;
}) {
  const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
  const randomSource = deterministicRandomSource();
  const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
  const rootKey = generateFileSystemRootKey({ randomSource });
  const bootstrap = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
  const base = await createInitialSuperblockCopies({
    backend,
    fileSystemId,
    logicalState: {
      activeCommitHomeRef: bootstrap.activeCommitHomeRef,
      activeCommitSequence: bootstrap.activeCommitSequence,
      activeMutationId: bootstrap.activeMutationId,
      fallbackCommitHomeRef: null,
      minimumUnlockSequence: createUnlockSequence({ value: 1n }),
      relocationIndexRootPhysicalRef: null,
      requiredFeatureBits: createFeatureBits({ value: 0n }),
    },
    randomSource,
    rootKey,
    supportedFeatureBits: createFeatureBits({ value: 0n }),
  });
  const opened = await readBootstrapRoot({
    authority: {
      commitHomeRef: bootstrap.activeCommitHomeRef,
      commitSequence: bootstrap.activeCommitSequence,
      mutationId: bootstrap.activeMutationId,
      type: "active",
    },
    backend,
    fileSystemId,
    relocationIndexRootPhysicalRef: null,
    rootKey,
  });
  const authority = await createAuthenticatedMetadataMutationAuthority({
    backend,
    diagnostics,
    fileSystemId,
    randomSource,
    relocationIndexRootPhysicalRef: null,
    rootKey,
    supportedFeatureBits: createFeatureBits({ value: 0n }),
  });
  const commitPayload = createFileSystemCommitPayload({ payload: {
    ...opened.commit,
    commitSequence: createCommitSequence({ value: 2n }),
    mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(37) }),
  } });
  return { authority, backend, base, commitPayload, fileSystemId, rootKey };
}

describe("authenticated metadata mutation authority", () => {
  it("reuses authenticated immutable metadata only within the active mutation and clears it on abandon", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const diagnostics = new AuthenticatedStoreDiagnosticsProbe();
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const bootstrap = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    const opened = await readBootstrapRoot({
      authority: {
        commitHomeRef: bootstrap.activeCommitHomeRef,
        commitSequence: bootstrap.activeCommitSequence,
        mutationId: bootstrap.activeMutationId,
        type: "active",
      },
      backend,
      fileSystemId,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    });
    const authority = await createAuthenticatedMetadataMutationAuthority({
      backend,
      diagnostics,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });

    const first = await authority.readInodeTablePage({
      isRoot: true,
      reference: opened.commit.rootInodeTableRootHomeRef,
    });
    const second = await authority.readInodeTablePage({
      isRoot: true,
      reference: opened.commit.rootInodeTableRootHomeRef,
    });

    expect(second).toEqual(first);
    expect(diagnostics.snapshot().caches.mutationMetadata).toMatchObject({
      currentEntries: 1,
      hits: 1,
      misses: 1,
    });

    authority.abandon();
    expect(diagnostics.snapshot().caches.mutationMetadata).toMatchObject({
      currentBytes: 0,
      currentEntries: 0,
      maximumEntries: 1,
    });
  });

  it("releases the shared metadata writer lease before staged acceptance becomes visible", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const writerOwner = new AuthenticatedSegmentWriterOwner({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "metadata",
    });
    const authority = await createAuthenticatedMetadataMutationAuthority({
      backend,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
      writerOwner,
    });

    expect(() => writerOwner.acquire()).toThrow("already has a lease");
    authority.prepareWorkingAcceptanceWithoutCandidate();

    const publicationLease = writerOwner.acquire();
    publicationLease.release({ disposition: "reuse" });
    expect(authority.state()).toBe("active");
    authority.completeWorkingAcceptanceWithoutCandidate();
    expect(authority.state()).toBe("closed");
    await expect(writerOwner.close()).resolves.toBeUndefined();
    rootKey.destroy();
  });

  it("closes accepted metadata mutation authority without materializing a Commit candidate", async () => {
    const diagnostics = new AuthenticatedStoreDiagnosticsProbe();
    const fixture = await createCandidateAuthorityFixture({ diagnostics });
    const before = fixture.authority.resourceUsage();

    fixture.authority.completeWorkingAcceptanceWithoutCandidate();

    expect(fixture.authority.state()).toBe("closed");
    expect(fixture.authority.resourceUsage()).toEqual(before);
    expect(() => fixture.authority.completeWorkingAcceptanceWithoutCandidate()).toThrowError(
      /mutation authority is closed/,
    );
  });

  it("provides structurally compatible page and Commit publication ports", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const diagnostics = new AuthenticatedStoreDiagnosticsProbe();
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const bootstrap = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    const base = await createInitialSuperblockCopies({
      backend,
      fileSystemId,
      logicalState: {
        activeCommitHomeRef: bootstrap.activeCommitHomeRef,
        activeCommitSequence: bootstrap.activeCommitSequence,
        activeMutationId: bootstrap.activeMutationId,
        fallbackCommitHomeRef: null,
        minimumUnlockSequence: createUnlockSequence({ value: 1n }),
        relocationIndexRootPhysicalRef: null,
        requiredFeatureBits: createFeatureBits({ value: 0n }),
      },
      randomSource,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const authority = await createAuthenticatedMetadataMutationAuthority({
      backend,
      diagnostics,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    await expect(authority.resolvePublication({
      base,
      intendedLogicalState: base.logicalState,
    })).rejects.toThrow("before the mutation authority is closed");
    const directoryRoot = await authority.writeDirectoryPage({
      isRoot: true,
      page: { entries: [], level: 0, type: "leaf" },
    });
    const newRoot = await authority.writeInodeTablePage({
      isRoot: true,
      page: {
        entries: [{
          content: { directoryTreeRootHomeRef: directoryRoot, type: "tree" },
          inodeKind: "directory",
          inodeNumber: createInodeNumber({ value: 1n }),
          inodeRevision: createInodeRevision({ value: 2n }),
          timestamps: { createdAt: null, modifiedAt: null },
        }],
        level: 0,
        type: "leaf",
      },
    });
    const commitPayload = createFileSystemCommitPayload({ payload: {
      commitSequence: createCommitSequence({ value: 2n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(17) }),
      nestedSubvolumeTableRootHomeRef: null,
      nextInodeNumber: createInodeNumber({ value: 2n }),
      nextSubvolumeId: createSubvolumeId({ value: 2n }),
      rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      rootInodeTableRootHomeRef: newRoot,
    } });
    const candidate = await authority.appendCandidate({ commitPayload });
    expect(authority.resourceUsage()).toEqual({
      appendedMetadataFrameBytes: directoryRoot.frameLength + newRoot.frameLength + candidate.commitHomeRef.frameLength,
      unpublishedPhysicalBytes: directoryRoot.frameLength + newRoot.frameLength + candidate.commitHomeRef.frameLength,
    });
    expect(authority.state()).toBe("candidate_prepared");
    await expect(openSuperblockCopies({
      backend,
      fileSystemId,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).resolves.toMatchObject({ logicalState: { activeCommitSequence: 1n } });
    const forgedCandidate = Object.freeze({
      commitHomeRef: candidate.commitHomeRef,
      commitPayload: candidate.commitPayload,
    });
    await expect(authority.publishCandidate({
      base,
      beforeFirstAuthorityWrite: () => undefined,
      candidate: forgedCandidate,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
    })).rejects.toThrow("does not belong to this authority");
    expect(authority.state()).toBe("candidate_prepared");

    const published = await authority.publishCandidate({
      base,
      beforeFirstAuthorityWrite: () => undefined,
      candidate,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
    });

    expect(authority.state()).toBe("closed");
    expect(published.commitHomeRef.segmentId).toEqual(newRoot.segmentId);
    expect(published.superblock.logicalState.activeCommitSequence).toBe(2n);
    // The two dependency-ordered metadata pages share one durable append; the
    // Commit remains a separate append because publication consumes its Home
    // Record Reference only after page materialization succeeds.
    expect(diagnostics.snapshot().segmentWriters.metadata).toMatchObject({
      appendOperations: 2,
      created: 1,
      rollovers: 0,
      trustedTailMatches: 2,
      trustedTailMismatches: 0,
    });
    expect(diagnostics.snapshot().mutation).toMatchObject({
      abandoned: 0,
      completed: 1,
      failed: 0,
      overlapping: 0,
    });
    await expect(authority.resolvePublication({
      base,
      intendedLogicalState: published.superblock.logicalState,
    })).resolves.toMatchObject({ type: "published" });
    await expect(authority.readInodeTablePage({ isRoot: true, reference: newRoot })).rejects.toThrow("closed");
    await expect(authority.readDirectoryPage({ isRoot: true, reference: directoryRoot })).rejects.toThrow("closed");
    await expect(readAuthenticatedDirectoryPage({
      backend,
      fileSystemId,
      homeReference: directoryRoot,
      isRoot: true,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).resolves.toEqual({ entries: [], level: 0, type: "leaf" });
    await expect(readAuthenticatedInodeTablePage({
      backend,
      fileSystemId,
      homeReference: newRoot,
      isRoot: true,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).resolves.toMatchObject({
      entries: [{ inodeRevision: 2n }],
      type: "leaf",
    });
    await expect(openSuperblockCopies({
      backend,
      fileSystemId,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).resolves.toMatchObject({ logicalState: { activeCommitSequence: 2n } });
    rootKey.destroy();
  });

  it("abandons an authenticated candidate without advancing durable authority", async () => {
    const diagnostics = new AuthenticatedStoreDiagnosticsProbe();
    const fixture = await createCandidateAuthorityFixture({ diagnostics });
    const candidate = await fixture.authority.appendCandidate({ commitPayload: fixture.commitPayload });
    expect(fixture.authority.state()).toBe("candidate_prepared");

    fixture.authority.abandon();

    expect(fixture.authority.state()).toBe("closed");
    expect(diagnostics.snapshot().mutation).toMatchObject({
      abandoned: 1,
      completed: 0,
      failed: 0,
    });
    await expect(fixture.authority.publishCandidate({
      base: fixture.base,
      beforeFirstAuthorityWrite: () => undefined,
      candidate,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
    })).rejects.toThrow("mutation authority is closed");
    await expect(openSuperblockCopies({
      backend: fixture.backend,
      fileSystemId: fixture.fileSystemId,
      rootKey: fixture.rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).resolves.toMatchObject({ logicalState: { activeCommitSequence: 1n } });
    fixture.rootKey.destroy();
  });

  it("transfers one prepared candidate into a runtime-owned publication authority", async () => {
    const diagnostics = new AuthenticatedStoreDiagnosticsProbe();
    const fixture = await createCandidateAuthorityFixture({ diagnostics });
    const candidate = await fixture.authority.appendCandidate({ commitPayload: fixture.commitPayload });

    const publicationAuthority = fixture.authority.detachPreparedCandidatePublication({ candidate });

    expect(fixture.authority.state()).toBe("closed");
    expect(publicationAuthority.state()).toBe("ready");
    await expect(fixture.authority.publishCandidate({
      base: fixture.base,
      beforeFirstAuthorityWrite: () => undefined,
      candidate,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
    })).rejects.toThrow("mutation authority is closed");
    await expect(fixture.authority.resolvePublication({
      base: fixture.base,
      intendedLogicalState: fixture.base.logicalState,
    })).rejects.toThrow("before a publication outcome requires resolution");

    await Promise.resolve();
    const published = await publicationAuthority.publishCandidate({
      base: fixture.base,
      beforeFirstAuthorityWrite: () => undefined,
      candidate,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
    });

    expect(publicationAuthority.state()).toBe("closed");
    expect(published.superblock.logicalState.activeCommitSequence).toBe(2n);
    expect(diagnostics.snapshot().mutation).toMatchObject({
      abandoned: 0,
      completed: 1,
      failed: 0,
    });
    await expect(publicationAuthority.resolvePublication({
      base: fixture.base,
      intendedLogicalState: published.superblock.logicalState,
    })).resolves.toMatchObject({ type: "published" });
    await expect(fixture.authority.resolvePublication({
      base: fixture.base,
      intendedLogicalState: published.superblock.logicalState,
    })).resolves.toMatchObject({ type: "published" });
    fixture.rootKey.destroy();
  });

  it("keeps a definitely not-published detached candidate retryable", async () => {
    const diagnostics = new AuthenticatedStoreDiagnosticsProbe();
    const fixture = await createCandidateAuthorityFixture({ diagnostics });
    const candidate = await fixture.authority.appendCandidate({ commitPayload: fixture.commitPayload });
    const publicationAuthority = fixture.authority.detachPreparedCandidatePublication({ candidate });
    let failure: PreparedMutationCommitPublicationError | undefined;

    try {
      await publicationAuthority.publishCandidate({
        base: fixture.base,
        beforeFirstAuthorityWrite: () => {
          throw new Error("runtime publication revoked");
        },
        candidate,
        firstPublicationSequence: createPublicationSequence({ value: 3n }),
        secondPublicationSequence: createPublicationSequence({ value: 4n }),
      });
    } catch (cause: unknown) {
      if (!(cause instanceof PreparedMutationCommitPublicationError)) throw cause;
      failure = cause;
    }
    if (failure === undefined) throw new Error("detached candidate publication unexpectedly succeeded");

    expect(publicationAuthority.state()).toBe("ready");
    expect(failure.outcome).toBe("not_published");
    expect(diagnostics.snapshot().mutation).toMatchObject({
      abandoned: 0,
      completed: 0,
      failed: 0,
    });
    const published = await publicationAuthority.publishCandidate({
      base: fixture.base,
      beforeFirstAuthorityWrite: () => undefined,
      candidate,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
    });
    expect(publicationAuthority.state()).toBe("closed");
    expect(published.superblock.logicalState.activeCommitSequence).toBe(2n);
    expect(diagnostics.snapshot().mutation).toMatchObject({
      abandoned: 0,
      completed: 1,
      failed: 0,
    });
    fixture.rootKey.destroy();
  });

  it("closes candidate publication failure and resolves it against durable authority", async () => {
    const diagnostics = new AuthenticatedStoreDiagnosticsProbe();
    const fixture = await createCandidateAuthorityFixture({ diagnostics });
    const candidate = await fixture.authority.appendCandidate({ commitPayload: fixture.commitPayload });
    let failure: PreparedMutationCommitPublicationError | undefined;
    try {
      await fixture.authority.publishCandidate({
        base: fixture.base,
        beforeFirstAuthorityWrite: () => {
          throw new Error("publication revoked");
        },
        candidate,
        firstPublicationSequence: createPublicationSequence({ value: 3n }),
        secondPublicationSequence: createPublicationSequence({ value: 4n }),
      });
    } catch (cause: unknown) {
      if (!(cause instanceof PreparedMutationCommitPublicationError)) throw cause;
      failure = cause;
    }
    if (failure === undefined) throw new Error("candidate publication unexpectedly succeeded");

    expect(failure.outcome).toBe("not_published");
    expect(fixture.authority.state()).toBe("closed");
    expect(diagnostics.snapshot().mutation).toMatchObject({
      abandoned: 0,
      completed: 0,
      failed: 1,
    });
    await expect(fixture.authority.resolvePublication({
      base: fixture.base,
      intendedLogicalState: failure.intendedLogicalState,
    })).resolves.toMatchObject({ type: "not_published" });
    await expect(openSuperblockCopies({
      backend: fixture.backend,
      fileSystemId: fixture.fileSystemId,
      rootKey: fixture.rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).resolves.toMatchObject({ logicalState: { activeCommitSequence: 1n } });
    fixture.rootKey.destroy();
  });

  it("rolls metadata page writes into a fresh segment when one mutation exceeds the record area", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const authority = await createAuthenticatedMetadataMutationAuthority({
      backend,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const fileDataHomeRef = createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: 64n }),
      frameLength: 96,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(211) }),
    } });
    const page = {
      entries: Array.from({ length: 1_024 }, (_, index) => ({
        byteLength: 1,
        dataOffset: 0,
        fileDataHomeRef,
        fileOffset: createFileOffset({ value: BigInt(index * 2) }),
      })),
      level: 0 as const,
      type: "leaf" as const,
    };

    const references = [];
    for (let index = 0; index < 96; index += 1) {
      references.push(await authority.writeFileExtentPage({ isRoot: false, page }));
    }

    const first = references.at(0);
    const last = references.at(-1);
    if (first === undefined || last === undefined) throw new Error("metadata rollover references are missing");
    expect(last.segmentId).not.toEqual(first.segmentId);
    await expect(authority.readFileExtentPage({ isRoot: false, reference: first })).resolves.toEqual(page);
    await expect(authority.readFileExtentPage({ isRoot: false, reference: last })).resolves.toEqual(page);
    authority.abandon();
    rootKey.destroy();
  });

  it("rolls only the Commit into a fresh metadata segment when shared capacity is exhausted", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const diagnostics = new AuthenticatedStoreDiagnosticsProbe();
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const bootstrap = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    const base = await createInitialSuperblockCopies({
      backend,
      fileSystemId,
      logicalState: {
        activeCommitHomeRef: bootstrap.activeCommitHomeRef,
        activeCommitSequence: bootstrap.activeCommitSequence,
        activeMutationId: bootstrap.activeMutationId,
        fallbackCommitHomeRef: null,
        minimumUnlockSequence: createUnlockSequence({ value: 1n }),
        relocationIndexRootPhysicalRef: null,
        requiredFeatureBits: createFeatureBits({ value: 0n }),
      },
      randomSource,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const authority = await createAuthenticatedMetadataMutationAuthority({
      backend,
      diagnostics,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const directoryRoot = await authority.writeDirectoryPage({
      isRoot: true,
      page: { entries: [], level: 0, type: "leaf" },
    });
    const inodeRoot = await authority.writeInodeTablePage({
      isRoot: true,
      page: {
        entries: [{
          content: { directoryTreeRootHomeRef: directoryRoot, type: "tree" },
          inodeKind: "directory",
          inodeNumber: createInodeNumber({ value: 1n }),
          inodeRevision: createInodeRevision({ value: 2n }),
          timestamps: { createdAt: null, modifiedAt: null },
        }],
        level: 0,
        type: "leaf",
      },
    });
    const commitPayload = createFileSystemCommitPayload({ payload: {
      commitSequence: createCommitSequence({ value: 2n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(29) }),
      nestedSubvolumeTableRootHomeRef: null,
      nextInodeNumber: createInodeNumber({ value: 2n }),
      nextSubvolumeId: createSubvolumeId({ value: 2n }),
      rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      rootInodeTableRootHomeRef: inodeRoot,
    } });
    const fileDataHomeRef = createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: 64n }),
      frameLength: 96,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(211) }),
    } });
    const extentPage = ({ entryCount }: { entryCount: number }) => ({
      entries: Array.from({ length: entryCount }, (_, index) => ({
        byteLength: 1,
        dataOffset: 0,
        fileDataHomeRef,
        fileOffset: createFileOffset({ value: BigInt(index * 2) }),
      })),
      level: 0 as const,
      type: "leaf" as const,
    });
    const largePage = extentPage({ entryCount: 1_024 });
    const smallPage = extentPage({ entryCount: 1 });
    const fill = exactCapacityFill({
      bytesAlreadyUsed: directoryRoot.frameLength + inodeRoot.frameLength,
      commitFrameLength: persistedFrameLength({
        plaintextBytes: encodeFileSystemCommitPayload({ payload: commitPayload }).byteLength,
      }),
      largeFrameLength: persistedFrameLength({
        plaintextBytes: encodeFileExtentPage({ isRoot: false, page: largePage }).byteLength,
      }),
      smallFrameLength: persistedFrameLength({
        plaintextBytes: encodeFileExtentPage({ isRoot: false, page: smallPage }).byteLength,
      }),
    });
    expect(fill.remainingBytes).toBeLessThan(persistedFrameLength({
      plaintextBytes: encodeFileSystemCommitPayload({ payload: commitPayload }).byteLength,
    }));
    for (let index = 0; index < fill.largeCount; index += 1) {
      await authority.writeFileExtentPage({ isRoot: false, page: largePage });
    }
    for (let index = 0; index < fill.smallCount; index += 1) {
      await authority.writeFileExtentPage({ isRoot: false, page: smallPage });
    }
    expect(diagnostics.snapshot().segmentWriters.metadata).toMatchObject({
      created: 1,
      rollovers: 0,
    });

    const published = await authority.publish({
      base,
      beforeFirstAuthorityWrite: () => undefined,
      commitPayload,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
    });

    expect(published.commitHomeRef.segmentId).not.toEqual(inodeRoot.segmentId);
    expect(diagnostics.snapshot().segmentWriters.metadata).toMatchObject({
      created: 2,
      rollovers: 1,
      trustedTailMismatches: 0,
    });
    await expect(openSuperblockCopies({
      backend,
      fileSystemId,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).resolves.toMatchObject({ logicalState: { activeCommitSequence: 2n } });
    rootKey.destroy();
  });

  it("becomes terminal after explicit abandon", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const diagnostics = new AuthenticatedStoreDiagnosticsProbe();
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const authority = await createAuthenticatedMetadataMutationAuthority({
      backend,
      diagnostics,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    authority.abandon();
    expect(authority.state()).toBe("closed");
    await expect(authority.writeInodeTablePage({
      isRoot: true,
      page: { entries: [], level: 0, type: "leaf" },
    })).rejects.toThrow("closed");
    expect(diagnostics.snapshot().mutation).toMatchObject({
      abandoned: 1,
      completed: 0,
      failed: 0,
      overlapping: 0,
    });
    rootKey.destroy();
  });
});
