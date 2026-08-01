import {
  ExplicitBulkCandidate,
  type SealedExplicitBulkCandidate,
} from "@/00-storage/service/hizofs/filesystem/bulk/explicit-bulk-candidate";
import {
  ExplicitBulkLifecycle,
  type ExplicitBulkLifecycleState,
  type ExplicitBulkOwnerView,
} from "@/00-storage/service/hizofs/filesystem/bulk/explicit-bulk-lifecycle";

type ExplicitBulkCandidateOptions = ConstructorParameters<typeof ExplicitBulkCandidate>[0];
type CreateDirectoryRequest = Parameters<ExplicitBulkCandidate["createDirectory"]>[0];
type CreateDirectoryWithTimestampsRequest = Parameters<ExplicitBulkCandidate["createDirectoryWithTimestamps"]>[0];
type CreateEmptyFileRequest = Parameters<ExplicitBulkCandidate["createEmptyFile"]>[0];
type CreateFileRequest = Parameters<ExplicitBulkCandidate["createFile"]>[0];
type CreateInlineFileRequest = Parameters<ExplicitBulkCandidate["createInlineFile"]>[0];
type CreateSymlinkRequest = Parameters<ExplicitBulkCandidate["createSymlink"]>[0];

/**
 * Combines the private candidate and its publication authority into one
 * single-use capability. Keeping both behind this boundary prevents callers
 * from publishing a partially prepared tree or bypassing owner-close
 * revocation between private preparation and the final authority gate.
 */
export class ExplicitBulkBuilder {
  readonly #candidate: ExplicitBulkCandidate;
  readonly #lifecycle: ExplicitBulkLifecycle;

  constructor({ candidate, ownerView, target }: {
    candidate: ExplicitBulkCandidateOptions;
    ownerView: ExplicitBulkOwnerView;
    target: Readonly<{ empty: boolean; fresh: boolean }>;
  }) {
    this.#candidate = new ExplicitBulkCandidate(candidate);
    this.#lifecycle = new ExplicitBulkLifecycle({ ownerView, target });
  }

  state(): ExplicitBulkLifecycleState {
    return this.#lifecycle.state();
  }

  createDirectory({ name, parentDirectoryInodeNumber, timestamp }: CreateDirectoryRequest): Promise<ReturnType<ExplicitBulkCandidate["createDirectory"]>> {
    return this.#lifecycle.runMutation({
      operation: async ({ assertActive }) => {
        assertActive();
        const result = this.#candidate.createDirectory({ name, parentDirectoryInodeNumber, timestamp });
        assertActive();
        return result;
      },
    });
  }

  createDirectoryWithTimestamps({ name, parentDirectoryInodeNumber, timestamps }: CreateDirectoryWithTimestampsRequest): Promise<ReturnType<ExplicitBulkCandidate["createDirectoryWithTimestamps"]>> {
    return this.#lifecycle.runMutation({
      operation: async ({ assertActive }) => {
        assertActive();
        const result = this.#candidate.createDirectoryWithTimestamps({ name, parentDirectoryInodeNumber, timestamps });
        assertActive();
        return result;
      },
    });
  }

  createEmptyFile({ name, parentDirectoryInodeNumber, timestamp }: CreateEmptyFileRequest): Promise<ReturnType<ExplicitBulkCandidate["createEmptyFile"]>> {
    return this.#lifecycle.runMutation({
      operation: async ({ assertActive }) => {
        assertActive();
        const result = this.#candidate.createEmptyFile({ name, parentDirectoryInodeNumber, timestamp });
        assertActive();
        return result;
      },
    });
  }

  createInlineFile({ bytes, name, parentDirectoryInodeNumber, timestamp }: CreateInlineFileRequest): Promise<ReturnType<ExplicitBulkCandidate["createInlineFile"]>> {
    return this.#lifecycle.runMutation({
      operation: async ({ assertActive }) => {
        assertActive();
        const result = this.#candidate.createInlineFile({ bytes, name, parentDirectoryInodeNumber, timestamp });
        assertActive();
        return result;
      },
    });
  }

  createFile({ content, fileSize, name, parentDirectoryInodeNumber, timestamps }: CreateFileRequest): Promise<ReturnType<ExplicitBulkCandidate["createFile"]>> {
    return this.#lifecycle.runMutation({
      operation: async ({ assertActive }) => {
        assertActive();
        const result = this.#candidate.createFile({ content, fileSize, name, parentDirectoryInodeNumber, timestamps });
        assertActive();
        return result;
      },
    });
  }

  createSymlink({ name, parentDirectoryInodeNumber, target, timestamps }: CreateSymlinkRequest): Promise<ReturnType<ExplicitBulkCandidate["createSymlink"]>> {
    return this.#lifecycle.runMutation({
      operation: async ({ assertActive }) => {
        assertActive();
        const result = this.#candidate.createSymlink({ name, parentDirectoryInodeNumber, target, timestamps });
        assertActive();
        return result;
      },
    });
  }

  commit<TPrepared, TResult>({ prepare, publish }: {
    prepare: ({ candidate }: { candidate: SealedExplicitBulkCandidate }) => Promise<TPrepared>;
    publish: ({ candidate, prepared }: {
      candidate: SealedExplicitBulkCandidate;
      prepared: TPrepared;
    }) => Promise<TResult>;
  }): Promise<TResult> {
    return this.#lifecycle.commit({
      publication: async ({ assertPublicationAllowed }) => {
        const candidate = this.#candidate.seal();
        const prepared = await prepare({ candidate });

        // This is the sole transition from private preparation to authority
        // publication. Owner close may revoke before this point, but not once
        // publication has begun and its outcome may already be externally
        // visible.
        assertPublicationAllowed();
        return publish({ candidate, prepared });
      },
    });
  }

  ownerClose(): void {
    this.#lifecycle.ownerClose();
  }

  abort(): void {
    this.#lifecycle.abort();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
