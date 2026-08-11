import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  createPhysicalRecordReference,
  createRecordFrameHeader,
  createUInt64,
  encodeRecordFrameHeader,
  encodeSegmentFooterIndexEntry,
  encodeSegmentHeader,
  segmentClassForRecordKind,
  segmentFooterIndexEntryFromFrame,
  segmentHeaderAuthenticatedPrefix,
  segmentIdToShard,
  type FileSystemId,
  type HomeRecordReference,
  type PhysicalRecordReference,
  type RecordFrameHeaderV1,
  type SegmentClass,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import {
  createRecordEncryptionBatchCapability,
  encryptSegmentHeader,
  generateRecordNonce,
  generateSegmentId,
  plaintextRecordBytes,
  plaintextSegmentHeaderBytes,
  type FileSystemRootKey,
  type RandomByteSource,
  type RecordNonce,
} from "@/00-storage/service/hizofs/01-crypto";
import type {
  HizoFSWritableBackend,
  HizoFSWritableFile,
} from "@/00-storage/service/hizofs/physical-store/backend";
import {
  canonicalContainerDirectory,
  type CanonicalContainerPath,
} from "@/00-storage/service/hizofs/physical-store/paths";
import { authenticatedStoreError } from "./errors";
import { ensureAuthenticatedContainerDirectoryHierarchy } from "./ensure-container-directory";
import {
  closeAuthenticatedFile,
  runAndCloseAuthenticatedFile,
} from "./file-operation";
import {
  allocateAuthenticatedHizoFSPhysicalBytes,
  authenticatedHizoFSPhysicalBytes,
  type AuthenticatedHizoFSPhysicalBytes,
} from "./physical-bytes";
import {
  getOpenFileSizeWithAuthenticatedReason,
  measureAuthenticatedCodecOperation,
  measureAuthenticatedCryptoOperation,
  readExactWithAuthenticatedReason,
  type AuthenticatedStoreDiagnosticsPort,
} from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";
import { authenticatedSegmentPath, segmentIdIsUsedInOtherClass } from "./segment-location";
import { sealAuthenticatedSegment } from "./segment-footer-store";
import { readAuthenticatedSegmentDescriptor } from "./segment-prefix-reader";
import { tryCreateAuthenticatedWholeFile } from "./whole-file";

const activeSegmentWriterCapabilityBrand: unique symbol = Symbol("active-segment-writer-capability");
declare const encodedRecordBrand: unique symbol;

export type ActiveSegmentWriterCapability = Readonly<{
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  expectedFileSize: bigint;
  fileSystemId: FileSystemId;
  footerIndexBytes: Uint8Array;
  frameCount: number;
  physicalSegmentId: SegmentId;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
  segmentClass: SegmentClass;
  readonly [activeSegmentWriterCapabilityBrand]: true;
}>;

export type EncodedHizoFSRecord = Readonly<{
  plaintext: Uint8Array & { readonly [encodedRecordBrand]: true };
  recordKind: number;
}>;

export type AppendedRecord =
  | Readonly<{
    homeReference: HomeRecordReference;
    physicalReference: PhysicalRecordReference;
    type: "home";
  }>
  | Readonly<{
    physicalReference: PhysicalRecordReference;
    type: "physical_only";
  }>;

export type AuthenticatedSegmentAppendTarget = Readonly<{
  segmentClass: SegmentClass;
  append({ records }: { records: readonly EncodedHizoFSRecord[] }): Promise<readonly AppendedRecord[]>;
  encodeRecordPayload({ encode }: { encode: () => Uint8Array }): Uint8Array;
}>;

export type AuthenticatedSegmentAppendPreviewPlanner = Readonly<{
  previewAppend({ acceptPreview, records }: {
    acceptPreview: ({ results }: { results: readonly AppendedRecord[] }) => void;
    records: readonly EncodedHizoFSRecord[];
  }): readonly AppendedRecord[];
}>;

export type SegmentWriterState = "abandoned" | "active" | "sealed";

type SegmentWriterWritableFileLifetime = "append" | "writer";

export class AuthenticatedSegmentCapacityError extends RangeError {
  readonly capacity: "frame_count" | "record_area";

  constructor({ capacity, message }: {
    capacity: "frame_count" | "record_area";
    message: string;
  }) {
    super(message);
    this.name = "AuthenticatedSegmentCapacityError";
    this.capacity = capacity;
  }
}

export function encodedHizoFSRecord({ plaintext, recordKind }: {
  plaintext: Uint8Array;
  recordKind: number;
}): EncodedHizoFSRecord {
  segmentClassForRecordKind({ recordKind });
  if (plaintext.byteLength > plaintextMaximum({ recordKind })) {
    throw new RangeError("record plaintext exceeds its V1 bound");
  }
  return {
    plaintext: Uint8Array.from(plaintext) as EncodedHizoFSRecord["plaintext"],
    recordKind,
  };
}

function bytesEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function recordAreaMaximum({ segmentClass }: { segmentClass: SegmentClass }): number {
  switch (segmentClass) {
  case "data": return HIZOFS_V1_FORMAT_CONSTANTS.limits.dataSegmentDataBytes;
  case "metadata": return HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataSegmentDataBytes;
  default: return segmentClass satisfies never;
  }
}

function frameMaximumCount({ segmentClass }: { segmentClass: SegmentClass }): number {
  switch (segmentClass) {
  case "data": return HIZOFS_V1_FORMAT_CONSTANTS.limits.dataFramesPerSegment;
  case "metadata": return HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataFramesPerSegment;
  default: return segmentClass satisfies never;
  }
}

function plaintextMaximum({ recordKind }: { recordKind: number }): number {
  return recordKind === HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data
    ? HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes
    : HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataPlaintextBytes;
}

function planRecordAppend({
  frameCount,
  nextOffset,
  records,
  segmentClass,
  segmentId,
}: {
  frameCount: number;
  nextOffset: bigint;
  records: readonly EncodedHizoFSRecord[];
  segmentClass: SegmentClass;
  segmentId: SegmentId;
}): Readonly<{ nextOffset: bigint; results: readonly AppendedRecord[] }> {
  if (records.length === 0) throw new RangeError("record append batch must not be empty");
  if (frameCount + records.length > frameMaximumCount({ segmentClass })) {
    throw new AuthenticatedSegmentCapacityError({
      capacity: "frame_count",
      message: "record append batch exceeds the segment frame-count bound",
    });
  }

  let plannedOffset = nextOffset;
  const results: AppendedRecord[] = [];
  for (const record of records) {
    if (segmentClassForRecordKind({ recordKind: record.recordKind }) !== segmentClass) {
      throw new TypeError("record kind does not belong to the active segment class");
    }
    if (record.plaintext.byteLength > plaintextMaximum({ recordKind: record.recordKind })) {
      throw new RangeError("record plaintext exceeds its V1 bound");
    }
    const physicalOnly = record.recordKind === HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page;
    const header = createRecordFrameHeader({
      flags: physicalOnly ? HIZOFS_V1_FORMAT_CONSTANTS.flags.recordPhysicalOnly : 0,
      homeOffset: createUInt64({ value: plannedOffset }),
      homeSegmentId: segmentId,
      nonce: new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.crypto.nonceBytes),
      plaintextLength: record.plaintext.byteLength,
      recordKind: record.recordKind,
    });
    const end = plannedOffset + BigInt(header.frameLength);
    const recordAreaLength = end - BigInt(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader);
    if (recordAreaLength > BigInt(recordAreaMaximum({ segmentClass }))) {
      throw new AuthenticatedSegmentCapacityError({
        capacity: "record_area",
        message: "record append batch exceeds the segment record-area bound",
      });
    }
    const physicalReference = createPhysicalRecordReference({ fields: {
      byteOffset: header.homeOffset,
      frameLength: header.frameLength,
      recordKind: header.recordKind,
      segmentId,
    } });
    results.push(physicalOnly
      ? { physicalReference, type: "physical_only" }
      : {
        homeReference: createHomeRecordReference({ fields: {
          byteOffset: header.homeOffset,
          frameLength: header.frameLength,
          recordKind: header.recordKind,
          segmentId,
        } }),
        physicalReference,
        type: "home",
      });
    plannedOffset = end;
  }
  return Object.freeze({ nextOffset: plannedOffset, results: Object.freeze(results) });
}

async function ensureSegmentDirectories({ backend, segmentClass, segmentId }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  segmentClass: SegmentClass;
  segmentId: SegmentId;
}): Promise<void> {
  const segmentDirectory = canonicalContainerDirectory({
    value: HIZOFS_V1_FORMAT_CONSTANTS.container.segmentDirectoryName,
  });
  const classDirectory = canonicalContainerDirectory({
    value: `${segmentDirectory}/${HIZOFS_V1_FORMAT_CONSTANTS.container.segmentClassDirectories[segmentClass]}`,
  });
  const shardDirectory = canonicalContainerDirectory({
    value: `${classDirectory}/${segmentIdToShard({ id: segmentId })}`,
  });
  await ensureAuthenticatedContainerDirectoryHierarchy({ backend, path: shardDirectory });
}

async function createAuthenticatedSegmentHeader({ diagnostics, fileSystemId, rootKey, segmentClass, segmentId }: {
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  rootKey: FileSystemRootKey;
  segmentClass: SegmentClass;
  segmentId: SegmentId;
}): Promise<Uint8Array> {
  const skeleton = encodeSegmentHeader({ header: {
    authenticationTag: new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.crypto.tagBytes),
    physicalSegmentId: segmentId,
    segmentClass,
  } });
  const authenticationTag = await measureAuthenticatedCryptoOperation({
    diagnostics,
    operation: "encrypt",
    run: async () => await encryptSegmentHeader({
      fileSystemId,
      physicalSegmentId: segmentId,
      plaintext: plaintextSegmentHeaderBytes({ bytes: new Uint8Array() }),
      rootKey,
      segmentClass: HIZOFS_V1_FORMAT_CONSTANTS.container.segmentClasses[segmentClass],
      segmentHeaderPrefix: segmentHeaderAuthenticatedPrefix({ bytes: skeleton }),
    }),
  });
  return encodeSegmentHeader({ header: { authenticationTag, physicalSegmentId: segmentId, segmentClass } });
}

function nonceKey({ nonce }: { nonce: Uint8Array }): string {
  // Record nonces are fixed-width bytes. One UTF-16 code unit per byte is an
  // injective, non-persisted Set key and avoids a hex allocation on every lookup.
  let key = "";
  for (const byte of nonce) key += String.fromCharCode(byte);
  return key;
}

function freshRecordNonce({ batchNonceKeys, randomSource, usedNonceKeys }: {
  batchNonceKeys: ReadonlySet<string>;
  randomSource?: RandomByteSource;
  usedNonceKeys: ReadonlySet<string>;
}): RecordNonce {
  for (let attempt = 0; attempt < HIZOFS_V1_FORMAT_CONSTANTS.limits.randomIdentityGenerationAttempts; attempt += 1) {
    const nonce = generateRecordNonce({ randomSource });
    const key = nonceKey({ nonce });
    if (!usedNonceKeys.has(key) && !batchNonceKeys.has(key)) return nonce;
  }
  throw new Error("Record nonce generation exhausted the collision retry bound");
}


function requireActiveWriter({ operation, state }: {
  operation: "append" | "seal";
  state: SegmentWriterState;
}): void {
  switch (state) {
  case "active":
    return;
  case "abandoned":
  case "sealed":
    throw new Error(`cannot ${operation} a ${state} segment writer`);
  default:
    return state satisfies never;
  }
}

function requireWriterStillActive({ message, state }: {
  message: string;
  state: SegmentWriterState;
}): void {
  switch (state) {
  case "active":
    return;
  case "abandoned":
  case "sealed":
    throw new Error(message);
  default:
    return state satisfies never;
  }
}

export class AuthenticatedSegmentWriter {
  private readonly backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  private readonly fileSystemId: FileSystemId;
  private readonly diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  private readonly path: CanonicalContainerPath;
  private readonly randomSource: RandomByteSource | undefined;
  private readonly rootKey: FileSystemRootKey;
  private readonly segmentClassValue: SegmentClass;
  private readonly segmentId: SegmentId;
  private readonly writableFileLifetime: SegmentWriterWritableFileLifetime;
  private durableFooterIndexBytes = new Uint8Array();
  private durableFooterIndexLength = 0;
  private readonly usedNonceKeys = new Set<string>();
  private explicitAbandonRequested = false;
  private frameCount = 0;
  private nextOffset = BigInt(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader);
  private operationInProgress = false;
  private persistedFrameBytesValue = 0;
  private retainedWritableFile: HizoFSWritableFile | undefined;
  private retainedWritableFileCloseFailure: unknown | undefined;
  private retainedWritableFileCloseOperation: Promise<void> | undefined;
  private stateValue: SegmentWriterState = "active";

  private constructor({
    backend,
    diagnostics,
    fileSystemId,
    path,
    randomSource,
    rootKey,
    segmentClass,
    segmentId,
    writableFileLifetime,
  }: {
    backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
    diagnostics?: AuthenticatedStoreDiagnosticsPort;
    fileSystemId: FileSystemId;
    path: CanonicalContainerPath;
    randomSource?: RandomByteSource;
    rootKey: FileSystemRootKey;
    segmentClass: SegmentClass;
    segmentId: SegmentId;
    writableFileLifetime: SegmentWriterWritableFileLifetime;
  }) {
    this.backend = backend;
    this.diagnostics = diagnostics;
    this.fileSystemId = fileSystemId;
    this.path = path;
    this.randomSource = randomSource;
    this.rootKey = rootKey;
    this.segmentClassValue = segmentClass;
    this.segmentId = segmentId;
    this.writableFileLifetime = writableFileLifetime;
  }

  private beginRetainedWritableFileClose(): void {
    const file = this.retainedWritableFile;
    if (file === undefined) return;
    if (this.retainedWritableFileCloseOperation !== undefined) {
      throw new Error("active Segment retained writable-file close is already in progress");
    }
    this.retainedWritableFile = undefined;
    this.retainedWritableFileCloseFailure = undefined;
    const closeOperation = closeAuthenticatedFile({
      backend: this.backend,
      file,
      operationLabel: "active Segment writer retained handle",
    }).then(
      () => undefined,
      (cause: unknown) => {
        this.retainedWritableFileCloseFailure = cause;
      },
    );
    this.retainedWritableFileCloseOperation = closeOperation;
  }

  private async awaitRetainedWritableFileClose(): Promise<void> {
    const closeOperation = this.retainedWritableFileCloseOperation;
    if (closeOperation !== undefined) {
      await closeOperation;
      if (this.retainedWritableFileCloseOperation === closeOperation) {
        this.retainedWritableFileCloseOperation = undefined;
      }
    }
    const failure = this.retainedWritableFileCloseFailure;
    if (failure !== undefined) {
      throw failure;
    }
  }

  private async closeRetainedWritableFile(): Promise<void> {
    this.beginRetainedWritableFileClose();
    await this.awaitRetainedWritableFileClose();
  }

  private async writableFileForAppend(): Promise<Readonly<{
    closeAfterAppend: boolean;
    file: HizoFSWritableFile;
  }>> {
    await this.awaitRetainedWritableFileClose();
    switch (this.writableFileLifetime) {
    case "append":
      return Object.freeze({
        closeAfterAppend: true,
        file: await this.backend.openFileForUpdate({ path: this.path }),
      });
    case "writer": {
      const current = this.retainedWritableFile;
      if (current !== undefined) {
        return Object.freeze({ closeAfterAppend: false, file: current });
      }
      const opened = await this.backend.openFileForUpdate({ path: this.path });
      this.retainedWritableFile = opened;
      return Object.freeze({ closeAfterAppend: false, file: opened });
    }
    default:
      return this.writableFileLifetime satisfies never;
    }
  }

  private releaseDurableFooterIndex(): void {
    this.durableFooterIndexBytes = new Uint8Array();
    this.durableFooterIndexLength = 0;
  }

  private appendDurableFooterIndex({ frames }: {
    frames: readonly Readonly<{ header: RecordFrameHeaderV1; physicalOffset: bigint }>[];
  }): void {
    const entrySize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentFooterIndexEntry;
    const maximumBytes = frameMaximumCount({ segmentClass: this.segmentClassValue }) * entrySize;
    const requiredBytes = this.durableFooterIndexLength + frames.length * entrySize;
    if (requiredBytes > maximumBytes) {
      throw new Error("active Segment durable Footer index exceeds its format bound");
    }
    if (this.durableFooterIndexBytes.byteLength < requiredBytes) {
      const doubled = this.durableFooterIndexBytes.byteLength === 0
        ? 4096
        : this.durableFooterIndexBytes.byteLength * 2;
      const capacity = Math.min(maximumBytes, Math.max(requiredBytes, doubled));
      const grown = new Uint8Array(capacity);
      grown.set(this.durableFooterIndexBytes.subarray(0, this.durableFooterIndexLength));
      this.durableFooterIndexBytes = grown;
    }
    let offset = this.durableFooterIndexLength;
    for (const frame of frames) {
      const bytes = encodeSegmentFooterIndexEntry({
        entry: segmentFooterIndexEntryFromFrame({ frame }),
      });
      this.durableFooterIndexBytes.set(bytes, offset);
      offset += entrySize;
    }
    this.durableFooterIndexLength = requiredBytes;
  }

  public hasRecords(): boolean {
    return this.frameCount !== 0;
  }

  public persistedFrameBytes(): number {
    return this.persistedFrameBytesValue;
  }

  public static async create({
    backend,
    diagnostics,
    fileSystemId,
    randomSource,
    rootKey,
    segmentClass,
    writableFileLifetime,
  }: {
    backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
    diagnostics?: AuthenticatedStoreDiagnosticsPort;
    fileSystemId: FileSystemId;
    randomSource?: RandomByteSource;
    rootKey: FileSystemRootKey;
    segmentClass: SegmentClass;
    writableFileLifetime: SegmentWriterWritableFileLifetime;
  }): Promise<AuthenticatedSegmentWriter> {
    for (let attempt = 0; attempt < HIZOFS_V1_FORMAT_CONSTANTS.limits.randomIdentityGenerationAttempts; attempt += 1) {
      const segmentId = await generateSegmentId({ isUsed: async () => false, randomSource });
      if (await segmentIdIsUsedInOtherClass({ backend, segmentClass, segmentId })) continue;
      await ensureSegmentDirectories({ backend, segmentClass, segmentId });
      const path = authenticatedSegmentPath({ segmentClass, segmentId });
      const header = await createAuthenticatedSegmentHeader({ diagnostics, fileSystemId, rootKey, segmentClass, segmentId });
      if (!await tryCreateAuthenticatedWholeFile({
        backend,
        bytes: authenticatedHizoFSPhysicalBytes({ bytes: header }),
        path,
      })) continue;
      await readAuthenticatedSegmentDescriptor({ backend, diagnostics, fileSystemId, physicalSegmentId: segmentId, rootKey, segmentClass });
      diagnostics?.recordSegmentWriterEvent?.({ observation: { event: "descriptor_validated", segmentClass } });
      diagnostics?.recordSegmentWriterEvent?.({ observation: { event: "created", segmentClass } });
      return new AuthenticatedSegmentWriter({
        backend,
        diagnostics,
        fileSystemId,
        path,
        randomSource,
        rootKey,
        segmentClass,
        segmentId,
        writableFileLifetime,
      });
    }
    throw new Error("Segment ID creation exhausted the collision retry bound");
  }

  public get physicalSegmentId(): SegmentId {
    return this.segmentId;
  }
  public get segmentClass(): SegmentClass {
    return this.segmentClassValue;
  }
  public get state(): SegmentWriterState {
    return this.stateValue;
  }

  /**
   * Measures only the canonical payload that is about to become a persisted
   * Record. Planning encodes used for sizing or ordering are intentionally not
   * counted as storage codec work.
   */
  public encodeRecordPayload({ encode }: { encode: () => Uint8Array }): Uint8Array {
    return measureAuthenticatedCodecOperation({
      diagnostics: this.diagnostics,
      format: "record",
      operation: "encode",
      run: encode,
    });
  }

  /**
   * Predicts the exact immutable references a batch would receive without
   * mutating writer state or generating cryptographic material. This exists so
   * a mutation-local batch can encode parent records from child references and
   * then persist the dependency-ordered batch with one canonical append. The
   * caller must hold the writer lease until the matching append completes.
   */
  public previewAppend({ records }: { records: readonly EncodedHizoFSRecord[] }): readonly AppendedRecord[] {
    requireActiveWriter({ operation: "append", state: this.stateValue });
    if (this.operationInProgress) throw new Error("segment writer operation already in progress");
    return planRecordAppend({
      frameCount: this.frameCount,
      nextOffset: this.nextOffset,
      records,
      segmentClass: this.segmentClassValue,
      segmentId: this.segmentId,
    }).results;
  }

  /**
   * Creates a mutation-local incremental preview over the current trusted tail.
   *
   * WHY: metadata B+tree construction discovers child Records incrementally.
   * Replanning the complete pending prefix after every discovery is quadratic
   * CPU work and allocation. The planner advances only after a successful
   * preview, while verifying that the writer itself has not advanced. Flush
   * still performs the canonical full append and compares every predicted
   * reference, so this capability cannot weaken publication or durability.
   */
  public createAppendPreviewPlanner(): AuthenticatedSegmentAppendPreviewPlanner {
    requireActiveWriter({ operation: "append", state: this.stateValue });
    if (this.operationInProgress) throw new Error("segment writer operation already in progress");
    const writerFrameCount = this.frameCount;
    const writerNextOffset = this.nextOffset;
    let plannedFrameCount = writerFrameCount;
    let plannedNextOffset = writerNextOffset;
    return Object.freeze({
      previewAppend: ({ acceptPreview, records }) => {
        requireActiveWriter({ operation: "append", state: this.stateValue });
        if (this.operationInProgress) throw new Error("segment writer operation already in progress");
        if (this.frameCount !== writerFrameCount || this.nextOffset !== writerNextOffset) {
          throw new Error("segment append preview planner is stale");
        }
        const planned = planRecordAppend({
          frameCount: plannedFrameCount,
          nextOffset: plannedNextOffset,
          records,
          segmentClass: this.segmentClassValue,
          segmentId: this.segmentId,
        });
        // WHY: callers may need to reject an otherwise valid preview because of
        // a stricter mutation-local bound. Advance the incremental tail only
        // after that acceptance so a rejected stage is observationally pure.
        acceptPreview({ results: planned.results });
        plannedFrameCount += records.length;
        plannedNextOffset = planned.nextOffset;
        return planned.results;
      },
    });
  }

  public abandon(): void {
    switch (this.stateValue) {
    case "sealed":
      return;
    case "abandoned":
    case "active":
      this.explicitAbandonRequested = true;
      this.stateValue = "abandoned";
      if (!this.operationInProgress) {
        this.beginRetainedWritableFileClose();
        this.releaseDurableFooterIndex();
      }
      return;
    default:
      return this.stateValue satisfies never;
    }
  }

  /**
   * Drains a retained native update handle after synchronous abandonment.
   * Owner code must await this before creating another writer or closing the
   * owning epoch so close failures cannot disappear behind a fire-and-forget
   * cleanup path.
   */
  public async settleAbandonment(): Promise<void> {
    await this.closeRetainedWritableFile();
  }

  public async append({ records }: { records: readonly EncodedHizoFSRecord[] }): Promise<readonly AppendedRecord[]> {
    return await this.appendCallerOwnedRecords({ records });
  }

  /**
   * Appends one already-encoded Record payload without requiring the caller to
   * manufacture an EncodedHizoFSRecord snapshot first. The payload remains
   * caller-owned: appendCallerOwnedRecords makes the single asynchronous
   * ownership snapshot synchronously before its first await.
   *
   * WHY: File Data encoding already materializes a fresh canonical payload.
   * Wrapping that payload with encodedHizoFSRecord and then snapshotting it
   * again at append moved the same large bytes twice before crypto. Keeping the
   * ownership snapshot here preserves TOCTOU isolation while removing only the
   * redundant pre-snapshot copy.
   */
  public async appendCallerOwnedRecord({ plaintext, recordKind }: {
    plaintext: Uint8Array;
    recordKind: number;
  }): Promise<AppendedRecord> {
    const [result] = await this.appendCallerOwnedRecords({ records: [{ plaintext, recordKind }] });
    if (result === undefined) throw new Error("single Record append result is missing");
    return result;
  }

  private async appendCallerOwnedRecords({ records }: {
    records: readonly Readonly<{ plaintext: Uint8Array; recordKind: number }>[];
  }): Promise<readonly AppendedRecord[]> {
    requireActiveWriter({ operation: "append", state: this.stateValue });
    if (this.operationInProgress) throw new Error("segment writer operation already in progress");
    this.operationInProgress = true;
    this.diagnostics?.recordSegmentWriterEvent?.({ observation: {
      event: "append_started",
      segmentClass: this.segmentClassValue,
    } });
    try {
      if (records.length === 0) throw new RangeError("record append batch must not be empty");
      if (this.frameCount + records.length > frameMaximumCount({ segmentClass: this.segmentClassValue })) {
        throw new AuthenticatedSegmentCapacityError({
          capacity: "frame_count",
          message: "record append batch exceeds the segment frame-count bound",
        });
      }
      const recordSnapshots = records.map(record => {
        // Validate caller-controlled size and kind before copying. Rejected input
        // must not force an allocation proportional to bytes that V1 cannot store.
        if (segmentClassForRecordKind({ recordKind: record.recordKind }) !== this.segmentClassValue) {
          throw new TypeError("record kind does not belong to the active segment class");
        }
        if (record.plaintext.byteLength > plaintextMaximum({ recordKind: record.recordKind })) {
          throw new RangeError("record plaintext exceeds its V1 bound");
        }
        return {
          // This is the sole caller-mutation isolation copy for append. Keep the
          // snapshot branded so crypto does not copy the same owned bytes again.
          plaintext: plaintextRecordBytes({ bytes: record.plaintext }),
          recordKind: record.recordKind,
        };
      });

      const batchNonceKeys = new Set<string>();
      const frames: Array<{
        ciphertext: Uint8Array;
        header: RecordFrameHeaderV1;
        headerBytes: Uint8Array;
        physicalOffset: bigint;
        result: AppendedRecord;
      }> = [];
      let encryptionCapability: Awaited<ReturnType<typeof createRecordEncryptionBatchCapability>> | undefined;
      let nextOffset = this.nextOffset;
      try {
        for (const record of recordSnapshots) {
          const nonce = freshRecordNonce({
            batchNonceKeys,
            randomSource: this.randomSource,
            usedNonceKeys: this.usedNonceKeys,
          });
          batchNonceKeys.add(nonceKey({ nonce }));
          const physicalOnly = record.recordKind === HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page;
          const header = createRecordFrameHeader({
            flags: physicalOnly ? HIZOFS_V1_FORMAT_CONSTANTS.flags.recordPhysicalOnly : 0,
            homeOffset: createUInt64({ value: nextOffset }),
            homeSegmentId: this.segmentId,
            nonce,
            plaintextLength: record.plaintext.byteLength,
            recordKind: record.recordKind,
          });
          const end = nextOffset + BigInt(header.frameLength);
          const recordAreaLength = end - BigInt(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader);
          if (recordAreaLength > BigInt(recordAreaMaximum({ segmentClass: this.segmentClassValue }))) {
            throw new AuthenticatedSegmentCapacityError({
              capacity: "record_area",
              message: "record append batch exceeds the segment record-area bound",
            });
          }
          const headerBytes = encodeRecordFrameHeader({ header });
          const ciphertext = await measureAuthenticatedCryptoOperation({
            diagnostics: this.diagnostics,
            operation: "encrypt",
            run: async () => {
              // Keep key derivation inside the existing encrypt measurement so a
              // lower phase duration reflects real work removed, not timer drift.
              const capability = encryptionCapability ??= await createRecordEncryptionBatchCapability({
                fileSystemId: this.fileSystemId,
                homeSegmentId: this.segmentId,
                rootKey: this.rootKey,
              });
              return await capability.encrypt({
                completeFrameHeader: headerBytes,
                nonce,
                plaintext: record.plaintext,
              });
            },
          });
          const physicalReference = createPhysicalRecordReference({ fields: {
            byteOffset: header.homeOffset,
            frameLength: header.frameLength,
            recordKind: header.recordKind,
            segmentId: this.segmentId,
          } });
          const result: AppendedRecord = physicalOnly
            ? { physicalReference, type: "physical_only" }
            : {
              homeReference: createHomeRecordReference({ fields: {
                byteOffset: header.homeOffset,
                frameLength: header.frameLength,
                recordKind: header.recordKind,
                segmentId: this.segmentId,
              } }),
              physicalReference,
              type: "home",
            };
          frames.push({ ciphertext, header, headerBytes, physicalOffset: nextOffset, result });
          nextOffset = end;
        }
      } finally {
        // Web Crypto keys cannot be explicitly zeroized. Drop the only batch
        // reference before backend I/O so lifetime is no longer than needed.
        encryptionCapability?.expire();
        // The append-owned plaintext snapshots are no longer needed once frame
        // encryption preparation completes. Clear them before physical I/O so
        // reducing copies also shortens, rather than extends, secret lifetime.
        for (const record of recordSnapshots) record.plaintext.fill(0);
      }

      const batchLength = frames.reduce((total, frame) => total + frame.header.frameLength, 0);
      const batch = allocateAuthenticatedHizoFSPhysicalBytes({ byteLength: batchLength });
      let batchOffset = 0;
      for (const frame of frames) {
        // WHY: ciphertext already exists as a Web Crypto result. Assemble each
        // canonical header + ciphertext directly into the one physical batch
        // instead of first materializing per-frame buffers and then copying
        // those complete frames again. Capacity checks, crypto ordering, and
        // the exact durable/read-back bytes remain unchanged.
        batch.set(frame.headerBytes, batchOffset);
        batch.set(frame.ciphertext, batchOffset + frame.headerBytes.byteLength);
        batchOffset += frame.header.frameLength;
      }
      if (batchOffset !== batchLength) throw new Error("record append batch length invariant failed");
      requireWriterStillActive({
        message: "segment writer was abandoned during append preparation",
        state: this.stateValue,
      });
      const { closeAfterAppend, file } = await this.writableFileForAppend();
      const writeAndSync = async (): Promise<void> => {
        const observedSize = await getOpenFileSizeWithAuthenticatedReason({
          backend: this.backend,
          diagnostics: this.diagnostics,
          file,
          reason: "trusted_tail",
        });
        requireWriterStillActive({
          message: "segment writer was abandoned while checking its trusted append tail",
          state: this.stateValue,
        });
        if (observedSize !== this.nextOffset) {
          this.diagnostics?.recordSegmentWriterEvent?.({ observation: {
            event: "trusted_tail_mismatch",
            segmentClass: this.segmentClassValue,
          } });
          this.stateValue = "abandoned";
          throw authenticatedStoreError({ code: "control_plane_corrupt", message: "active Segment trusted append tail changed" });
        }
        this.diagnostics?.recordSegmentWriterEvent?.({ observation: {
          event: "trusted_tail_match",
          segmentClass: this.segmentClassValue,
        } });
        requireWriterStillActive({
          message: "segment writer was abandoned before physical append",
          state: this.stateValue,
        });
        this.stateValue = "abandoned";
        await this.backend.writeAt({
          bytes: batch,
          file,
          offset: this.nextOffset,
        });
        await this.backend.syncFileData({ file });
      };
      if (closeAfterAppend) {
        await runAndCloseAuthenticatedFile({
          backend: this.backend,
          file,
          operation: writeAndSync,
          operationLabel: "record append",
        });
      } else {
        await writeAndSync();
      }
      const readBack = await readExactWithAuthenticatedReason({
        backend: this.backend,
        diagnostics: this.diagnostics,
        length: batch.byteLength,
        offset: this.nextOffset,
        path: this.path,
        reason: "append_read_back",
      });
      if (!bytesEqual({ left: readBack, right: batch })) {
        throw authenticatedStoreError({ code: "control_plane_corrupt", message: "durable record append read-back differs" });
      }
      this.diagnostics?.recordSegmentWriterEvent?.({ observation: {
        event: "append_read_back_verified",
        frameBytes: batch.byteLength,
        recordCount: frames.length,
        segmentClass: this.segmentClassValue,
      } });
      this.appendDurableFooterIndex({ frames });
      this.nextOffset = nextOffset;
      this.frameCount += frames.length;
      if (this.durableFooterIndexLength
        !== this.frameCount * HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentFooterIndexEntry) {
        throw new Error("active Segment durable Footer index count invariant failed");
      }
      this.persistedFrameBytesValue += batch.byteLength;
      if (!Number.isSafeInteger(this.persistedFrameBytesValue)) {
        throw new Error("persisted Record Frame byte count exceeds the safe integer bound");
      }
      for (const key of batchNonceKeys) this.usedNonceKeys.add(key);
      for (const frame of frames) {
        this.diagnostics?.recordPersistedRecord({
          operation: "write",
          physicalBytes: frame.header.frameLength,
          plaintextBytes: frame.header.plaintextLength,
          recordKind: frame.header.recordKind,
        });
      }
      if (this.explicitAbandonRequested) {
        throw new Error("segment writer was explicitly abandoned during append");
      }
      this.stateValue = "active";
      return frames.map(frame => frame.result);
    } finally {
      this.operationInProgress = false;
      switch (this.stateValue) {
      case "active":
        break;
      case "abandoned":
      case "sealed":
        this.beginRetainedWritableFileClose();
        this.releaseDurableFooterIndex();
        break;
      default:
        this.stateValue satisfies never;
      }
    }
  }

  public async seal(): Promise<void> {
    requireActiveWriter({ operation: "seal", state: this.stateValue });
    if (this.operationInProgress) throw new Error("segment writer operation already in progress");
    this.operationInProgress = true;
    try {
      if (this.frameCount === 0) throw new RangeError("an empty active Segment must not be sealed");
      this.stateValue = "abandoned";
      await this.closeRetainedWritableFile();
      await sealAuthenticatedSegment({
        writerCapability: {
          [activeSegmentWriterCapabilityBrand]: true,
          backend: this.backend,
          diagnostics: this.diagnostics,
          expectedFileSize: this.nextOffset,
          fileSystemId: this.fileSystemId,
          footerIndexBytes: this.durableFooterIndexBytes.subarray(0, this.durableFooterIndexLength),
          frameCount: this.frameCount,
          physicalSegmentId: this.segmentId,
          randomSource: this.randomSource,
          rootKey: this.rootKey,
          segmentClass: this.segmentClassValue,
        },
      });
      this.stateValue = "sealed";
      if (this.explicitAbandonRequested) {
        throw new Error("segment writer was explicitly abandoned during seal");
      }
    } finally {
      this.operationInProgress = false;
      switch (this.stateValue) {
      case "active":
        break;
      case "abandoned":
      case "sealed":
        this.releaseDurableFooterIndex();
        break;
      default:
        this.stateValue satisfies never;
      }
    }
  }
}

type CreateAuthenticatedSegmentWriterOptions = Omit<
  Parameters<typeof AuthenticatedSegmentWriter.create>[0],
  "writableFileLifetime"
>;

export async function createAuthenticatedSegmentWriter({
  backend,
  diagnostics,
  fileSystemId,
  randomSource,
  rootKey,
  segmentClass,
}: CreateAuthenticatedSegmentWriterOptions): Promise<AuthenticatedSegmentWriter> {
  return await AuthenticatedSegmentWriter.create({
    backend,
    diagnostics,
    fileSystemId,
    randomSource,
    rootKey,
    segmentClass,
    writableFileLifetime: "append",
  });
}

export async function createReusableAuthenticatedSegmentWriter({
  backend,
  diagnostics,
  fileSystemId,
  randomSource,
  rootKey,
  segmentClass,
}: CreateAuthenticatedSegmentWriterOptions): Promise<AuthenticatedSegmentWriter> {
  return await AuthenticatedSegmentWriter.create({
    backend,
    diagnostics,
    fileSystemId,
    randomSource,
    rootKey,
    segmentClass,
    writableFileLifetime: "writer",
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
