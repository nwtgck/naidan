import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  type DirectoryPage,
  type FileExtentPage,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import type { AuthenticatedSegmentWriter } from "./record-appender";
import { createAuthenticatedSegmentWriter } from "./record-appender";
import { appendAuthenticatedFileData } from "./file-data-store";
import {
  AuthenticatedMetadataMutationAuthority,
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

export type AuthenticatedFileContentMutationAuthorityState = "active" | "closed" | "publishing";

/**
 * Owns exactly the additional data-segment capability needed by file content
 * mutations while delegating metadata pages and Commit publication to the
 * existing metadata authority. Keeping this wrapper separate prevents File
 * Data authority from leaking into directory-only mutation paths.
 */
export class AuthenticatedFileContentMutationAuthority {
  readonly #metadata: AuthenticatedMetadataMutationAuthority;
  readonly #parameters: Parameters<typeof createAuthenticatedMetadataMutationAuthority>[0];
  #dataFrameCount = 0;
  #dataRecordAreaBytes = 0;
  #dataWriter: AuthenticatedSegmentWriter | undefined;
  #operationInProgress = false;
  #state: AuthenticatedFileContentMutationAuthorityState = "active";

  private constructor({
    metadata,
    parameters,
  }: {
    metadata: AuthenticatedMetadataMutationAuthority;
    parameters: Parameters<typeof createAuthenticatedMetadataMutationAuthority>[0];
  }) {
    this.#metadata = metadata;
    this.#parameters = parameters;
  }

  static async create({
    backend,
    diagnostics,
    fileSystemId,
    randomSource,
    relocationIndexRootPhysicalRef,
    rootKey,
    sharedMetadataRecordCache,
    supportedFeatureBits,
  }: Parameters<typeof createAuthenticatedMetadataMutationAuthority>[0]): Promise<AuthenticatedFileContentMutationAuthority> {
    const parameters = {
      backend,
      diagnostics,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef,
      rootKey,
      sharedMetadataRecordCache,
      supportedFeatureBits,
    };
    return new AuthenticatedFileContentMutationAuthority({
      metadata: await createAuthenticatedMetadataMutationAuthority(parameters),
      parameters,
    });
  }

  state(): AuthenticatedFileContentMutationAuthorityState {
    return this.#state;
  }

  #requireActive({ operation }: { operation: string }): void {
    switch (this.#state) {
    case "active": break;
    case "closed": throw new Error(`cannot ${operation}: file content mutation authority is closed`);
    case "publishing": throw new Error(`cannot ${operation}: file content mutation authority is publishing`);
    default: return this.#state satisfies never;
    }
    if (this.#operationInProgress) throw new Error("file content mutation authority operation already in progress");
  }

  async #writerFor({ frameLength }: { frameLength: number }): Promise<AuthenticatedSegmentWriter> {
    if (this.#dataWriter !== undefined && segmentCanFit({
      frameCount: this.#dataFrameCount,
      nextFrameLength: frameLength,
      recordAreaBytes: this.#dataRecordAreaBytes,
    })) return this.#dataWriter;
    this.#dataWriter?.abandon();
    this.#dataWriter = undefined;
    this.#dataWriter = await createAuthenticatedSegmentWriter({
      backend: this.#parameters.backend,
      diagnostics: this.#parameters.diagnostics,
      fileSystemId: this.#parameters.fileSystemId,
      randomSource: this.#parameters.randomSource,
      rootKey: this.#parameters.rootKey,
      segmentClass: "data",
    });
    this.#dataFrameCount = 0;
    this.#dataRecordAreaBytes = 0;
    return this.#dataWriter;
  }

  async writeFileData({ bytes }: { bytes: Uint8Array }): Promise<HomeRecordReference> {
    this.#requireActive({ operation: "write File Data" });
    this.#operationInProgress = true;
    try {
      const frameLength = fileDataFrameLength({ plaintextLength: bytes.byteLength });
      const reference = await appendAuthenticatedFileData({
        bytes,
        writer: await this.#writerFor({ frameLength }),
      });
      this.#dataFrameCount += 1;
      this.#dataRecordAreaBytes += frameLength;
      return reference;
    } finally {
      this.#operationInProgress = false;
    }
  }

  async readDirectoryPage({ isRoot, reference }: Parameters<AuthenticatedMetadataMutationAuthority["readDirectoryPage"]>[0]): Promise<DirectoryPage> {
    this.#requireActive({ operation: "read a Directory page" });
    this.#operationInProgress = true;
    try {
      return await this.#metadata.readDirectoryPage({ isRoot, reference });
    } finally {
      this.#operationInProgress = false;
    }
  }

  async writeDirectoryPage({ isRoot, page }: Parameters<AuthenticatedMetadataMutationAuthority["writeDirectoryPage"]>[0]): Promise<HomeRecordReference> {
    this.#requireActive({ operation: "write a Directory page" });
    this.#operationInProgress = true;
    try {
      return await this.#metadata.writeDirectoryPage({ isRoot, page });
    } finally {
      this.#operationInProgress = false;
    }
  }

  async readFileExtentPage({ isRoot, reference }: Parameters<AuthenticatedMetadataMutationAuthority["readFileExtentPage"]>[0]): Promise<FileExtentPage> {
    this.#requireActive({ operation: "read a File Extent page" });
    this.#operationInProgress = true;
    try {
      return await this.#metadata.readFileExtentPage({ isRoot, reference });
    } finally {
      this.#operationInProgress = false;
    }
  }

  async writeFileExtentPage({ isRoot, page }: Parameters<AuthenticatedMetadataMutationAuthority["writeFileExtentPage"]>[0]): Promise<HomeRecordReference> {
    this.#requireActive({ operation: "write a File Extent page" });
    this.#operationInProgress = true;
    try {
      return await this.#metadata.writeFileExtentPage({ isRoot, page });
    } finally {
      this.#operationInProgress = false;
    }
  }

  async readInodeTablePage({
    isRoot,
    reference,
  }: Parameters<AuthenticatedMetadataMutationAuthority["readInodeTablePage"]>[0]): Promise<Awaited<ReturnType<AuthenticatedMetadataMutationAuthority["readInodeTablePage"]>>> {
    this.#requireActive({ operation: "read an Inode Table page" });
    this.#operationInProgress = true;
    try {
      return await this.#metadata.readInodeTablePage({ isRoot, reference });
    } finally {
      this.#operationInProgress = false;
    }
  }

  async writeInodeTablePage({
    isRoot,
    page,
  }: Parameters<AuthenticatedMetadataMutationAuthority["writeInodeTablePage"]>[0]): Promise<HomeRecordReference> {
    this.#requireActive({ operation: "write an Inode Table page" });
    this.#operationInProgress = true;
    try {
      return await this.#metadata.writeInodeTablePage({ isRoot, page });
    } finally {
      this.#operationInProgress = false;
    }
  }

  async publish({
    base,
    beforeFirstAuthorityWrite,
    commitPayload,
    firstPublicationSequence,
    secondPublicationSequence,
  }: Parameters<AuthenticatedMetadataMutationAuthority["publish"]>[0]): Promise<Awaited<ReturnType<AuthenticatedMetadataMutationAuthority["publish"]>>> {
    this.#requireActive({ operation: "publish file content" });
    this.#operationInProgress = true;
    this.#state = "publishing";
    this.#dataWriter?.abandon();
    try {
      return await this.#metadata.publish({
        base,
        beforeFirstAuthorityWrite,
        commitPayload,
        firstPublicationSequence,
        secondPublicationSequence,
      });
    } finally {
      this.#operationInProgress = false;
      this.#state = "closed";
    }
  }

  async resolvePublication({
    base,
    intendedLogicalState,
  }: Parameters<AuthenticatedMetadataMutationAuthority["resolvePublication"]>[0]): Promise<Awaited<ReturnType<AuthenticatedMetadataMutationAuthority["resolvePublication"]>>> {
    switch (this.#state) {
    case "closed": return await this.#metadata.resolvePublication({ base, intendedLogicalState });
    case "active":
    case "publishing": throw new Error("cannot resolve publication before the file content mutation authority is closed");
    default: return this.#state satisfies never;
    }
  }

  abandon(): void {
    switch (this.#state) {
    case "active":
      if (this.#operationInProgress) {
        throw new Error("cannot abandon file content mutation authority while an operation is in progress");
      }
      this.#dataWriter?.abandon();
      this.#metadata.abandon();
      this.#state = "closed";
      return;
    case "closed": return;
    case "publishing": throw new Error("cannot abandon file content mutation authority during publication");
    default: return this.#state satisfies never;
    }
  }
}

export async function createAuthenticatedFileContentMutationAuthority({
  backend,
  diagnostics,
  fileSystemId,
  randomSource,
  relocationIndexRootPhysicalRef,
  rootKey,
  supportedFeatureBits,
}: Parameters<typeof AuthenticatedFileContentMutationAuthority.create>[0]): Promise<AuthenticatedFileContentMutationAuthority> {
  return await AuthenticatedFileContentMutationAuthority.create({
    backend,
    diagnostics,
    fileSystemId,
    randomSource,
    relocationIndexRootPhysicalRef,
    rootKey,
    supportedFeatureBits,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  fileDataFrameLength,
  segmentCanFit,
};
