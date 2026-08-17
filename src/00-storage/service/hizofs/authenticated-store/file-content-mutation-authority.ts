import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  type DirectoryPage,
  type FileExtentPage,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import type {
  AuthenticatedSegmentWriterLease,
  AuthenticatedSegmentWriterOwner,
} from "./active-segment-writer-owner";
import type { AuthenticatedSegmentWriter } from "./record-appender";
import { createAuthenticatedSegmentWriter } from "./record-appender";
import { appendAuthenticatedFileData } from "./file-data-store";
import {
  AuthenticatedFileDataAppendBatch,
  AuthenticatedFileDataAppendBatchFlushRequiredError,
} from "./file-data-append-batch";
import {
  AuthenticatedMetadataMutationAuthority,
  type AuthenticatedMutationResourceUsage,
  type AuthenticatedPreparedMutationPublicationAuthority,
  createAuthenticatedMetadataMutationAuthority,
} from "./metadata-mutation-authority";

const FRAME_HEADER_BYTES = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordFrameHeader;
const FRAME_TAG_BYTES = HIZOFS_V1_FORMAT_CONSTANTS.crypto.tagBytes;
const DATA_AREA_BYTES = HIZOFS_V1_FORMAT_CONSTANTS.limits.dataSegmentDataBytes;
const DATA_FRAME_LIMIT = HIZOFS_V1_FORMAT_CONSTANTS.limits.dataFramesPerSegment;

function align8({ value }: { value: number }): number {
  return Math.ceil(value / 8) * 8;
}

function fileDataFrameLength({ plaintextLength }: { plaintextLength: number }): number {
  if (
    !Number.isInteger(plaintextLength)
    || plaintextLength < 1
    || plaintextLength > HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes
  ) {
    throw new RangeError("File Data plaintext length is outside its V1 mutation bound");
  }
  return align8({ value: FRAME_HEADER_BYTES + plaintextLength + FRAME_TAG_BYTES });
}

function segmentCanFit({ frameCount, nextFrameLength, recordAreaBytes }: {
  frameCount: number;
  nextFrameLength: number;
  recordAreaBytes: number;
}): boolean {
  return frameCount < DATA_FRAME_LIMIT && recordAreaBytes + nextFrameLength <= DATA_AREA_BYTES;
}

export type AuthenticatedFileContentMutationAuthorityState =
  | "active"
  | "candidate_prepared"
  | "closed"
  | "publishing";

type CreateAuthenticatedFileContentMutationAuthorityParameters =
  Omit<Parameters<typeof createAuthenticatedMetadataMutationAuthority>[0], "writerOwner">
  & Readonly<{
    dataWriterOwner?: AuthenticatedSegmentWriterOwner;
    metadataWriterOwner?: AuthenticatedSegmentWriterOwner;
  }>;

/**
 * Owns exactly the additional data-segment capability needed by file content
 * mutations while delegating metadata pages and Commit publication to the
 * existing metadata authority. Keeping this wrapper separate prevents File
 * Data authority from leaking into directory-only mutation paths.
 */
export class AuthenticatedFileContentMutationAuthority {
  private readonly metadata: AuthenticatedMetadataMutationAuthority;
  private readonly parameters: Parameters<typeof createAuthenticatedMetadataMutationAuthority>[0];
  private readonly dataWriterOwner: AuthenticatedSegmentWriterOwner | undefined;
  private appendedDataFrameBytes = 0;
  private dataFrameCount = 0;
  private dataRecordAreaBytes = 0;
  private dataWriter: AuthenticatedSegmentWriter | undefined;
  private pendingDataAppendBatch: AuthenticatedFileDataAppendBatch | undefined;
  private dataWriterLease: AuthenticatedSegmentWriterLease | undefined;
  private operationInProgress = false;
  private stateValue: AuthenticatedFileContentMutationAuthorityState = "active";
  private workingAcceptancePrepared = false;

  private constructor({
    dataWriterOwner,
    metadata,
    parameters,
  }: {
    dataWriterOwner: AuthenticatedSegmentWriterOwner | undefined;
    metadata: AuthenticatedMetadataMutationAuthority;
    parameters: Parameters<typeof createAuthenticatedMetadataMutationAuthority>[0];
  }) {
    this.dataWriterOwner = dataWriterOwner;
    this.metadata = metadata;
    this.parameters = parameters;
  }

  static async create({
    backend,
    decodedInodeBranchPageCache,
    diagnostics,
    fileSystemId,
    randomSource,
    relocationIndexRootPhysicalRef,
    rootKey,
    sharedMetadataRecordCache,
    supportedFeatureBits,
    dataWriterOwner,
    metadataWriterOwner,
  }: CreateAuthenticatedFileContentMutationAuthorityParameters): Promise<AuthenticatedFileContentMutationAuthority> {
    const parameters = {
      backend,
      decodedInodeBranchPageCache,
      diagnostics,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef,
      rootKey,
      sharedMetadataRecordCache,
      supportedFeatureBits,
      writerOwner: metadataWriterOwner,
    };
    const metadata = await createAuthenticatedMetadataMutationAuthority(parameters);
    return new AuthenticatedFileContentMutationAuthority({
      dataWriterOwner,
      metadata,
      parameters,
    });
  }

  state(): AuthenticatedFileContentMutationAuthorityState {
    return this.stateValue;
  }

  resourceUsage(): AuthenticatedMutationResourceUsage {
    const metadata = this.metadata.resourceUsage();
    const unpublishedPhysicalBytes = metadata.unpublishedPhysicalBytes + this.appendedDataFrameBytes;
    if (!Number.isSafeInteger(unpublishedPhysicalBytes)) {
      throw new Error("file content mutation resource usage exceeds the safe integer bound");
    }
    return Object.freeze({
      appendedMetadataFrameBytes: metadata.appendedMetadataFrameBytes,
      unpublishedPhysicalBytes,
    });
  }

  private requireActive({ operation }: { operation: string }): void {
    switch (this.stateValue) {
    case "active": break;
    case "candidate_prepared": throw new Error(`cannot ${operation}: file content mutation candidate is already prepared`);
    case "closed": throw new Error(`cannot ${operation}: file content mutation authority is closed`);
    case "publishing": throw new Error(`cannot ${operation}: file content mutation authority is publishing`);
    default: return this.stateValue satisfies never;
    }
    if (this.operationInProgress) throw new Error("file content mutation authority operation already in progress");
    if (this.workingAcceptancePrepared) {
      throw new Error(`cannot ${operation}: file content writer capabilities are released for working acceptance`);
    }
  }

  private async writerFor({ frameLength }: { frameLength: number }): Promise<AuthenticatedSegmentWriter> {
    if (this.dataWriterOwner !== undefined) {
      throw new Error("shared data Segment writer owner must not use the mutation-local writer path");
    }
    if (this.dataWriter !== undefined && segmentCanFit({
      frameCount: this.dataFrameCount,
      nextFrameLength: frameLength,
      recordAreaBytes: this.dataRecordAreaBytes,
    })) return this.dataWriter;
    this.dataWriter?.abandon();
    this.dataWriter = undefined;
    this.dataWriter = await createAuthenticatedSegmentWriter({
      backend: this.parameters.backend,
      diagnostics: this.parameters.diagnostics,
      fileSystemId: this.parameters.fileSystemId,
      randomSource: this.parameters.randomSource,
      rootKey: this.parameters.rootKey,
      segmentClass: "data",
    });
    this.dataFrameCount = 0;
    this.dataRecordAreaBytes = 0;
    return this.dataWriter;
  }

  private sharedDataWriterLease(): AuthenticatedSegmentWriterLease {
    if (this.dataWriterOwner === undefined) {
      throw new Error("shared data Segment writer lease requires an owner");
    }
    // Do not consume a Data Segment ID for inline-only mutations. The lease is
    // acquired only when the mutation actually appends its first File Data Record.
    this.dataWriterLease ??= this.dataWriterOwner.acquire();
    return this.dataWriterLease;
  }

  private discardPendingDataAppendBatch(): void {
    this.pendingDataAppendBatch?.discard();
    this.pendingDataAppendBatch = undefined;
  }

  private async flushPendingDataAppendBatch(): Promise<void> {
    const batch = this.pendingDataAppendBatch;
    if (batch === undefined) return;
    this.pendingDataAppendBatch = undefined;
    if (!batch.hasRecords()) {
      batch.discard();
      return;
    }
    await this.sharedDataWriterLease().append({
      append: async ({ writer }) => {
        if (!batch.isBoundTo({ writer })) {
          batch.discard();
          throw new Error("File Data append batch writer ownership changed before flush");
        }
        await batch.flush();
      },
    });
  }

  private async appendSharedFileDataWithBatch({ bytes }: { bytes: Uint8Array }): Promise<HomeRecordReference> {
    while (true) {
      const outcome = await this.sharedDataWriterLease().append({
        append: async ({ writer }) => {
          const existing = this.pendingDataAppendBatch;
          if (existing !== undefined && !existing.isBoundTo({ writer })) {
            if (existing.hasRecords()) {
              throw new Error("File Data append batch writer changed while Records were pending");
            }
            existing.discard();
            this.pendingDataAppendBatch = undefined;
          }
          const batch = this.pendingDataAppendBatch ?? new AuthenticatedFileDataAppendBatch({ writer });
          this.pendingDataAppendBatch = batch;
          try {
            return Object.freeze({
              reference: batch.stage({ bytes }),
              type: "result" as const,
            });
          } catch (cause: unknown) {
            if (cause instanceof AuthenticatedFileDataAppendBatchFlushRequiredError) {
              return Object.freeze({ type: "flush_required" as const });
            }
            throw cause;
          }
        },
      });
      switch (outcome.type) {
      case "result": return outcome.reference;
      case "flush_required":
        await this.flushPendingDataAppendBatch();
        break;
      default: return outcome satisfies never;
      }
    }
  }

  private releaseDataWriterCapability(): void {
    if (this.pendingDataAppendBatch?.hasRecords() === true) {
      throw new Error("cannot release data writer capability while provisional File Data Records are pending");
    }
    this.pendingDataAppendBatch?.discard();
    this.pendingDataAppendBatch = undefined;
    this.dataWriter?.abandon();
    this.dataWriter = undefined;
    const lease = this.dataWriterLease;
    this.dataWriterLease = undefined;
    lease?.release({ disposition: "reuse" });
  }

  async writeFileData({ bytes }: { bytes: Uint8Array }): Promise<HomeRecordReference> {
    this.requireActive({ operation: "write File Data" });
    this.operationInProgress = true;
    try {
      const frameLength = fileDataFrameLength({ plaintextLength: bytes.byteLength });
      const reference = this.dataWriterOwner === undefined
        ? await appendAuthenticatedFileData({
          bytes,
          writer: await this.writerFor({ frameLength }),
        })
        : await this.appendSharedFileDataWithBatch({ bytes });
      this.appendedDataFrameBytes += frameLength;
      if (!Number.isSafeInteger(this.appendedDataFrameBytes)) {
        throw new Error("File Data frame byte count exceeds the safe integer bound");
      }
      if (this.dataWriterOwner === undefined) {
        this.dataFrameCount += 1;
        this.dataRecordAreaBytes += frameLength;
      }
      return reference;
    } finally {
      this.operationInProgress = false;
    }
  }

  async readDirectoryPage({ isRoot, reference }: Parameters<AuthenticatedMetadataMutationAuthority["readDirectoryPage"]>[0]): Promise<DirectoryPage> {
    this.requireActive({ operation: "read a Directory page" });
    this.operationInProgress = true;
    try {
      return await this.metadata.readDirectoryPage({ isRoot, reference });
    } finally {
      this.operationInProgress = false;
    }
  }

  async readDirectoryPageForUpdate(
    { isRoot, reference }: Parameters<AuthenticatedMetadataMutationAuthority["readDirectoryPageForUpdate"]>[0],
  ): Promise<Awaited<ReturnType<AuthenticatedMetadataMutationAuthority["readDirectoryPageForUpdate"]>>> {
    this.requireActive({ operation: "read a Directory page for update" });
    this.operationInProgress = true;
    try {
      return await this.metadata.readDirectoryPageForUpdate({ isRoot, reference });
    } finally {
      this.operationInProgress = false;
    }
  }

  async writeDirectoryPage({ isRoot, page }: Parameters<AuthenticatedMetadataMutationAuthority["writeDirectoryPage"]>[0]): Promise<HomeRecordReference> {
    this.requireActive({ operation: "write a Directory page" });
    this.operationInProgress = true;
    try {
      return await this.metadata.writeDirectoryPage({ isRoot, page });
    } finally {
      this.operationInProgress = false;
    }
  }

  async readFileExtentPage({ isRoot, reference }: Parameters<AuthenticatedMetadataMutationAuthority["readFileExtentPage"]>[0]): Promise<FileExtentPage> {
    this.requireActive({ operation: "read a File Extent page" });
    this.operationInProgress = true;
    try {
      return await this.metadata.readFileExtentPage({ isRoot, reference });
    } finally {
      this.operationInProgress = false;
    }
  }

  async readFileExtentPageForUpdate(
    { isRoot, reference }: Parameters<AuthenticatedMetadataMutationAuthority["readFileExtentPageForUpdate"]>[0],
  ): Promise<Awaited<ReturnType<AuthenticatedMetadataMutationAuthority["readFileExtentPageForUpdate"]>>> {
    this.requireActive({ operation: "read a File Extent page for update" });
    this.operationInProgress = true;
    try {
      return await this.metadata.readFileExtentPageForUpdate({ isRoot, reference });
    } finally {
      this.operationInProgress = false;
    }
  }

  async writeFileExtentPage({ isRoot, page }: Parameters<AuthenticatedMetadataMutationAuthority["writeFileExtentPage"]>[0]): Promise<HomeRecordReference> {
    this.requireActive({ operation: "write a File Extent page" });
    this.operationInProgress = true;
    try {
      return await this.metadata.writeFileExtentPage({ isRoot, page });
    } finally {
      this.operationInProgress = false;
    }
  }

  async readInodeTablePage({
    isRoot,
    reference,
  }: Parameters<AuthenticatedMetadataMutationAuthority["readInodeTablePage"]>[0]): Promise<Awaited<ReturnType<AuthenticatedMetadataMutationAuthority["readInodeTablePage"]>>> {
    this.requireActive({ operation: "read an Inode Table page" });
    this.operationInProgress = true;
    try {
      return await this.metadata.readInodeTablePage({ isRoot, reference });
    } finally {
      this.operationInProgress = false;
    }
  }

  async readInodeTablePageForUpdate(
    { isRoot, reference }: Parameters<AuthenticatedMetadataMutationAuthority["readInodeTablePageForUpdate"]>[0],
  ): Promise<Awaited<ReturnType<AuthenticatedMetadataMutationAuthority["readInodeTablePageForUpdate"]>>> {
    this.requireActive({ operation: "read an Inode Table page for update" });
    this.operationInProgress = true;
    try {
      return await this.metadata.readInodeTablePageForUpdate({ isRoot, reference });
    } finally {
      this.operationInProgress = false;
    }
  }

  async writeInodeTablePage({
    isRoot,
    page,
  }: Parameters<AuthenticatedMetadataMutationAuthority["writeInodeTablePage"]>[0]): Promise<HomeRecordReference> {
    this.requireActive({ operation: "write an Inode Table page" });
    this.operationInProgress = true;
    try {
      return await this.metadata.writeInodeTablePage({ isRoot, page });
    } finally {
      this.operationInProgress = false;
    }
  }

  async flushPendingFileDataRecords(): Promise<void> {
    this.requireActive({ operation: "flush provisional File Data Records" });
    this.operationInProgress = true;
    try {
      if (this.dataWriterOwner !== undefined) await this.flushPendingDataAppendBatch();
    } catch (cause: unknown) {
      const cleanupFailures: unknown[] = [];
      this.discardPendingDataAppendBatch();
      try {
        this.releaseDataWriterCapability();
      } catch (cleanupCause: unknown) {
        cleanupFailures.push(cleanupCause);
      }
      try {
        this.metadata.abandon();
      } catch (cleanupCause: unknown) {
        cleanupFailures.push(cleanupCause);
      }
      this.stateValue = "closed";
      if (cleanupFailures.length !== 0) {
        throw new AggregateError(
          [cause, ...cleanupFailures],
          "File Data batch flush and mutation cleanup both failed",
        );
      }
      throw cause;
    } finally {
      this.operationInProgress = false;
    }
  }

  async flushPendingMetadataRecords(): Promise<void> {
    this.requireActive({ operation: "flush provisional metadata Records" });
    this.operationInProgress = true;
    try {
      await this.metadata.flushPendingMetadataRecords();
    } finally {
      this.operationInProgress = false;
    }
  }

  prepareWorkingAcceptanceWithoutCandidate(): void {
    switch (this.stateValue) {
    case "active": break;
    case "candidate_prepared": throw new Error(
      "cannot prepare file working acceptance: mutation candidate is already prepared",
    );
    case "closed": throw new Error("cannot prepare file working acceptance: authority is closed");
    case "publishing": throw new Error("cannot prepare file working acceptance during publication");
    default: return this.stateValue satisfies never;
    }
    if (this.operationInProgress) {
      throw new Error("file content mutation authority operation already in progress");
    }
    if (this.workingAcceptancePrepared) return;
    this.operationInProgress = true;
    try {
      this.metadata.prepareWorkingAcceptanceWithoutCandidate();
      // WHY: shared data and metadata writer leases must both be gone before
      // the staged successor is visible to background Commit materialization.
      // Metadata preparation can still reject an unflushed provisional batch,
      // so retain the data lease until that reversible check succeeds. The
      // still-open runtime mutation admission remains the authority fence while
      // both leases are released before the accepted successor becomes visible.
      this.releaseDataWriterCapability();
      this.workingAcceptancePrepared = true;
    } finally {
      this.operationInProgress = false;
    }
  }

  completeWorkingAcceptanceWithoutCandidate(): void {
    switch (this.stateValue) {
    case "active": break;
    case "candidate_prepared": throw new Error(
      "cannot complete file working acceptance: mutation candidate is already prepared",
    );
    case "closed": throw new Error("cannot complete file working acceptance: authority is closed");
    case "publishing": throw new Error("cannot complete file working acceptance during publication");
    default: return this.stateValue satisfies never;
    }
    if (this.operationInProgress) {
      throw new Error("file content mutation authority operation already in progress");
    }
    this.prepareWorkingAcceptanceWithoutCandidate();
    this.operationInProgress = true;
    try {
      this.metadata.completeWorkingAcceptanceWithoutCandidate();
      this.stateValue = "closed";
    } catch (cause: unknown) {
      this.stateValue = "closed";
      throw cause;
    } finally {
      this.operationInProgress = false;
    }
  }

  async appendCandidate({
    commitPayload,
  }: Parameters<AuthenticatedMetadataMutationAuthority["appendCandidate"]>[0]): Promise<Awaited<ReturnType<AuthenticatedMetadataMutationAuthority["appendCandidate"]>>> {
    this.requireActive({ operation: "append file content Commit candidate" });
    this.operationInProgress = true;
    try {
      if (this.dataWriterOwner !== undefined) await this.flushPendingDataAppendBatch();
      this.releaseDataWriterCapability();
      const candidate = await this.metadata.appendCandidate({ commitPayload });
      this.stateValue = "candidate_prepared";
      return candidate;
    } catch (cause: unknown) {
      this.stateValue = "closed";
      throw cause;
    } finally {
      this.operationInProgress = false;
    }
  }

  detachPreparedCandidatePublication({ candidate }: {
    candidate: Awaited<ReturnType<AuthenticatedMetadataMutationAuthority["appendCandidate"]>>;
  }): AuthenticatedPreparedMutationPublicationAuthority {
    switch (this.stateValue) {
    case "candidate_prepared": break;
    case "active": throw new Error("cannot detach file content publication authority before a candidate is prepared");
    case "closed": throw new Error("cannot detach file content publication authority: authority is closed");
    case "publishing": throw new Error("cannot detach file content publication authority during publication");
    default: return this.stateValue satisfies never;
    }
    if (this.operationInProgress) throw new Error("file content mutation authority operation already in progress");
    const detached = this.metadata.detachPreparedCandidatePublication({ candidate });
    this.stateValue = "closed";
    return detached;
  }

  async publishCandidate({
    base,
    beforeFirstAuthorityWrite,
    candidate,
    firstPublicationSequence,
    secondPublicationSequence,
  }: Parameters<AuthenticatedMetadataMutationAuthority["publishCandidate"]>[0]): Promise<Awaited<ReturnType<AuthenticatedMetadataMutationAuthority["publishCandidate"]>>> {
    switch (this.stateValue) {
    case "candidate_prepared": break;
    case "active": throw new Error("cannot publish file content candidate before it is prepared");
    case "closed": throw new Error("cannot publish file content candidate: authority is closed");
    case "publishing": throw new Error("cannot publish file content candidate: authority is publishing");
    default: return this.stateValue satisfies never;
    }
    if (this.operationInProgress) throw new Error("file content mutation authority operation already in progress");
    this.operationInProgress = true;
    this.stateValue = "publishing";
    try {
      return await this.metadata.publishCandidate({
        base,
        beforeFirstAuthorityWrite,
        candidate,
        firstPublicationSequence,
        secondPublicationSequence,
      });
    } finally {
      this.operationInProgress = false;
      this.stateValue = "closed";
    }
  }

  async publish({
    base,
    beforeFirstAuthorityWrite,
    commitPayload,
    firstPublicationSequence,
    secondPublicationSequence,
  }: Parameters<AuthenticatedMetadataMutationAuthority["publish"]>[0]): Promise<Awaited<ReturnType<AuthenticatedMetadataMutationAuthority["publish"]>>> {
    this.requireActive({ operation: "publish file content" });
    this.operationInProgress = true;
    this.stateValue = "publishing";
    try {
      if (this.dataWriterOwner !== undefined) await this.flushPendingDataAppendBatch();
      this.releaseDataWriterCapability();
      return await this.metadata.publish({
        base,
        beforeFirstAuthorityWrite,
        commitPayload,
        firstPublicationSequence,
        secondPublicationSequence,
      });
    } finally {
      this.operationInProgress = false;
      this.stateValue = "closed";
    }
  }

  async resolvePublication({
    base,
    intendedLogicalState,
  }: Parameters<AuthenticatedMetadataMutationAuthority["resolvePublication"]>[0]): Promise<Awaited<ReturnType<AuthenticatedMetadataMutationAuthority["resolvePublication"]>>> {
    switch (this.stateValue) {
    case "closed": return await this.metadata.resolvePublication({ base, intendedLogicalState });
    case "active":
    case "candidate_prepared":
    case "publishing": throw new Error("cannot resolve publication before the file content mutation authority is closed");
    default: return this.stateValue satisfies never;
    }
  }

  abandon(): void {
    switch (this.stateValue) {
    case "active":
    case "candidate_prepared":
      if (this.operationInProgress) {
        throw new Error("cannot abandon file content mutation authority while an operation is in progress");
      }
      this.discardPendingDataAppendBatch();
      this.releaseDataWriterCapability();
      this.metadata.abandon();
      this.stateValue = "closed";
      return;
    case "closed": return;
    case "publishing": throw new Error("cannot abandon file content mutation authority during publication");
    default: return this.stateValue satisfies never;
    }
  }
}

export async function createAuthenticatedFileContentMutationAuthority({
  backend,
  dataWriterOwner,
  decodedInodeBranchPageCache,
  diagnostics,
  fileSystemId,
  randomSource,
  relocationIndexRootPhysicalRef,
  rootKey,
  sharedMetadataRecordCache,
  supportedFeatureBits,
  metadataWriterOwner,
}: CreateAuthenticatedFileContentMutationAuthorityParameters): Promise<AuthenticatedFileContentMutationAuthority> {
  return await AuthenticatedFileContentMutationAuthority.create({
    backend,
    dataWriterOwner,
    decodedInodeBranchPageCache,
    diagnostics,
    fileSystemId,
    randomSource,
    relocationIndexRootPhysicalRef,
    rootKey,
    sharedMetadataRecordCache,
    supportedFeatureBits,
    metadataWriterOwner,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  fileDataFrameLength,
  segmentCanFit,
};
