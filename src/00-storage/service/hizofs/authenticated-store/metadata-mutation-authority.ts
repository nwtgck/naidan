import {
  createHomeRecordReference,
  createInodeNumber,
  type DirectoryPage,
  type FeatureBits,
  type FileExtentPage,
  type FileSystemCommitPayload,
  type FileSystemId,
  type HomeRecordReference,
  type InodeBranchPage,
  type PhysicalRecordReference,
  type PublicationSequence,
} from "@/00-storage/service/hizofs/00-format";
import type {
  FileSystemRootKey,
  RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import type { HizoFSWritableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import {
  appendAuthenticatedDirectoryPage,
  readAuthenticatedDirectoryPage,
  readAuthenticatedDirectoryPageForUpdate,
  type AuthenticatedDirectoryPageCache,
  type AuthenticatedDirectoryPageCacheAdmission,
} from "./directory-page-store";
import {
  appendAuthenticatedFileExtentPage,
  readAuthenticatedFileExtentPage,
  readAuthenticatedFileExtentPageForUpdate,
} from "./file-extent-page-store";
import {
  appendAuthenticatedInodeTablePage,
  readAuthenticatedInodeTablePage,
  readAuthenticatedInodeTablePageForUpdate,
  type AuthenticatedInodeBranchPageCache,
  type AuthenticatedInodeTablePage,
} from "./inode-table-page-store";
import type { AuthenticatedHizoFSPhysicalBytes } from "./physical-bytes";
import { AuthenticatedMetadataRecordCache } from "./metadata-record-cache";
import { runtimeHomeRecordReferenceIdentity } from "./runtime-home-record-reference-identity";
import {
  measureAuthenticatedPublicationOperation,
  type AuthenticatedStoreDiagnosticsPort,
} from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";
import {
  appendPreparedMutationCommitCandidate,
  PreparedMutationCommitPublicationError,
  publishPreparedMutationCommitCandidate,
  type PreparedMutationCommitCandidate,
  type PublishedPreparedMutationCommit,
} from "./prepared-mutation-commit-store";
import {
  AuthenticatedSegmentWriterOwner,
  type ActiveSegmentWriterReleaseDisposition,
  type AuthenticatedSegmentWriterLease,
  type AuthenticatedSegmentWriterLeaseUsage,
} from "./active-segment-writer-owner";
import type { AuthenticatedSegmentAppendTarget, AuthenticatedSegmentWriter } from "./record-appender";
import {
  AuthenticatedMetadataAppendBatch,
  AuthenticatedMetadataAppendBatchFlushRequiredError,
} from "./metadata-append-batch";
import {
  resolveMutationSuperblockPublication,
  type MutationSuperblockPublicationResolution,
  type OpenedSuperblockCopies,
  type SuperblockLogicalState,
} from "./superblock-store";

export type AuthenticatedMutationResourceUsage = Readonly<{
  appendedMetadataFrameBytes: number;
  unpublishedPhysicalBytes: number;
}>;

export type AuthenticatedMetadataMutationAuthorityState =
  | "active"
  | "candidate_prepared"
  | "closed"
  | "publishing";

export type AuthenticatedPreparedMutationPublicationAuthorityState =
  | "closed"
  | "publishing"
  | "ready"
  | "resolution_pending";

const AUTHENTICATED_PREPARED_MUTATION_PUBLICATION_AUTHORITY = Symbol(
  "authenticated prepared mutation publication authority",
);

/**
 * Runtime-owned authority for one exact authenticated Commit candidate after
 * mutation-local metadata work and its writer lease have ended. It deliberately
 * does not retain an application-operation publication assertion; the runtime
 * supplies its current-authority gate immediately before the first Superblock
 * authority write.
 */
export class AuthenticatedPreparedMutationPublicationAuthority {
  private readonly backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  private readonly candidate: PreparedMutationCommitCandidate;
  private readonly diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  private readonly fileSystemId: FileSystemId;
  private readonly metadataRecordCache: AuthenticatedMetadataRecordCache;
  private mutationDiagnosticsOpen = true;
  private readonly randomSource: RandomByteSource | undefined;
  private readonly rootKey: FileSystemRootKey;
  private stateValue: AuthenticatedPreparedMutationPublicationAuthorityState = "ready";
  private readonly supportedFeatureBits: FeatureBits;

  constructor({
    authority,
    backend,
    candidate,
    diagnostics,
    fileSystemId,
    metadataRecordCache,
    mutationScopeDiagnostics,
    randomSource,
    rootKey,
    supportedFeatureBits,
  }: {
    authority: typeof AUTHENTICATED_PREPARED_MUTATION_PUBLICATION_AUTHORITY;
    backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
    candidate: PreparedMutationCommitCandidate;
    diagnostics?: AuthenticatedStoreDiagnosticsPort;
    fileSystemId: FileSystemId;
    metadataRecordCache: AuthenticatedMetadataRecordCache;
    mutationScopeDiagnostics: MutationScopeDiagnosticsMode;
    randomSource?: RandomByteSource;
    rootKey: FileSystemRootKey;
    supportedFeatureBits: FeatureBits;
  }) {
    if (authority !== AUTHENTICATED_PREPARED_MUTATION_PUBLICATION_AUTHORITY) {
      throw new TypeError("detached publication authority requires authenticated construction");
    }
    this.backend = backend;
    this.candidate = candidate;
    this.diagnostics = diagnostics;
    this.fileSystemId = fileSystemId;
    this.metadataRecordCache = metadataRecordCache;
    this.mutationDiagnosticsOpen = shouldRecordMutationScopeDiagnostics({ mode: mutationScopeDiagnostics });
    this.randomSource = randomSource;
    this.rootKey = rootKey;
    this.supportedFeatureBits = supportedFeatureBits;
  }

  state(): AuthenticatedPreparedMutationPublicationAuthorityState {
    return this.stateValue;
  }

  private closeDiagnostics({ outcome }: {
    outcome: "abandoned" | "accepted" | "failed" | "published";
  }): void {
    if (!this.mutationDiagnosticsOpen) return;
    this.mutationDiagnosticsOpen = false;
    this.metadataRecordCache.dispose();
    this.diagnostics?.recordMutationScopeEvent?.({ observation: { event: "end", outcome } });
  }

  completeWorkingAcceptance(): void {
    switch (this.stateValue) {
    case "ready":
      this.closeDiagnostics({ outcome: "accepted" });
      return;
    case "closed":
    case "publishing":
    case "resolution_pending":
      throw new Error(`cannot complete working acceptance while detached publication is ${this.stateValue}`);
    default: return this.stateValue satisfies never;
    }
  }

  async publishCandidate({
    base,
    beforeFirstAuthorityWrite,
    candidate,
    firstPublicationSequence,
    secondPublicationSequence,
  }: {
    base: OpenedSuperblockCopies;
    beforeFirstAuthorityWrite: () => void;
    candidate: PreparedMutationCommitCandidate;
    firstPublicationSequence: PublicationSequence;
    secondPublicationSequence: PublicationSequence;
  }): Promise<PublishedPreparedMutationCommit> {
    switch (this.stateValue) {
    case "ready": break;
    case "closed": throw new Error("cannot publish candidate: detached publication authority is closed");
    case "publishing": throw new Error("cannot publish candidate: detached publication authority is publishing");
    case "resolution_pending": throw new Error(
      "cannot publish candidate: detached publication authority requires outcome resolution",
    );
    default: return this.stateValue satisfies never;
    }
    if (candidate !== this.candidate) {
      throw new TypeError("prepared mutation candidate does not belong to this detached publication authority");
    }
    this.stateValue = "publishing";
    let firstAuthorityWriteMayHaveStarted = false;
    try {
      const published = await measureAuthenticatedPublicationOperation({
        diagnostics: this.diagnostics,
        run: async () => await publishPreparedMutationCommitCandidate({
          backend: this.backend,
          base,
          beforeFirstAuthorityWrite: () => {
            beforeFirstAuthorityWrite();
            firstAuthorityWriteMayHaveStarted = true;
          },
          candidate,
          diagnostics: this.diagnostics,
          fileSystemId: this.fileSystemId,
          firstPublicationSequence,
          randomSource: this.randomSource,
          rootKey: this.rootKey,
          secondPublicationSequence,
          supportedFeatureBits: this.supportedFeatureBits,
        }),
      });
      this.stateValue = "closed";
      this.closeDiagnostics({ outcome: "published" });
      return published;
    } catch (cause: unknown) {
      if (!firstAuthorityWriteMayHaveStarted) {
        this.stateValue = "ready";
      } else if (!(cause instanceof PreparedMutationCommitPublicationError)) {
        this.stateValue = "resolution_pending";
      } else {
        switch (cause.outcome) {
        case "not_published": this.stateValue = "ready"; break;
        case "committed_redundancy_degraded":
        case "outcome_resolution_required":
        case undefined: this.stateValue = "resolution_pending"; break;
        default: cause.outcome satisfies never;
        }
      }
      throw cause;
    }
  }

  async resolvePublication({ base, intendedLogicalState }: {
    base: OpenedSuperblockCopies;
    intendedLogicalState: SuperblockLogicalState;
  }): Promise<MutationSuperblockPublicationResolution> {
    const stateBeforeResolution = this.stateValue;
    switch (stateBeforeResolution) {
    case "closed":
    case "resolution_pending": break;
    case "publishing": throw new Error("cannot resolve publication while the detached publication authority is publishing");
    case "ready": throw new Error("cannot resolve publication before a publication outcome requires resolution");
    default: return stateBeforeResolution satisfies never;
    }
    const resolution = await resolveMutationSuperblockPublication({
      backend: this.backend,
      base,
      diagnostics: this.diagnostics,
      fileSystemId: this.fileSystemId,
      intendedLogicalState,
      rootKey: this.rootKey,
      supportedFeatureBits: this.supportedFeatureBits,
    });
    switch (stateBeforeResolution) {
    case "closed": return resolution;
    case "resolution_pending": break;
    default: return stateBeforeResolution satisfies never;
    }
    switch (resolution.type) {
    case "not_published":
      this.stateValue = "ready";
      return resolution;
    case "publication_conflict":
      this.stateValue = "closed";
      this.closeDiagnostics({ outcome: "failed" });
      return resolution;
    case "published":
      this.stateValue = "closed";
      this.closeDiagnostics({ outcome: "published" });
      return resolution;
    default: return resolution satisfies never;
    }
  }

  completeExternallyResolvedPublication({ outcome }: {
    outcome: "not_published" | "published";
  }): void {
    switch (this.stateValue) {
    case "closed": return;
    case "resolution_pending":
      this.stateValue = "closed";
      switch (outcome) {
      case "not_published": this.closeDiagnostics({ outcome: "abandoned" }); return;
      case "published": this.closeDiagnostics({ outcome: "published" }); return;
      default: return outcome satisfies never;
      }
    case "publishing": throw new Error(
      "cannot complete external publication resolution while the detached authority is publishing",
    );
    case "ready": throw new Error(
      "cannot complete external publication resolution before an outcome requires resolution",
    );
    default: return this.stateValue satisfies never;
    }
  }

  abandon(): void {
    switch (this.stateValue) {
    case "ready":
      this.stateValue = "closed";
      this.closeDiagnostics({ outcome: "abandoned" });
      return;
    case "closed": return;
    case "publishing": throw new Error("cannot abandon detached publication authority during publication");
    case "resolution_pending": throw new Error("cannot abandon detached publication authority with an unresolved publication outcome");
    default: return this.stateValue satisfies never;
    }
  }
}

// Mutation-local plaintext is intentionally smaller than the session cache.
// The full Home Record Reference remains the identity, and disposal is coupled
// to the terminal mutation outcome rather than session lifetime.
const MUTATION_METADATA_RECORD_CACHE_POLICY = Object.freeze({
  maximumBytes: 2 * 1024 * 1024,
  maximumEntries: 256,
});

type MutationScopeDiagnosticsMode = "record" | "suppress";

type PendingInodeBranchPage = Readonly<{
  isRoot: boolean;
  page: InodeBranchPage;
  reference: HomeRecordReference;
}>;

function inodeBranchIdentity({ isRoot, reference }: {
  isRoot: boolean;
  reference: HomeRecordReference;
}): string {
  return `${isRoot ? "root" : "non_root"}:${runtimeHomeRecordReferenceIdentity({ reference })}`;
}

function cloneInodeBranchPage({ page }: { page: InodeBranchPage }): InodeBranchPage {
  return Object.freeze({
    entries: Object.freeze(page.entries.map(entry => Object.freeze({
      childPageHomeRef: createHomeRecordReference({ fields: entry.childPageHomeRef }),
      upperBound: createInodeNumber({ value: entry.upperBound }),
    }))),
    level: page.level,
  });
}

function shouldRecordMutationScopeDiagnostics({ mode }: {
  mode: MutationScopeDiagnosticsMode;
}): boolean {
  switch (mode) {
  case "record": return true;
  case "suppress": return false;
  default: return mode satisfies never;
  }
}

export class AuthenticatedMetadataMutationAuthority {
  private readonly backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  private readonly decodedDirectoryPageCache: AuthenticatedDirectoryPageCache | undefined;
  private readonly decodedInodeBranchPageCache: AuthenticatedInodeBranchPageCache | undefined;
  private readonly diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  private readonly fileSystemId: FileSystemId;
  private readonly metadataRecordCache: AuthenticatedMetadataRecordCache;
  private readonly mutationScopeDiagnostics: MutationScopeDiagnosticsMode;
  private readonly randomSource: RandomByteSource | undefined;
  private readonly relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
  private readonly rootKey: FileSystemRootKey;
  private readonly sharedMetadataRecordCache: AuthenticatedMetadataRecordCache | undefined;
  private readonly supportedFeatureBits: FeatureBits;
  private mutationDiagnosticsOpen = true;
  private pendingAppendBatch: AuthenticatedMetadataAppendBatch | undefined;
  // Metadata batching may return a predicted Home Reference before the Record is physically durable.
  // Keep branch routing mutation-local until that prediction is proven by the batch flush so an
  // abandoned provisional slot can never alias a later Record through the session cache.
  private readonly pendingInodeBranchPages = new Map<string, PendingInodeBranchPage>();
  private pendingDirectoryPageAdmissions: AuthenticatedDirectoryPageCacheAdmission[] = [];
  private releasedWriterUsage: AuthenticatedSegmentWriterLeaseUsage | undefined;
  private operationInProgress = false;
  private detachedPublicationAuthority: AuthenticatedPreparedMutationPublicationAuthority | undefined;
  private preparedCandidate: PreparedMutationCommitCandidate | undefined;
  private stateValue: AuthenticatedMetadataMutationAuthorityState = "active";
  private workingAcceptancePrepared = false;
  private readonly writerLease: AuthenticatedSegmentWriterLease;
  private writerLeaseReleased = false;
  private readonly writerReleaseDisposition: ActiveSegmentWriterReleaseDisposition;

  private constructor({
    backend,
    decodedDirectoryPageCache,
    decodedInodeBranchPageCache,
    diagnostics,
    fileSystemId,
    metadataRecordCache,
    mutationScopeDiagnostics,
    randomSource,
    relocationIndexRootPhysicalRef,
    rootKey,
    sharedMetadataRecordCache,
    supportedFeatureBits,
    writerLease,
    writerReleaseDisposition,
  }: {
    backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
    decodedDirectoryPageCache?: AuthenticatedDirectoryPageCache;
    decodedInodeBranchPageCache?: AuthenticatedInodeBranchPageCache;
    diagnostics?: AuthenticatedStoreDiagnosticsPort;
    fileSystemId: FileSystemId;
    metadataRecordCache: AuthenticatedMetadataRecordCache;
    mutationScopeDiagnostics: MutationScopeDiagnosticsMode;
    randomSource?: RandomByteSource;
    relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
    rootKey: FileSystemRootKey;
    sharedMetadataRecordCache?: AuthenticatedMetadataRecordCache;
    supportedFeatureBits: FeatureBits;
    writerLease: AuthenticatedSegmentWriterLease;
    writerReleaseDisposition: ActiveSegmentWriterReleaseDisposition;
  }) {
    this.backend = backend;
    this.decodedDirectoryPageCache = decodedDirectoryPageCache;
    this.decodedInodeBranchPageCache = decodedInodeBranchPageCache;
    this.diagnostics = diagnostics;
    this.fileSystemId = fileSystemId;
    this.metadataRecordCache = metadataRecordCache;
    this.mutationScopeDiagnostics = mutationScopeDiagnostics;
    this.mutationDiagnosticsOpen = shouldRecordMutationScopeDiagnostics({ mode: mutationScopeDiagnostics });
    this.randomSource = randomSource;
    this.relocationIndexRootPhysicalRef = relocationIndexRootPhysicalRef;
    this.rootKey = rootKey;
    this.sharedMetadataRecordCache = sharedMetadataRecordCache;
    this.supportedFeatureBits = supportedFeatureBits;
    this.writerLease = writerLease;
    this.writerReleaseDisposition = writerReleaseDisposition;
  }

  static async create({
    backend,
    decodedDirectoryPageCache,
    decodedInodeBranchPageCache,
    diagnostics,
    fileSystemId,
    mutationScopeDiagnostics = "record",
    randomSource,
    relocationIndexRootPhysicalRef,
    rootKey,
    sharedMetadataRecordCache,
    supportedFeatureBits,
    writerOwner,
  }: {
    backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
    decodedDirectoryPageCache?: AuthenticatedDirectoryPageCache;
    decodedInodeBranchPageCache?: AuthenticatedInodeBranchPageCache;
    diagnostics?: AuthenticatedStoreDiagnosticsPort;
    fileSystemId: FileSystemId;
    mutationScopeDiagnostics?: MutationScopeDiagnosticsMode;
    randomSource?: RandomByteSource;
    relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
    rootKey: FileSystemRootKey;
    sharedMetadataRecordCache?: AuthenticatedMetadataRecordCache;
    supportedFeatureBits: FeatureBits;
    writerOwner?: AuthenticatedSegmentWriterOwner;
  }): Promise<AuthenticatedMetadataMutationAuthority> {
    const recordMutationScopeDiagnostics = shouldRecordMutationScopeDiagnostics({ mode: mutationScopeDiagnostics });
    if (recordMutationScopeDiagnostics) {
      diagnostics?.recordMutationScopeEvent?.({ observation: { event: "begin" } });
    }
    const metadataRecordCache = new AuthenticatedMetadataRecordCache({
      diagnosticScope: "mutation",
      diagnostics,
      policy: MUTATION_METADATA_RECORD_CACHE_POLICY,
    });
    try {
      const mutationLocalWriterOwner = writerOwner ?? new AuthenticatedSegmentWriterOwner({
        backend,
        diagnostics,
        fileSystemId,
        randomSource,
        rootKey,
        segmentClass: "metadata",
      });
      return new AuthenticatedMetadataMutationAuthority({
        backend,
        decodedDirectoryPageCache,
        decodedInodeBranchPageCache,
        diagnostics,
        fileSystemId,
        metadataRecordCache,
        mutationScopeDiagnostics,
        randomSource,
        relocationIndexRootPhysicalRef,
        rootKey,
        sharedMetadataRecordCache,
        supportedFeatureBits,
        writerLease: mutationLocalWriterOwner.acquire(),
        writerReleaseDisposition: writerOwner === undefined ? "discard" : "reuse",
      });
    } catch (error: unknown) {
      metadataRecordCache.dispose();
      if (recordMutationScopeDiagnostics) {
        diagnostics?.recordMutationScopeEvent?.({ observation: { event: "end", outcome: "failed" } });
      }
      throw error;
    }
  }

  state(): AuthenticatedMetadataMutationAuthorityState {
    return this.stateValue;
  }

  resourceUsage(): AuthenticatedMutationResourceUsage {
    const persistedMetadataFrameBytes = (
      this.releasedWriterUsage ?? this.writerLease.usage()
    ).appendedEncryptedFrameBytes;
    const provisionalMetadataFrameBytes = this.pendingAppendBatch?.pendingFrameBytes() ?? 0;
    const appendedMetadataFrameBytes = persistedMetadataFrameBytes + provisionalMetadataFrameBytes;
    if (!Number.isSafeInteger(appendedMetadataFrameBytes)) {
      throw new Error("metadata mutation resource usage exceeds the safe integer bound");
    }
    // Provisional frames already own exact immutable references. Count their
    // eventual physical bytes in the admission reservation even before the
    // batch is flushed, then the same bytes move into persisted writer usage.
    return Object.freeze({
      appendedMetadataFrameBytes,
      unpublishedPhysicalBytes: appendedMetadataFrameBytes,
    });
  }

  private requireActive({ operation }: { operation: string }): void {
    switch (this.stateValue) {
    case "active": break;
    case "candidate_prepared": throw new Error(`cannot ${operation}: mutation candidate is already prepared`);
    case "closed": throw new Error(`cannot ${operation}: mutation authority is closed`);
    case "publishing": throw new Error(`cannot ${operation}: mutation authority is publishing`);
    default: return this.stateValue satisfies never;
    }
    if (this.operationInProgress) throw new Error("mutation authority operation already in progress");
    if (this.workingAcceptancePrepared) {
      throw new Error(`cannot ${operation}: mutation authority writer lease is released for working acceptance`);
    }
  }

  private closeMutationDiagnostics({ outcome }: {
    outcome: "abandoned" | "accepted" | "failed" | "published";
  }): void {
    if (!this.mutationDiagnosticsOpen) return;
    this.mutationDiagnosticsOpen = false;
    this.metadataRecordCache.dispose();
    this.diagnostics?.recordMutationScopeEvent?.({ observation: { event: "end", outcome } });
  }

  private discardPendingDirectoryPageAdmissions(): void {
    const admissions = this.pendingDirectoryPageAdmissions;
    this.pendingDirectoryPageAdmissions = [];
    for (const admission of admissions) admission.discard();
  }

  private discardPendingAppendBatch(): void {
    this.pendingAppendBatch?.discard();
    this.pendingAppendBatch = undefined;
    this.pendingInodeBranchPages.clear();
    this.discardPendingDirectoryPageAdmissions();
  }

  private releaseWriterLease(): void {
    if (this.writerLeaseReleased) return;
    if (this.pendingAppendBatch?.hasRecords() === true) {
      throw new Error("cannot release metadata writer lease while a provisional append batch is pending");
    }
    if (this.pendingInodeBranchPages.size !== 0) {
      throw new Error("cannot release metadata writer lease while provisional Inode branch routing is pending");
    }
    if (this.pendingDirectoryPageAdmissions.length !== 0) {
      throw new Error("cannot release metadata writer lease while provisional Directory page cache admission is pending");
    }
    this.pendingAppendBatch?.discard();
    this.pendingAppendBatch = undefined;
    this.releasedWriterUsage = this.writerLease.usage();
    this.writerLeaseReleased = true;
    this.writerLease.release({ disposition: this.writerReleaseDisposition });
  }

  private async flushPendingAppendBatch(): Promise<void> {
    const batch = this.pendingAppendBatch;
    const branchPages = [...this.pendingInodeBranchPages.values()];
    const directoryAdmissions = this.pendingDirectoryPageAdmissions;
    this.pendingInodeBranchPages.clear();
    this.pendingDirectoryPageAdmissions = [];
    if (batch === undefined) {
      for (const admission of directoryAdmissions) admission.discard();
      if (branchPages.length !== 0 || directoryAdmissions.length !== 0) {
        throw new Error("provisional metadata routing exists without a metadata append batch");
      }
      return;
    }
    this.pendingAppendBatch = undefined;
    if (!batch.hasRecords()) {
      batch.discard();
      for (const admission of directoryAdmissions) admission.discard();
      if (branchPages.length !== 0 || directoryAdmissions.length !== 0) {
        throw new Error("provisional metadata routing exists for an empty metadata append batch");
      }
      return;
    }
    try {
      await this.writerLease.append({
        append: async ({ writer }) => {
          if (!batch.isBoundTo({ writer })) {
            batch.discard();
            throw new Error("metadata append batch writer ownership changed before flush");
          }
          await batch.flush();
        },
      });
    } catch (error: unknown) {
      for (const admission of directoryAdmissions) admission.discard();
      throw error;
    }
    // batch.flush() has matched every predicted Home Reference to the durable append result. Only
    // after that proof may routing metadata escape the mutation and become reusable session state.
    try {
      for (const admission of directoryAdmissions) admission.commit();
    } catch (error: unknown) {
      for (const admission of directoryAdmissions) admission.discard();
      throw error;
    }
    for (const branchPage of branchPages) {
      this.decodedInodeBranchPageCache?.setBranchPage(branchPage);
    }
  }

  private async appendMetadataPageWithBatch<Result>({ append }: {
    append: ({ writer }: { writer: AuthenticatedSegmentAppendTarget }) => Promise<Result>;
  }): Promise<Result> {
    while (true) {
      const outcome = await this.writerLease.append({
        append: async ({ writer }) => {
          const existing = this.pendingAppendBatch;
          if (existing !== undefined && !existing.isBoundTo({ writer })) {
            if (existing.hasRecords()) {
              throw new Error("metadata append batch writer changed while records were pending");
            }
            existing.discard();
            this.pendingAppendBatch = undefined;
          }
          const batch = this.pendingAppendBatch ?? new AuthenticatedMetadataAppendBatch({
            mutationCache: this.metadataRecordCache,
            sharedCache: this.sharedMetadataRecordCache,
            writer,
          });
          this.pendingAppendBatch = batch;
          try {
            return Object.freeze({
              type: "result" as const,
              value: await append({ writer: batch.appendTarget() }),
            });
          } catch (cause: unknown) {
            if (cause instanceof AuthenticatedMetadataAppendBatchFlushRequiredError) {
              return Object.freeze({ type: "flush_required" as const });
            }
            throw cause;
          }
        },
      });
      switch (outcome.type) {
      case "result": return outcome.value;
      case "flush_required":
        await this.flushPendingAppendBatch();
        break;
      default: return outcome satisfies never;
      }
    }
  }

  private async flushProvisionalReferenceBeforeRead({ reference }: {
    reference: HomeRecordReference;
  }): Promise<void> {
    if (this.pendingAppendBatch?.hasPlannedHomeReference({ reference }) !== true) return;
    // A provisional Home Reference predicts the exact durable append location,
    // but it is not physically readable until that bounded batch is flushed.
    // Mutation-local caches may accelerate read-your-writes, but cache
    // retention must never decide whether a valid reference is readable.
    await this.flushPendingAppendBatch();
  }

  private async appendMetadataRecordWithRollover<Result>({ append }: {
    append: ({ writer }: { writer: AuthenticatedSegmentWriter }) => Promise<Result>;
  }): Promise<Result> {
    await this.flushPendingAppendBatch();
    return await this.writerLease.append({ append });
  }

  async flushPendingMetadataRecords(): Promise<void> {
    this.requireActive({ operation: "flush provisional metadata Records" });
    this.operationInProgress = true;
    try {
      await this.flushPendingAppendBatch();
    } finally {
      this.operationInProgress = false;
    }
  }

  async readFileExtentPage({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): Promise<FileExtentPage> {
    this.requireActive({ operation: "read a File Extent page" });
    this.operationInProgress = true;
    try {
      await this.flushProvisionalReferenceBeforeRead({ reference });
      return await readAuthenticatedFileExtentPage({
        backend: this.backend,
        diagnostics: this.diagnostics,
        fileSystemId: this.fileSystemId,
        homeReference: reference,
        isRoot,
        metadataRecordCache: this.metadataRecordCache,
        sharedMetadataRecordCache: this.sharedMetadataRecordCache,
        relocationIndexRootPhysicalRef: this.relocationIndexRootPhysicalRef,
        rootKey: this.rootKey,
      });
    } finally {
      this.operationInProgress = false;
    }
  }

  async readFileExtentPageForUpdate({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): Promise<Awaited<ReturnType<typeof readAuthenticatedFileExtentPageForUpdate>>> {
    this.requireActive({ operation: "read a File Extent page for update" });
    this.operationInProgress = true;
    try {
      await this.flushProvisionalReferenceBeforeRead({ reference });
      return await readAuthenticatedFileExtentPageForUpdate({
        backend: this.backend,
        diagnostics: this.diagnostics,
        fileSystemId: this.fileSystemId,
        homeReference: reference,
        isRoot,
        metadataRecordCache: this.metadataRecordCache,
        sharedMetadataRecordCache: this.sharedMetadataRecordCache,
        relocationIndexRootPhysicalRef: this.relocationIndexRootPhysicalRef,
        rootKey: this.rootKey,
      });
    } finally {
      this.operationInProgress = false;
    }
  }

  async writeFileExtentPage({ isRoot, page }: {
    isRoot: boolean;
    page: FileExtentPage;
  }): Promise<HomeRecordReference> {
    this.requireActive({ operation: "write a File Extent page" });
    this.operationInProgress = true;
    try {
      return await this.appendMetadataPageWithBatch({
        append: async ({ writer }) => await appendAuthenticatedFileExtentPage({
          isRoot,
          page,
          sharedMetadataRecordCache: undefined,
          writer,
        }),
      });
    } finally {
      this.operationInProgress = false;
    }
  }

  async readInodeTablePage({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): Promise<AuthenticatedInodeTablePage> {
    this.requireActive({ operation: "read an Inode Table page" });
    this.operationInProgress = true;
    try {
      const pending = this.pendingInodeBranchPages.get(inodeBranchIdentity({ isRoot, reference }));
      if (pending !== undefined) {
        return { ...cloneInodeBranchPage({ page: pending.page }), type: "branch" };
      }
      await this.flushProvisionalReferenceBeforeRead({ reference });
      return await readAuthenticatedInodeTablePage({
        backend: this.backend,
        decodedBranchPageCache: this.decodedInodeBranchPageCache,
        diagnostics: this.diagnostics,
        fileSystemId: this.fileSystemId,
        homeReference: reference,
        isRoot,
        metadataRecordCache: this.metadataRecordCache,
        sharedMetadataRecordCache: this.sharedMetadataRecordCache,
        relocationIndexRootPhysicalRef: this.relocationIndexRootPhysicalRef,
        rootKey: this.rootKey,
      });
    } finally {
      this.operationInProgress = false;
    }
  }

  async readInodeTablePageForUpdate({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): Promise<Awaited<ReturnType<typeof readAuthenticatedInodeTablePageForUpdate>> | undefined> {
    this.requireActive({ operation: "read an Inode Table page for update" });
    this.operationInProgress = true;
    try {
      const pending = this.pendingInodeBranchPages.get(inodeBranchIdentity({ isRoot, reference }));
      if (pending !== undefined) return undefined;
      await this.flushProvisionalReferenceBeforeRead({ reference });
      return await readAuthenticatedInodeTablePageForUpdate({
        backend: this.backend,
        decodedBranchPageCache: this.decodedInodeBranchPageCache,
        diagnostics: this.diagnostics,
        fileSystemId: this.fileSystemId,
        homeReference: reference,
        isRoot,
        metadataRecordCache: this.metadataRecordCache,
        sharedMetadataRecordCache: this.sharedMetadataRecordCache,
        relocationIndexRootPhysicalRef: this.relocationIndexRootPhysicalRef,
        rootKey: this.rootKey,
      });
    } finally {
      this.operationInProgress = false;
    }
  }

  async writeInodeTablePage({ isRoot, page }: {
    isRoot: boolean;
    page: AuthenticatedInodeTablePage;
  }): Promise<HomeRecordReference> {
    this.requireActive({ operation: "write an Inode Table page" });
    this.operationInProgress = true;
    try {
      const reference = await this.appendMetadataPageWithBatch({
        append: async ({ writer }) => await appendAuthenticatedInodeTablePage({
          isRoot,
          page,
          sharedMetadataRecordCache: undefined,
          writer,
        }),
      });
      switch (page.type) {
      case "branch":
        this.pendingInodeBranchPages.set(inodeBranchIdentity({ isRoot, reference }), Object.freeze({
          isRoot,
          page: cloneInodeBranchPage({ page }),
          reference: createHomeRecordReference({ fields: reference }),
        }));
        break;
      case "leaf": break;
      default: return page satisfies never;
      }
      return reference;
    } finally {
      this.operationInProgress = false;
    }
  }

  async readDirectoryPage({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): Promise<DirectoryPage> {
    this.requireActive({ operation: "read a Directory page" });
    this.operationInProgress = true;
    try {
      await this.flushProvisionalReferenceBeforeRead({ reference });
      return await readAuthenticatedDirectoryPage({
        backend: this.backend,
        decodedPageCache: this.decodedDirectoryPageCache,
        diagnostics: this.diagnostics,
        fileSystemId: this.fileSystemId,
        homeReference: reference,
        isRoot,
        metadataRecordCache: this.metadataRecordCache,
        sharedMetadataRecordCache: this.sharedMetadataRecordCache,
        relocationIndexRootPhysicalRef: this.relocationIndexRootPhysicalRef,
        rootKey: this.rootKey,
      });
    } finally {
      this.operationInProgress = false;
    }
  }

  async readDirectoryPageForUpdate({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): Promise<Awaited<ReturnType<typeof readAuthenticatedDirectoryPageForUpdate>>> {
    this.requireActive({ operation: "read a Directory page for update" });
    this.operationInProgress = true;
    try {
      await this.flushProvisionalReferenceBeforeRead({ reference });
      return await readAuthenticatedDirectoryPageForUpdate({
        backend: this.backend,
        decodedPageCache: this.decodedDirectoryPageCache,
        diagnostics: this.diagnostics,
        fileSystemId: this.fileSystemId,
        homeReference: reference,
        isRoot,
        metadataRecordCache: this.metadataRecordCache,
        sharedMetadataRecordCache: this.sharedMetadataRecordCache,
        relocationIndexRootPhysicalRef: this.relocationIndexRootPhysicalRef,
        rootKey: this.rootKey,
      });
    } finally {
      this.operationInProgress = false;
    }
  }

  async writeDirectoryPage({ isRoot, page }: {
    isRoot: boolean;
    page: DirectoryPage;
  }): Promise<HomeRecordReference> {
    this.requireActive({ operation: "write a Directory page" });
    this.operationInProgress = true;
    try {
      const appended = await this.appendMetadataPageWithBatch({
        append: async ({ writer }) => await appendAuthenticatedDirectoryPage({
          isRoot,
          page,
          sharedMetadataRecordCache: undefined,
          writer,
        }),
      });
      if (this.decodedDirectoryPageCache !== undefined) {
        this.pendingDirectoryPageAdmissions.push(this.decodedDirectoryPageCache.preparePageAdmission({
          encodedByteLength: appended.encodedByteLength,
          isRoot,
          page,
          reference: appended.homeReference,
        }));
      }
      return appended.homeReference;
    } finally {
      this.operationInProgress = false;
    }
  }

  async appendCandidate({ commitPayload }: {
    commitPayload: FileSystemCommitPayload;
  }): Promise<PreparedMutationCommitCandidate> {
    this.requireActive({ operation: "append the prepared Commit candidate" });
    this.operationInProgress = true;
    try {
      const candidate = await this.appendMetadataRecordWithRollover({
        append: async ({ writer }) => await appendPreparedMutationCommitCandidate({
          commitPayload,
          writer,
        }),
      });
      this.preparedCandidate = candidate;
      this.releaseWriterLease();
      this.stateValue = "candidate_prepared";
      return candidate;
    } catch (cause: unknown) {
      this.releaseWriterLease();
      this.stateValue = "closed";
      this.closeMutationDiagnostics({ outcome: "failed" });
      throw cause;
    } finally {
      this.operationInProgress = false;
    }
  }

  detachPreparedCandidatePublication({ candidate }: {
    candidate: PreparedMutationCommitCandidate;
  }): AuthenticatedPreparedMutationPublicationAuthority {
    switch (this.stateValue) {
    case "candidate_prepared": break;
    case "active": throw new Error("cannot detach publication authority before a candidate is prepared");
    case "closed": throw new Error("cannot detach publication authority: mutation authority is closed");
    case "publishing": throw new Error("cannot detach publication authority during publication");
    default: return this.stateValue satisfies never;
    }
    if (candidate !== this.preparedCandidate) {
      throw new TypeError("prepared mutation candidate does not belong to this authority");
    }
    const detached = new AuthenticatedPreparedMutationPublicationAuthority({
      authority: AUTHENTICATED_PREPARED_MUTATION_PUBLICATION_AUTHORITY,
      backend: this.backend,
      candidate,
      diagnostics: this.diagnostics,
      fileSystemId: this.fileSystemId,
      metadataRecordCache: this.metadataRecordCache,
      mutationScopeDiagnostics: this.mutationScopeDiagnostics,
      randomSource: this.randomSource,
      rootKey: this.rootKey,
      supportedFeatureBits: this.supportedFeatureBits,
    });
    this.detachedPublicationAuthority = detached;
    this.preparedCandidate = undefined;
    this.mutationDiagnosticsOpen = false;
    this.stateValue = "closed";
    return detached;
  }

  async publishCandidate({
    base,
    beforeFirstAuthorityWrite,
    candidate,
    firstPublicationSequence,
    secondPublicationSequence,
  }: {
    base: OpenedSuperblockCopies;
    beforeFirstAuthorityWrite: () => void;
    candidate: PreparedMutationCommitCandidate;
    firstPublicationSequence: PublicationSequence;
    secondPublicationSequence: PublicationSequence;
  }): Promise<PublishedPreparedMutationCommit> {
    switch (this.stateValue) {
    case "candidate_prepared": break;
    case "active": throw new Error("cannot publish candidate before it is prepared");
    case "closed": throw new Error("cannot publish candidate: mutation authority is closed");
    case "publishing": throw new Error("cannot publish candidate: mutation authority is publishing");
    default: return this.stateValue satisfies never;
    }
    if (candidate !== this.preparedCandidate) {
      throw new TypeError("prepared mutation candidate does not belong to this authority");
    }
    this.stateValue = "publishing";
    let outcome: "failed" | "published" = "failed";
    try {
      const published = await measureAuthenticatedPublicationOperation({
        diagnostics: this.diagnostics,
        run: async () => await publishPreparedMutationCommitCandidate({
          backend: this.backend,
          base,
          beforeFirstAuthorityWrite,
          candidate,
          diagnostics: this.diagnostics,
          fileSystemId: this.fileSystemId,
          firstPublicationSequence,
          randomSource: this.randomSource,
          rootKey: this.rootKey,
          secondPublicationSequence,
          supportedFeatureBits: this.supportedFeatureBits,
        }),
      });
      outcome = "published";
      return published;
    } finally {
      this.stateValue = "closed";
      this.closeMutationDiagnostics({ outcome });
    }
  }

  async publish({
    base,
    beforeFirstAuthorityWrite,
    commitPayload,
    firstPublicationSequence,
    secondPublicationSequence,
  }: {
    base: OpenedSuperblockCopies;
    beforeFirstAuthorityWrite: () => void;
    commitPayload: FileSystemCommitPayload;
    firstPublicationSequence: PublicationSequence;
    secondPublicationSequence: PublicationSequence;
  }): Promise<PublishedPreparedMutationCommit> {
    this.requireActive({ operation: "publish the prepared Commit" });
    this.stateValue = "publishing";
    let outcome: "failed" | "published" = "failed";
    try {
      const published = await measureAuthenticatedPublicationOperation({
        diagnostics: this.diagnostics,
        run: async () => {
          try {
            const candidate = await this.appendMetadataRecordWithRollover({
              append: async ({ writer }) => await appendPreparedMutationCommitCandidate({
                commitPayload,
                writer,
              }),
            });
            return await publishPreparedMutationCommitCandidate({
              backend: this.backend,
              base,
              beforeFirstAuthorityWrite,
              candidate,
              diagnostics: this.diagnostics,
              fileSystemId: this.fileSystemId,
              firstPublicationSequence,
              randomSource: this.randomSource,
              rootKey: this.rootKey,
              secondPublicationSequence,
              supportedFeatureBits: this.supportedFeatureBits,
            });
          } finally {
            this.releaseWriterLease();
          }
        },
      });
      outcome = "published";
      return published;
    } finally {
      this.stateValue = "closed";
      this.closeMutationDiagnostics({ outcome });
    }
  }

  prepareWorkingAcceptanceWithoutCandidate(): void {
    switch (this.stateValue) {
    case "active": break;
    case "candidate_prepared": throw new Error(
      "cannot prepare working acceptance: mutation candidate is already prepared",
    );
    case "closed": throw new Error("cannot prepare working acceptance: mutation authority is closed");
    case "publishing": throw new Error("cannot prepare working acceptance during publication");
    default: return this.stateValue satisfies never;
    }
    if (this.operationInProgress) throw new Error("mutation authority operation already in progress");
    if (this.workingAcceptancePrepared) return;
    if (this.pendingAppendBatch?.hasRecords() === true) {
      throw new Error("cannot prepare working acceptance before provisional metadata Records are flushed");
    }

    // WHY: a staged successor may become background-publishable as soon as
    // runtime acceptance closes the mutation admission. Release the shared
    // Segment writer lease first, while that admission still fences flush and
    // maintenance, so Commit materialization cannot race the foreground lease.
    this.releaseWriterLease();
    this.workingAcceptancePrepared = true;
  }

  completeWorkingAcceptanceWithoutCandidate(): void {
    switch (this.stateValue) {
    case "active": break;
    case "candidate_prepared": throw new Error(
      "cannot complete working acceptance: mutation candidate is already prepared",
    );
    case "closed": throw new Error("cannot complete working acceptance: mutation authority is closed");
    case "publishing": throw new Error("cannot complete working acceptance during publication");
    default: return this.stateValue satisfies never;
    }
    if (this.operationInProgress) throw new Error("mutation authority operation already in progress");
    this.prepareWorkingAcceptanceWithoutCandidate();
    this.stateValue = "closed";
    this.closeMutationDiagnostics({ outcome: "accepted" });
  }

  async resolvePublication({ base, intendedLogicalState }: {
    base: OpenedSuperblockCopies;
    intendedLogicalState: SuperblockLogicalState;
  }): Promise<MutationSuperblockPublicationResolution> {
    switch (this.stateValue) {
    case "closed":
      if (this.detachedPublicationAuthority !== undefined) {
        return await this.detachedPublicationAuthority.resolvePublication({ base, intendedLogicalState });
      }
      break;
    case "active":
    case "candidate_prepared":
    case "publishing":
      throw new Error("cannot resolve publication before the mutation authority is closed");
    default: return this.stateValue satisfies never;
    }
    return await resolveMutationSuperblockPublication({
      backend: this.backend,
      base,
      diagnostics: this.diagnostics,
      fileSystemId: this.fileSystemId,
      intendedLogicalState,
      rootKey: this.rootKey,
      supportedFeatureBits: this.supportedFeatureBits,
    });
  }

  abandon(): void {
    switch (this.stateValue) {
    case "active":
    case "candidate_prepared":
      this.discardPendingAppendBatch();
      this.releaseWriterLease();
      this.stateValue = "closed";
      this.closeMutationDiagnostics({ outcome: "abandoned" });
      return;
    case "closed": {
      const detached = this.detachedPublicationAuthority;
      if (detached === undefined) return;
      const detachedState = detached.state();
      switch (detachedState) {
      case "resolution_pending":
        // Generic mutation cleanup must not destroy the only authority capable
        // of resolving a publication whose commit point may have been crossed.
        return;
      case "closed":
      case "publishing":
      case "ready":
        detached.abandon();
        return;
      default: return detachedState satisfies never;
      }
    }
    case "publishing": throw new Error("cannot abandon mutation authority during publication");
    default: return this.stateValue satisfies never;
    }
  }
}

export async function createAuthenticatedMetadataMutationAuthority({
  backend,
  decodedDirectoryPageCache,
  decodedInodeBranchPageCache,
  diagnostics,
  fileSystemId,
  mutationScopeDiagnostics,
  randomSource,
  relocationIndexRootPhysicalRef,
  rootKey,
  sharedMetadataRecordCache,
  supportedFeatureBits,
  writerOwner,
}: Parameters<typeof AuthenticatedMetadataMutationAuthority.create>[0]): Promise<AuthenticatedMetadataMutationAuthority> {
  return await AuthenticatedMetadataMutationAuthority.create({
    backend,
    decodedDirectoryPageCache,
    decodedInodeBranchPageCache,
    diagnostics,
    fileSystemId,
    mutationScopeDiagnostics,
    randomSource,
    relocationIndexRootPhysicalRef,
    rootKey,
    sharedMetadataRecordCache,
    supportedFeatureBits,
    writerOwner,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
