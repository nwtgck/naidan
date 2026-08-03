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
import { AuthenticatedMetadataRecordCache } from "./metadata-record-cache";
import {
  measureAuthenticatedPublicationOperation,
  type AuthenticatedStoreDiagnosticsPort,
} from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";
import {
  appendPreparedMutationCommit,
  publishPreparedMutationCommit,
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

// Mutation-local plaintext is intentionally smaller than the session cache.
// The full Home Record Reference remains the identity, and disposal is coupled
// to the terminal mutation outcome rather than session lifetime.
const MUTATION_METADATA_RECORD_CACHE_POLICY = Object.freeze({
  maximumBytes: 2 * 1024 * 1024,
  maximumEntries: 256,
});

export class AuthenticatedMetadataMutationAuthority {
  readonly #backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  readonly #diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  readonly #fileSystemId: FileSystemId;
  readonly #metadataRecordCache: AuthenticatedMetadataRecordCache;
  readonly #randomSource: RandomByteSource | undefined;
  readonly #relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
  readonly #rootKey: FileSystemRootKey;
  readonly #sharedMetadataRecordCache: AuthenticatedMetadataRecordCache | undefined;
  readonly #supportedFeatureBits: FeatureBits;
  #mutationDiagnosticsOpen = true;
  #operationInProgress = false;
  #pageWriter: AuthenticatedSegmentWriter;
  #pageWriterHasRecords = false;
  #state: AuthenticatedMetadataMutationAuthorityState = "active";

  private constructor({
    backend,
    diagnostics,
    fileSystemId,
    metadataRecordCache,
    pageWriter,
    randomSource,
    relocationIndexRootPhysicalRef,
    rootKey,
    sharedMetadataRecordCache,
    supportedFeatureBits,
  }: {
    backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
    diagnostics?: AuthenticatedStoreDiagnosticsPort;
    fileSystemId: FileSystemId;
    metadataRecordCache: AuthenticatedMetadataRecordCache;
    pageWriter: AuthenticatedSegmentWriter;
    randomSource?: RandomByteSource;
    relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
    rootKey: FileSystemRootKey;
    sharedMetadataRecordCache?: AuthenticatedMetadataRecordCache;
    supportedFeatureBits: FeatureBits;
  }) {
    this.#backend = backend;
    this.#diagnostics = diagnostics;
    this.#fileSystemId = fileSystemId;
    this.#metadataRecordCache = metadataRecordCache;
    this.#pageWriter = pageWriter;
    this.#randomSource = randomSource;
    this.#relocationIndexRootPhysicalRef = relocationIndexRootPhysicalRef;
    this.#rootKey = rootKey;
    this.#sharedMetadataRecordCache = sharedMetadataRecordCache;
    this.#supportedFeatureBits = supportedFeatureBits;
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
  }: {
    backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
    diagnostics?: AuthenticatedStoreDiagnosticsPort;
    fileSystemId: FileSystemId;
    randomSource?: RandomByteSource;
    relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
    rootKey: FileSystemRootKey;
    sharedMetadataRecordCache?: AuthenticatedMetadataRecordCache;
    supportedFeatureBits: FeatureBits;
  }): Promise<AuthenticatedMetadataMutationAuthority> {
    diagnostics?.recordMutationScopeEvent?.({ observation: { event: "begin" } });
    const metadataRecordCache = new AuthenticatedMetadataRecordCache({
      diagnosticScope: "mutation",
      diagnostics,
      policy: MUTATION_METADATA_RECORD_CACHE_POLICY,
    });
    try {
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
        metadataRecordCache,
        pageWriter,
        randomSource,
        relocationIndexRootPhysicalRef,
        rootKey,
        sharedMetadataRecordCache,
        supportedFeatureBits,
      });
    } catch (error: unknown) {
      metadataRecordCache.dispose();
      diagnostics?.recordMutationScopeEvent?.({ observation: { event: "end", outcome: "failed" } });
      throw error;
    }
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

  #closeMutationDiagnostics({ outcome }: {
    outcome: "abandoned" | "failed" | "published";
  }): void {
    if (!this.#mutationDiagnosticsOpen) return;
    this.#mutationDiagnosticsOpen = false;
    this.#metadataRecordCache.dispose();
    this.#diagnostics?.recordMutationScopeEvent?.({ observation: { event: "end", outcome } });
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

  async #appendMetadataRecordWithRollover({ append }: {
    append: ({ writer }: { writer: AuthenticatedSegmentWriter }) => Promise<HomeRecordReference>;
  }): Promise<HomeRecordReference> {
    try {
      const reference = await append({ writer: this.#pageWriter });
      this.#pageWriterHasRecords = true;
      return reference;
    } catch (error: unknown) {
      if (!(error instanceof AuthenticatedSegmentCapacityError) || !this.#pageWriterHasRecords) throw error;
      this.#pageWriter.abandon();
      this.#diagnostics?.recordSegmentWriterEvent?.({
        event: "rollover",
        segmentClass: "metadata",
      });
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
        metadataRecordCache: this.#metadataRecordCache,
        sharedMetadataRecordCache: this.#sharedMetadataRecordCache,
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
      return await this.#appendMetadataRecordWithRollover({
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
        metadataRecordCache: this.#metadataRecordCache,
        sharedMetadataRecordCache: this.#sharedMetadataRecordCache,
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
      return await this.#appendMetadataRecordWithRollover({
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
        metadataRecordCache: this.#metadataRecordCache,
        sharedMetadataRecordCache: this.#sharedMetadataRecordCache,
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
      return await this.#appendMetadataRecordWithRollover({
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
    let outcome: "failed" | "published" = "failed";
    try {
      const published = await measureAuthenticatedPublicationOperation({
        diagnostics: this.#diagnostics,
        run: async () => {
          try {
            const commitHomeRef = await this.#appendMetadataRecordWithRollover({
              append: async ({ writer }) => await appendPreparedMutationCommit({
                commitPayload,
                writer,
              }),
            });
            this.#pageWriter.abandon();
            return await publishPreparedMutationCommit({
              backend: this.#backend,
              base,
              beforeFirstAuthorityWrite,
              commitHomeRef,
              commitPayload,
              diagnostics: this.#diagnostics,
              fileSystemId: this.#fileSystemId,
              firstPublicationSequence,
              randomSource: this.#randomSource,
              rootKey: this.#rootKey,
              secondPublicationSequence,
              supportedFeatureBits: this.#supportedFeatureBits,
            });
          } finally {
            this.#pageWriter.abandon();
          }
        },
      });
      outcome = "published";
      return published;
    } finally {
      this.#state = "closed";
      this.#closeMutationDiagnostics({ outcome });
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
      this.#closeMutationDiagnostics({ outcome: "abandoned" });
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
  sharedMetadataRecordCache,
  supportedFeatureBits,
}: Parameters<typeof AuthenticatedMetadataMutationAuthority.create>[0]): Promise<AuthenticatedMetadataMutationAuthority> {
  return await AuthenticatedMetadataMutationAuthority.create({
    backend,
    diagnostics,
    fileSystemId,
    randomSource,
    relocationIndexRootPhysicalRef,
    rootKey,
    sharedMetadataRecordCache,
    supportedFeatureBits,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
