import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  createPhysicalRecordReference,
  createRecordFrameHeader,
  createUInt64,
  encodeRecordFrameHeader,
  encodeSegmentHeader,
  segmentClassForRecordKind,
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
  encryptRecord,
  encryptSegmentHeader,
  generateRecordNonce,
  generateSegmentId,
  plaintextRecordBytes,
  plaintextSegmentHeaderBytes,
  type FileSystemRootKey,
  type RandomByteSource,
  type RecordNonce,
} from "@/00-storage/service/hizofs/01-crypto";
import type { HizoFSWritableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import {
  CANONICAL_CONTAINER_ROOT,
  canonicalContainerDirectory,
  canonicalContainerPath,
  containerEntryName,
  parentContainerDirectory,
  type CanonicalContainerDirectory,
  type CanonicalContainerPath,
} from "@/00-storage/service/hizofs/physical-store/paths";
import { authenticatedStoreError } from "./errors";
import { runAndCloseAuthenticatedFile } from "./file-operation";
import { authenticatedHizoFSPhysicalBytes, type AuthenticatedHizoFSPhysicalBytes } from "./physical-bytes";
import {
  getFileSizeWithAuthenticatedReason,
  measureAuthenticatedCodecOperation,
  measureAuthenticatedCryptoOperation,
  readExactWithAuthenticatedReason,
  type AuthenticatedStoreDiagnosticsPort,
} from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";
import { authenticatedSegmentPath, segmentIdIsUsedAcrossClasses } from "./segment-location";
import { sealAuthenticatedSegment, type AuthenticatedSegmentIndex } from "./segment-footer-store";
import { readAuthenticatedSegmentDescriptor } from "./segment-prefix-reader";
import { createAuthenticatedWholeFile } from "./whole-file";

declare const activeSegmentWriterCapabilityBrand: unique symbol;
declare const encodedRecordBrand: unique symbol;

export type ActiveSegmentWriterCapability = Readonly<{
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
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

export type SegmentWriterState = "abandoned" | "active" | "sealed";

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
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function concatenate({ chunks, totalLength }: { chunks: readonly Uint8Array[]; totalLength: number }): Uint8Array {
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== totalLength) throw new Error("record append concatenation length invariant failed");
  return bytes;
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

async function createDirectoryIfMissing({ backend, path }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  path: CanonicalContainerDirectory;
}): Promise<void> {
  const parent = path === CANONICAL_CONTAINER_ROOT
    ? CANONICAL_CONTAINER_ROOT
    : parentContainerDirectory({ path: canonicalContainerPath({ value: path }) });
  const name = containerEntryName({ path });
  const existing = (await backend.list({ directory: parent })).find(entry => entry.name === name);
  switch (existing?.kind) {
  case "directory": return;
  case "file":
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: `required segment directory ${path} is occupied by a file`,
    });
  case undefined:
    await backend.createDirectoryExclusive({ path });
    await backend.syncDirectoryEntries({ parent });
    return;
  default:
    throw new Error(`Unhandled physical entry kind: ${((existing satisfies never) as { readonly kind: string }).kind}`);
  }
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
  await createDirectoryIfMissing({ backend, path: segmentDirectory });
  await createDirectoryIfMissing({ backend, path: classDirectory });
  await createDirectoryIfMissing({ backend, path: shardDirectory });
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
  readonly #backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  readonly #fileSystemId: FileSystemId;
  readonly #diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  readonly #path: CanonicalContainerPath;
  readonly #randomSource: RandomByteSource | undefined;
  readonly #rootKey: FileSystemRootKey;
  readonly #segmentClass: SegmentClass;
  readonly #segmentId: SegmentId;
  readonly #sealCapability: ActiveSegmentWriterCapability;
  readonly #usedNonceKeys = new Set<string>();
  #explicitAbandonRequested = false;
  #frameCount = 0;
  #nextOffset = BigInt(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader);
  #operationInProgress = false;
  #state: SegmentWriterState = "active";

  private constructor({ backend, diagnostics, fileSystemId, path, randomSource, rootKey, segmentClass, segmentId }: {
    backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
    diagnostics?: AuthenticatedStoreDiagnosticsPort;
    fileSystemId: FileSystemId;
    path: CanonicalContainerPath;
    randomSource?: RandomByteSource;
    rootKey: FileSystemRootKey;
    segmentClass: SegmentClass;
    segmentId: SegmentId;
  }) {
    this.#backend = backend;
    this.#diagnostics = diagnostics;
    this.#fileSystemId = fileSystemId;
    this.#path = path;
    this.#randomSource = randomSource;
    this.#rootKey = rootKey;
    this.#segmentClass = segmentClass;
    this.#segmentId = segmentId;
    this.#sealCapability = {
      backend,
      diagnostics,
      fileSystemId,
      physicalSegmentId: segmentId,
      randomSource,
      rootKey,
      segmentClass,
    } as ActiveSegmentWriterCapability;
  }

  public static async create({ backend, diagnostics, fileSystemId, randomSource, rootKey, segmentClass }: {
    backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
    diagnostics?: AuthenticatedStoreDiagnosticsPort;
    fileSystemId: FileSystemId;
    randomSource?: RandomByteSource;
    rootKey: FileSystemRootKey;
    segmentClass: SegmentClass;
  }): Promise<AuthenticatedSegmentWriter> {
    const segmentId = await generateSegmentId({
      isUsed: async ({ id }) => await segmentIdIsUsedAcrossClasses({ backend, segmentId: id }),
      randomSource,
    });
    await ensureSegmentDirectories({ backend, segmentClass, segmentId });
    const path = authenticatedSegmentPath({ segmentClass, segmentId });
    const header = await createAuthenticatedSegmentHeader({ diagnostics, fileSystemId, rootKey, segmentClass, segmentId });
    await createAuthenticatedWholeFile({
      backend,
      bytes: authenticatedHizoFSPhysicalBytes({ bytes: header }),
      path,
    });
    await readAuthenticatedSegmentDescriptor({ backend, diagnostics, fileSystemId, physicalSegmentId: segmentId, rootKey, segmentClass });
    diagnostics?.recordSegmentWriterEvent?.({ event: "descriptor_validated", segmentClass });
    diagnostics?.recordSegmentWriterEvent?.({ event: "created", segmentClass });
    return new AuthenticatedSegmentWriter({ backend, diagnostics, fileSystemId, path, randomSource, rootKey, segmentClass, segmentId });
  }

  public get physicalSegmentId(): SegmentId {
    return this.#segmentId;
  }
  public get segmentClass(): SegmentClass {
    return this.#segmentClass;
  }
  public get state(): SegmentWriterState {
    return this.#state;
  }

  /**
   * Measures only the canonical payload that is about to become a persisted
   * Record. Planning encodes used for sizing or ordering are intentionally not
   * counted as storage codec work.
   */
  public encodeRecordPayload({ encode }: { encode: () => Uint8Array }): Uint8Array {
    return measureAuthenticatedCodecOperation({
      diagnostics: this.#diagnostics,
      format: "record",
      operation: "encode",
      run: encode,
    });
  }

  public abandon(): void {
    switch (this.#state) {
    case "sealed":
      return;
    case "abandoned":
    case "active":
      this.#explicitAbandonRequested = true;
      this.#state = "abandoned";
      return;
    default:
      return this.#state satisfies never;
    }
  }

  public async append({ records }: { records: readonly EncodedHizoFSRecord[] }): Promise<readonly AppendedRecord[]> {
    requireActiveWriter({ operation: "append", state: this.#state });
    if (this.#operationInProgress) throw new Error("segment writer operation already in progress");
    this.#operationInProgress = true;
    this.#diagnostics?.recordSegmentWriterEvent?.({
      event: "append_started",
      segmentClass: this.#segmentClass,
    });
    try {
      if (records.length === 0) throw new RangeError("record append batch must not be empty");
      if (this.#frameCount + records.length > frameMaximumCount({ segmentClass: this.#segmentClass })) {
        throw new AuthenticatedSegmentCapacityError({
          capacity: "frame_count",
          message: "record append batch exceeds the segment frame-count bound",
        });
      }
      const recordSnapshots = records.map(record => {
        // Validate caller-controlled size and kind before copying. Rejected input
        // must not force an allocation proportional to bytes that V1 cannot store.
        if (segmentClassForRecordKind({ recordKind: record.recordKind }) !== this.#segmentClass) {
          throw new TypeError("record kind does not belong to the active segment class");
        }
        if (record.plaintext.byteLength > plaintextMaximum({ recordKind: record.recordKind })) {
          throw new RangeError("record plaintext exceeds its V1 bound");
        }
        return {
          plaintext: Uint8Array.from(record.plaintext),
          recordKind: record.recordKind,
        };
      });

      const batchNonceKeys = new Set<string>();
      const frames: Array<{ bytes: Uint8Array; header: RecordFrameHeaderV1; result: AppendedRecord }> = [];
      let nextOffset = this.#nextOffset;
      for (const record of recordSnapshots) {
        const nonce = freshRecordNonce({
          batchNonceKeys,
          randomSource: this.#randomSource,
          usedNonceKeys: this.#usedNonceKeys,
        });
        batchNonceKeys.add(nonceKey({ nonce }));
        const physicalOnly = record.recordKind === HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page;
        const header = createRecordFrameHeader({
          flags: physicalOnly ? HIZOFS_V1_FORMAT_CONSTANTS.flags.recordPhysicalOnly : 0,
          homeOffset: createUInt64({ value: nextOffset }),
          homeSegmentId: this.#segmentId,
          nonce,
          plaintextLength: record.plaintext.byteLength,
          recordKind: record.recordKind,
        });
        const end = nextOffset + BigInt(header.frameLength);
        const recordAreaLength = end - BigInt(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader);
        if (recordAreaLength > BigInt(recordAreaMaximum({ segmentClass: this.#segmentClass }))) {
          throw new AuthenticatedSegmentCapacityError({
            capacity: "record_area",
            message: "record append batch exceeds the segment record-area bound",
          });
        }
        const headerBytes = encodeRecordFrameHeader({ header });
        const ciphertext = await measureAuthenticatedCryptoOperation({
          diagnostics: this.#diagnostics,
          operation: "encrypt",
          run: async () => await encryptRecord({
            completeFrameHeader: headerBytes,
            fileSystemId: this.#fileSystemId,
            homeSegmentId: this.#segmentId,
            nonce,
            plaintext: plaintextRecordBytes({ bytes: record.plaintext }),
            rootKey: this.#rootKey,
          }),
        });
        const bytes = new Uint8Array(header.frameLength);
        bytes.set(headerBytes);
        bytes.set(ciphertext, headerBytes.byteLength);
        const physicalReference = createPhysicalRecordReference({ fields: {
          byteOffset: header.homeOffset,
          frameLength: header.frameLength,
          recordKind: header.recordKind,
          segmentId: this.#segmentId,
        } });
        const result: AppendedRecord = physicalOnly
          ? { physicalReference, type: "physical_only" }
          : {
            homeReference: createHomeRecordReference({ fields: {
              byteOffset: header.homeOffset,
              frameLength: header.frameLength,
              recordKind: header.recordKind,
              segmentId: this.#segmentId,
            } }),
            physicalReference,
            type: "home",
          };
        frames.push({ bytes, header, result });
        nextOffset = end;
      }

      const batchLength = frames.reduce((total, frame) => total + frame.bytes.byteLength, 0);
      const batch = concatenate({ chunks: frames.map(frame => frame.bytes), totalLength: batchLength });
      requireWriterStillActive({
        message: "segment writer was abandoned during append preparation",
        state: this.#state,
      });
      const observedSize = await getFileSizeWithAuthenticatedReason({
        backend: this.#backend,
        diagnostics: this.#diagnostics,
        path: this.#path,
        reason: "trusted_tail",
      });
      requireWriterStillActive({
        message: "segment writer was abandoned while checking its trusted append tail",
        state: this.#state,
      });
      if (observedSize !== this.#nextOffset) {
        this.#diagnostics?.recordSegmentWriterEvent?.({
          event: "trusted_tail_mismatch",
          segmentClass: this.#segmentClass,
        });
        this.#state = "abandoned";
        throw authenticatedStoreError({ code: "control_plane_corrupt", message: "active Segment trusted append tail changed" });
      }
      this.#diagnostics?.recordSegmentWriterEvent?.({
        event: "trusted_tail_match",
        segmentClass: this.#segmentClass,
      });
      const file = await this.#backend.openFileForUpdate({ path: this.#path });
      await runAndCloseAuthenticatedFile({
        backend: this.#backend,
        file,
        operation: async () => {
          requireWriterStillActive({
            message: "segment writer was abandoned before physical append",
            state: this.#state,
          });
          this.#state = "abandoned";
          await this.#backend.writeAt({
            bytes: authenticatedHizoFSPhysicalBytes({ bytes: batch }),
            file,
            offset: this.#nextOffset,
          });
          await this.#backend.syncFileData({ file });
        },
        operationLabel: "record append",
      });
      const readBack = await readExactWithAuthenticatedReason({
        backend: this.#backend,
        diagnostics: this.#diagnostics,
        length: batch.byteLength,
        offset: this.#nextOffset,
        path: this.#path,
        reason: "append_read_back",
      });
      if (!bytesEqual({ left: readBack, right: batch })) {
        throw authenticatedStoreError({ code: "control_plane_corrupt", message: "durable record append read-back differs" });
      }
      this.#diagnostics?.recordSegmentWriterEvent?.({
        event: "append_read_back_verified",
        segmentClass: this.#segmentClass,
      });
      this.#nextOffset = nextOffset;
      this.#frameCount += frames.length;
      for (const key of batchNonceKeys) this.#usedNonceKeys.add(key);
      for (const frame of frames) {
        this.#diagnostics?.recordPersistedRecord({
          operation: "write",
          physicalBytes: frame.bytes.byteLength,
          plaintextBytes: frame.header.plaintextLength,
          recordKind: frame.header.recordKind,
        });
      }
      if (this.#explicitAbandonRequested) {
        throw new Error("segment writer was explicitly abandoned during append");
      }
      this.#state = "active";
      return frames.map(frame => frame.result);
    } finally {
      this.#operationInProgress = false;
    }
  }

  public async seal(): Promise<AuthenticatedSegmentIndex> {
    requireActiveWriter({ operation: "seal", state: this.#state });
    if (this.#operationInProgress) throw new Error("segment writer operation already in progress");
    this.#operationInProgress = true;
    try {
      if (this.#frameCount === 0) throw new RangeError("an empty active Segment must not be sealed");
      this.#state = "abandoned";
      const sealed = await sealAuthenticatedSegment({
        writerCapability: this.#sealCapability,
      });
      this.#state = "sealed";
      if (this.#explicitAbandonRequested) {
        throw new Error("segment writer was explicitly abandoned during seal");
      }
      return sealed;
    } finally {
      this.#operationInProgress = false;
    }
  }
}

export async function createAuthenticatedSegmentWriter({ backend, diagnostics, fileSystemId, randomSource, rootKey, segmentClass }: Parameters<typeof AuthenticatedSegmentWriter.create>[0]): Promise<AuthenticatedSegmentWriter> {
  return await AuthenticatedSegmentWriter.create({
    backend,
    diagnostics,
    fileSystemId,
    randomSource,
    rootKey,
    segmentClass,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
