import type {
  DirectoryPage,
  FeatureBits,
  FileExtentPage,
  FileSystemCommitPayload,
  FileSystemId,
  HomeRecordReference,
  PhysicalRecordReference,
  PublicationSequence,
} from "@/00-storage/service/hizofs/00-format";
import type {
  FileSystemRootKey,
  RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import type { HizoFSWritableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import {
  appendAuthenticatedDirectoryPage,
  readAuthenticatedDirectoryPage,
} from "./directory-page-store";
import {
  appendAuthenticatedFileExtentPage,
  readAuthenticatedFileExtentPage,
} from "./file-extent-page-store";
import {
  appendAuthenticatedInodeTablePage,
  readAuthenticatedInodeTablePage,
  type AuthenticatedInodeTablePage,
} from "./inode-table-page-store";
import type { AuthenticatedHizoFSPhysicalBytes } from "./physical-bytes";
import {
  measureAuthenticatedPublicationOperation,
  type AuthenticatedStoreDiagnosticsPort,
} from "./runtime-diagnostics-port";
import {
  appendAndPublishPreparedMutationCommit,
  type PublishedPreparedMutationCommit,
} from "./prepared-mutation-commit-store";
import {
  AuthenticatedSegmentCapacityError,
  createAuthenticatedSegmentWriter,
  type AuthenticatedSegmentWriter,
} from "./record-appender";
import {
  resolveMutationSuperblockPublication,
  type MutationSuperblockPublicationResolution,
  type OpenedSuperblockCopies,
  type SuperblockLogicalState,
} from "./superblock-store";

export type AuthenticatedMetadataMutationAuthorityState = "active" | "closed" | "publishing";

export class AuthenticatedMetadataMutationAuthority {
  readonly #backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  readonly #diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  readonly #fileSystemId: FileSystemId;
  readonly #randomSource: RandomByteSource | undefined;
  readonly #relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
  readonly #rootKey: FileSystemRootKey;
  readonly #supportedFeatureBits: FeatureBits;
  #operationInProgress = false;
  #pageWriter: AuthenticatedSegmentWriter;
  #pageWriterHasRecords = false;
  #state: AuthenticatedMetadataMutationAuthorityState = "active";

  private constructor({
    backend,
    diagnostics,
    fileSystemId,
    pageWriter,
    randomSource,
    relocationIndexRootPhysicalRef,
    rootKey,
    supportedFeatureBits,
  }: {
    backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
    diagnostics?: AuthenticatedStoreDiagnosticsPort;
    fileSystemId: FileSystemId;
    pageWriter: AuthenticatedSegmentWriter;
    randomSource?: RandomByteSource;
    relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
    rootKey: FileSystemRootKey;
    supportedFeatureBits: FeatureBits;
  }) {
    this.#backend = backend;
    this.#diagnostics = diagnostics;
    this.#fileSystemId = fileSystemId;
    this.#pageWriter = pageWriter;
    this.#randomSource = randomSource;
    this.#relocationIndexRootPhysicalRef = relocationIndexRootPhysicalRef;
    this.#rootKey = rootKey;
    this.#supportedFeatureBits = supportedFeatureBits;
  }

  static async create({
    backend,
    diagnostics,
    fileSystemId,
    randomSource,
    relocationIndexRootPhysicalRef,
    rootKey,
    supportedFeatureBits,
  }: {
    backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
    diagnostics?: AuthenticatedStoreDiagnosticsPort;
    fileSystemId: FileSystemId;
    randomSource?: RandomByteSource;
    relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
    rootKey: FileSystemRootKey;
    supportedFeatureBits: FeatureBits;
  }): Promise<AuthenticatedMetadataMutationAuthority> {
    const pageWriter = await createAuthenticatedSegmentWriter({
      backend,
      diagnostics,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "metadata",
    });
    return new AuthenticatedMetadataMutationAuthority({
      backend,
      diagnostics,
      fileSystemId,
      pageWriter,
      randomSource,
      relocationIndexRootPhysicalRef,
      rootKey,
      supportedFeatureBits,
    });
  }

  state(): AuthenticatedMetadataMutationAuthorityState {
    return this.#state;
  }

  #requireActive({ operation }: { operation: string }): void {
    switch (this.#state) {
    case "active": break;
    case "closed": throw new Error(`cannot ${operation}: mutation authority is closed`);
    case "publishing": throw new Error(`cannot ${operation}: mutation authority is publishing`);
    default: return this.#state satisfies never;
    }
    if (this.#operationInProgress) throw new Error("mutation authority operation already in progress");
  }

  async #createPageWriter(): Promise<AuthenticatedSegmentWriter> {
    return await createAuthenticatedSegmentWriter({
      backend: this.#backend,
      diagnostics: this.#diagnostics,
      fileSystemId: this.#fileSystemId,
      randomSource: this.#randomSource,
      rootKey: this.#rootKey,
      segmentClass: "metadata",
    });
  }

  async #appendPageWithRollover({ append }: {
    append: ({ writer }: { writer: AuthenticatedSegmentWriter }) => Promise<HomeRecordReference>;
  }): Promise<HomeRecordReference> {
    try {
      const reference = await append({ writer: this.#pageWriter });
      this.#pageWriterHasRecords = true;
      return reference;
    } catch (error: unknown) {
      if (!(error instanceof AuthenticatedSegmentCapacityError) || !this.#pageWriterHasRecords) throw error;
      this.#pageWriter.abandon();
      this.#pageWriter = await this.#createPageWriter();
      this.#pageWriterHasRecords = false;
      const reference = await append({ writer: this.#pageWriter });
      this.#pageWriterHasRecords = true;
      return reference;
    }
  }

  async readFileExtentPage({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): Promise<FileExtentPage> {
    this.#requireActive({ operation: "read a File Extent page" });
    this.#operationInProgress = true;
    try {
      return await readAuthenticatedFileExtentPage({
        backend: this.#backend,
        diagnostics: this.#diagnostics,
        fileSystemId: this.#fileSystemId,
        homeReference: reference,
        isRoot,
        relocationIndexRootPhysicalRef: this.#relocationIndexRootPhysicalRef,
        rootKey: this.#rootKey,
      });
    } finally {
      this.#operationInProgress = false;
    }
  }

  async writeFileExtentPage({ isRoot, page }: {
    isRoot: boolean;
    page: FileExtentPage;
  }): Promise<HomeRecordReference> {
    this.#requireActive({ operation: "write a File Extent page" });
    this.#operationInProgress = true;
    try {
      return await this.#appendPageWithRollover({
        append: async ({ writer }) => await appendAuthenticatedFileExtentPage({ isRoot, page, writer }),
      });
    } finally {
      this.#operationInProgress = false;
    }
  }

  async readInodeTablePage({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): Promise<AuthenticatedInodeTablePage> {
    this.#requireActive({ operation: "read an Inode Table page" });
    this.#operationInProgress = true;
    try {
      return await readAuthenticatedInodeTablePage({
        backend: this.#backend,
        diagnostics: this.#diagnostics,
        fileSystemId: this.#fileSystemId,
        homeReference: reference,
        isRoot,
        relocationIndexRootPhysicalRef: this.#relocationIndexRootPhysicalRef,
        rootKey: this.#rootKey,
      });
    } finally {
      this.#operationInProgress = false;
    }
  }

  async writeInodeTablePage({ isRoot, page }: {
    isRoot: boolean;
    page: AuthenticatedInodeTablePage;
  }): Promise<HomeRecordReference> {
    this.#requireActive({ operation: "write an Inode Table page" });
    this.#operationInProgress = true;
    try {
      return await this.#appendPageWithRollover({
        append: async ({ writer }) => await appendAuthenticatedInodeTablePage({
          isRoot,
          page,
          writer,
        }),
      });
    } finally {
      this.#operationInProgress = false;
    }
  }

  async readDirectoryPage({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): Promise<DirectoryPage> {
    this.#requireActive({ operation: "read a Directory page" });
    this.#operationInProgress = true;
    try {
      return await readAuthenticatedDirectoryPage({
        backend: this.#backend,
        diagnostics: this.#diagnostics,
        fileSystemId: this.#fileSystemId,
        homeReference: reference,
        isRoot,
        relocationIndexRootPhysicalRef: this.#relocationIndexRootPhysicalRef,
        rootKey: this.#rootKey,
      });
    } finally {
      this.#operationInProgress = false;
    }
  }

  async writeDirectoryPage({ isRoot, page }: {
    isRoot: boolean;
    page: DirectoryPage;
  }): Promise<HomeRecordReference> {
    this.#requireActive({ operation: "write a Directory page" });
    this.#operationInProgress = true;
    try {
      return await this.#appendPageWithRollover({
        append: async ({ writer }) => await appendAuthenticatedDirectoryPage({
          isRoot,
          page,
          writer,
        }),
      });
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
  }: {
    base: OpenedSuperblockCopies;
    beforeFirstAuthorityWrite: () => void;
    commitPayload: FileSystemCommitPayload;
    firstPublicationSequence: PublicationSequence;
    secondPublicationSequence: PublicationSequence;
  }): Promise<PublishedPreparedMutationCommit> {
    this.#requireActive({ operation: "publish the prepared Commit" });
    this.#state = "publishing";
    this.#pageWriter.abandon();
    try {
      return await measureAuthenticatedPublicationOperation({
        diagnostics: this.#diagnostics,
        run: async () => await appendAndPublishPreparedMutationCommit({
          backend: this.#backend,
          base,
          beforeFirstAuthorityWrite,
          commitPayload,
          diagnostics: this.#diagnostics,
          fileSystemId: this.#fileSystemId,
          firstPublicationSequence,
          randomSource: this.#randomSource,
          rootKey: this.#rootKey,
          secondPublicationSequence,
          supportedFeatureBits: this.#supportedFeatureBits,
        }),
      });
    } finally {
      this.#state = "closed";
    }
  }

  async resolvePublication({ base, intendedLogicalState }: {
    base: OpenedSuperblockCopies;
    intendedLogicalState: SuperblockLogicalState;
  }): Promise<MutationSuperblockPublicationResolution> {
    switch (this.#state) {
    case "closed": break;
    case "active":
    case "publishing":
      throw new Error("cannot resolve publication before the mutation authority is closed");
    default: return this.#state satisfies never;
    }
    return await resolveMutationSuperblockPublication({
      backend: this.#backend,
      base,
      diagnostics: this.#diagnostics,
      fileSystemId: this.#fileSystemId,
      intendedLogicalState,
      rootKey: this.#rootKey,
      supportedFeatureBits: this.#supportedFeatureBits,
    });
  }

  abandon(): void {
    switch (this.#state) {
    case "active":
      this.#pageWriter.abandon();
      this.#state = "closed";
      return;
    case "closed": return;
    case "publishing": throw new Error("cannot abandon mutation authority during publication");
    default: return this.#state satisfies never;
    }
  }
}

export async function createAuthenticatedMetadataMutationAuthority({
  backend,
  diagnostics,
  fileSystemId,
  randomSource,
  relocationIndexRootPhysicalRef,
  rootKey,
  supportedFeatureBits,
}: Parameters<typeof AuthenticatedMetadataMutationAuthority.create>[0]): Promise<AuthenticatedMetadataMutationAuthority> {
  return await AuthenticatedMetadataMutationAuthority.create({
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
};
