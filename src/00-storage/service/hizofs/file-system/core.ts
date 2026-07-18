import { HizoFSCorruptionError } from "@/00-storage/service/hizofs/errors";
import { createHizoFSStableId } from "@/00-storage/service/hizofs/id";
import type { HizoFSObjectStore } from "@/00-storage/service/hizofs/object-store/object-store";
import type { HizoFSSuperblockStore } from "@/00-storage/service/hizofs/object-store/superblock-store";
import { HizoFSCommitStore } from "./commit-store";
import type { HizoFSInodeIndex } from "./inode-index";
import type { HizoFSInodeStore } from "./inode-store";
import { runWithHizoFSResourceLease } from "./maintenance-lock";
import type { HizoFSRuntimeDiagnostics } from "./diagnostics";
import type { HizoFSActiveState } from './active-state';
import type { HizoFSActiveStateCoordinator } from './active-state-coordinator';

export type { HizoFSActiveState } from './active-state';

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
    activeStateCoordinator,
    diagnostics,
  }: {
    fileSystemId: string;
    objectStore: HizoFSObjectStore;
    superblockStore: HizoFSSuperblockStore;
    commitStore: HizoFSCommitStore;
    inodeIndex: HizoFSInodeIndex;
    inodeStore: HizoFSInodeStore;
    activeStateCoordinator: HizoFSActiveStateCoordinator;
    diagnostics: HizoFSRuntimeDiagnostics | undefined;
  }) {
    this.fileSystemId = fileSystemId;
    this.objectStore = objectStore;
    this.superblockStore = superblockStore;
    this.commitStore = commitStore;
    this.inodeIndex = inodeIndex;
    this.inodeStore = inodeStore;
    this.activeStateCoordinator = activeStateCoordinator;
    this.diagnostics = diagnostics;
  }

  readonly fileSystemId: string;
  readonly objectStore: HizoFSObjectStore;
  readonly superblockStore: HizoFSSuperblockStore;
  readonly commitStore: HizoFSCommitStore;
  readonly inodeIndex: HizoFSInodeIndex;
  readonly inodeStore: HizoFSInodeStore;
  private readonly activeStateCoordinator: HizoFSActiveStateCoordinator;
  private readonly diagnostics: HizoFSRuntimeDiagnostics | undefined;

  async loadActiveState(): Promise<HizoFSActiveState> {
    return await this.activeStateCoordinator.loadActiveState();
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
    while (true) {
      const baseState = await this.loadActiveState();
      assertWritableActiveState({ state: baseState });

      let mutation: HizoFSMutationResult<T>;
      try {
        mutation = await operation({ state: baseState });
      } catch (error) {
        if (
          !(await this.activeStateCoordinator.isCurrent({
            commitObjectId: baseState.commitObjectId,
          }))
        ) {
          continue;
        }
        throw error;
      }

      switch (mutation.changed) {
      case "no":
        if (
          await this.activeStateCoordinator.isCurrent({
            commitObjectId: baseState.commitObjectId,
          })
        ) {
          return mutation.result;
        }
        continue;
      case "yes":
        break;
      default: {
        const _ex: never = mutation.changed;
        throw new Error(`Unhandled HizoFS mutation state: ${String(_ex)}`);
      }
      }

      const publicationId = createHizoFSStableId();
      const publish = async () => await this.activeStateCoordinator.publish({
        publicationId,
        expectedCommitObjectId: baseState.commitObjectId,
        expectedRevision: baseState.commit.revision,
        inodeIndexRootObjectId: mutation.inodeIndexRootObjectId,
        flushPreparedRecords: async () => {
          await this.objectStore.flushPendingRecords();
        },
      });
      const publication = this.diagnostics === undefined
        ? await publish()
        : await this.diagnostics.measureAsync({
          phase: "commit_publication",
          operation: publish,
        });

      switch (publication.type) {
      case "retry":
        continue;
      case "published":
        return mutation.result;
      default: {
        const _ex: never = publication;
        throw new Error(`Unhandled HizoFS publication state: ${String(_ex)}`);
      }
      }
    }
  }


}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
