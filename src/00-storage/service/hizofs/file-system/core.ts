import type {
  HizoFSCommitDto,
  HizoFSSuperblockDto,
} from "@/00-storage/00-dto/hizofs.dto";
import {
  HizoFSCorruptionError,
  HizoFSUnsupportedFormatError,
} from "@/00-storage/service/hizofs/errors";
import type { HizoFSObjectStore } from "@/00-storage/service/hizofs/object-store/object-store";
import type { HizoFSSuperblockStore } from "@/00-storage/service/hizofs/object-store/superblock-store";
import { HizoFSCommitStore } from "./commit-store";
import type { HizoFSInodeIndex } from "./inode-index";
import type { HizoFSInodeStore } from "./inode-store";
import { runWithHizoFSMutationLock } from "./mutation-lock";
import { runWithHizoFSResourceLease } from "./maintenance-lock";
import type { HizoFSRuntimeDiagnostics } from "./diagnostics";

export type HizoFSActiveState = {
  readonly superblock: HizoFSSuperblockDto;
  readonly commitObjectId: string;
  readonly commit: HizoFSCommitDto;
  readonly mode: "current" | "fallback_read_only";
};

export type HizoFSMutationResult<T> = {
  readonly inodeIndexRootObjectId: string;
  readonly result: T;
  readonly changed: "yes" | "no";
};

function assertWritableActiveState({
  state,
}: {
  state: HizoFSActiveState;
}): void {
  switch (state.mode) {
  case "current":
    return;
  case "fallback_read_only":
    throw new HizoFSCorruptionError({
      message:
          "HizoFS opened an older complete generation in read-only recovery mode",
      cause: undefined,
    });
  default: {
    const _ex: never = state.mode;
    throw new Error(`Unhandled HizoFS active state mode: ${String(_ex)}`);
  }
  }
}

export class HizoFSCore {
  constructor({
    fileSystemId,
    objectStore,
    superblockStore,
    commitStore,
    inodeIndex,
    inodeStore,
    diagnostics,
  }: {
    fileSystemId: string;
    objectStore: HizoFSObjectStore;
    superblockStore: HizoFSSuperblockStore;
    commitStore: HizoFSCommitStore;
    inodeIndex: HizoFSInodeIndex;
    inodeStore: HizoFSInodeStore;
    diagnostics: HizoFSRuntimeDiagnostics | undefined;
  }) {
    this.fileSystemId = fileSystemId;
    this.objectStore = objectStore;
    this.superblockStore = superblockStore;
    this.commitStore = commitStore;
    this.inodeIndex = inodeIndex;
    this.inodeStore = inodeStore;
    this.diagnostics = diagnostics;
  }

  readonly fileSystemId: string;
  readonly objectStore: HizoFSObjectStore;
  readonly superblockStore: HizoFSSuperblockStore;
  readonly commitStore: HizoFSCommitStore;
  readonly inodeIndex: HizoFSInodeIndex;
  readonly inodeStore: HizoFSInodeStore;
  private readonly diagnostics: HizoFSRuntimeDiagnostics | undefined;

  async loadActiveState(): Promise<HizoFSActiveState> {
    // TODO(hizofs): Once every public operation is routed through the
    // authoritative cross-realm storage coordinator, serve the current
    // validated superblock/commit/root tuple from that coordinator and reload
    // A/B heads only during startup or failover. A realm-local cache is not a
    // safe substitute because another tab or Worker may publish while this
    // runtime remains alive.
    const candidateSet = await this.superblockStore.readCandidateSet();
    const { candidates } = candidateSet;
    if (candidates.length === 0) {
      throw new HizoFSCorruptionError({
        message: "HizoFS superblock is missing",
        cause: undefined,
      });
    }

    const rejected: unknown[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const superblock = candidates[index];
      if (superblock === undefined) continue;
      try {
        const commit = await this.commitStore.read({
          objectId: superblock.activeCommitObjectId,
        });
        const rootIndexEntry = await this.inodeIndex.get({
          rootObjectId: commit.inodeIndexRootObjectId,
          nodeId: commit.rootDirectoryNodeId,
        });
        if (rootIndexEntry === undefined) {
          throw new HizoFSCorruptionError({
            message: "HizoFS root directory is absent from the inode index",
            cause: undefined,
          });
        }
        const rootDirectory = await this.inodeStore.readDirectory({
          objectId: rootIndexEntry.inodeObjectId,
        });
        if (rootDirectory.nodeId !== commit.rootDirectoryNodeId) {
          throw new HizoFSCorruptionError({
            message: "HizoFS root directory inode identity is inconsistent",
            cause: undefined,
          });
        }
        return {
          superblock,
          commitObjectId: superblock.activeCommitObjectId,
          commit,
          mode:
            index === 0 && candidateSet.unusableSlotCount === 0
              ? "current"
              : "fallback_read_only",
        };
      } catch (error) {
        if (error instanceof HizoFSUnsupportedFormatError) {
          // A newer unsupported generation must not be silently interpreted as
          // an older writable filesystem.
          throw error;
        }
        rejected.push(error);
      }
    }

    throw new HizoFSCorruptionError({
      message: "No complete HizoFS superblock generation remains",
      cause: new AggregateError(rejected),
    });
  }

  async mutate<T>({
    operation,
  }: {
    operation: ({
      state,
    }: {
      state: HizoFSActiveState;
    }) => Promise<HizoFSMutationResult<T>>;
  }): Promise<T> {
    return runWithHizoFSResourceLease({
      fileSystemId: this.fileSystemId,
      operation: async () => await this.mutateWithResourceLeaseHeld({ operation }),
    });
  }

  /**
   * Publishes a mutation while the caller already owns a shared maintenance
   * lease. Writers and bulk builders must use this path because their prepared
   * immutable objects need protection from GC before publication. Reacquiring
   * a shared lease here could deadlock behind a queued exclusive GC request
   * while the caller still holds its original shared lease.
   */
  async mutateWithResourceLeaseHeld<T>({
    operation,
  }: {
    operation: ({
      state,
    }: {
      state: HizoFSActiveState;
    }) => Promise<HizoFSMutationResult<T>>;
  }): Promise<T> {
    // Immutable objects may be prepared without serializing every writer.
    // Only validation against the latest commit and publication of the new
    // commit/superblock are protected by the global mutation lock.
    while (true) {
      const baseState = await this.loadActiveState();
      assertWritableActiveState({ state: baseState });

      let mutation: HizoFSMutationResult<T>;
      try {
        mutation = await operation({ state: baseState });
      } catch (error) {
        const baseIsStillCurrent = await runWithHizoFSMutationLock({
          fileSystemId: this.fileSystemId,
          operation: async () => {
            const currentState = await this.loadActiveState();
            return currentState.commitObjectId === baseState.commitObjectId;
          },
        });
        if (!baseIsStillCurrent) {
          continue;
        }
        throw error;
      }

      const publication = await runWithHizoFSMutationLock({
        fileSystemId: this.fileSystemId,
        operation: async (): Promise<
          | { readonly type: "retry" }
          | { readonly type: "published"; readonly result: T }
        > => {
          const currentState = await this.loadActiveState();
          if (currentState.commitObjectId !== baseState.commitObjectId) {
            return { type: "retry" };
          }
          assertWritableActiveState({ state: currentState });

          switch (mutation.changed) {
          case "no":
            return { type: "published", result: mutation.result };
          case "yes": {
            const commit: HizoFSCommitDto = {
              revision: currentState.commit.revision + 1,
              rootDirectoryNodeId: currentState.commit.rootDirectoryNodeId,
              inodeIndexRootObjectId: mutation.inodeIndexRootObjectId,
            };
            const publish = async (): Promise<void> => {
              const commitObjectId = await this.commitStore.write({ commit });
              await this.superblockStore.write({
                value: {
                  sequence: currentState.superblock.sequence + 1,
                  fileSystemId: this.fileSystemId,
                  activeCommitObjectId: commitObjectId,
                },
              });
            };
            if (this.diagnostics === undefined) {
              await publish();
            } else {
              await this.diagnostics.measureAsync({
                phase: "commit_publication",
                operation: publish,
              });
            }
            return { type: "published", result: mutation.result };
          }
          default: {
            const _ex: never = mutation.changed;
            throw new Error(
              `Unhandled HizoFS mutation state: ${String(_ex)}`,
            );
          }
          }
        },
      });

      switch (publication.type) {
      case "retry":
        continue;
      case "published":
        return publication.result;
      default: {
        const _ex: never = publication;
        throw new Error(
          `Unhandled HizoFS publication state: ${String(_ex)}`,
        );
      }
      }
    }
  }

}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
