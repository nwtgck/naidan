import {
  createFileSystemCommitPayload,
  type DirectoryInodeEntry,
  type DirectoryLeafEntry,
  type FileSystemCommitPayload,
  type InodeNumber,
  type MutationId,
  type TimestampMilliseconds,
} from "@/00-storage/service/hizofs/00-format";
import type { DirectoryPageTreePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import {
  prepareRootInodeTableMutation,
  type RootInodeTableMutation,
  type RootInodeTablePageStore,
} from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import {
  inlineDirectoryCreateCandidateFits,
  prepareInlineDirectoryCreateCandidateParent,
  prepareInlineDirectoryCreateMutationFromCandidate,
} from "@/00-storage/service/hizofs/filesystem/namespace/inline-directory-create-mutation";
import {
  prepareInlineDirectoryPromotionCreateMutation,
} from "@/00-storage/service/hizofs/filesystem/namespace/inline-directory-promotion-create-mutation";
import {
  prepareOrdinaryEntryCreatePlan,
  type OrdinaryEntryCreatePlan,
  type OrdinaryEntryCreateRequest,
  type OrdinaryEntryCreateTargetDescriptor,
} from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-create-plan";
import { CapturedTreeBackedDirectoryCreateDestination } from "@/00-storage/service/hizofs/filesystem/namespace/tree-backed-directory-create-mutation";

export type PreparedOrdinaryEntryCreateCommit = Readonly<{
  commitPayload: FileSystemCommitPayload;
  plan: OrdinaryEntryCreatePlan;
  updatedParent: DirectoryInodeEntry;
}>;

type PreparedOrdinaryEntryCreateMutation = Readonly<{
  changes: readonly RootInodeTableMutation[];
  updatedParent: DirectoryInodeEntry;
}>;

type CapturedOrdinaryEntryCreateRepresentation = Readonly<
  | { type: "inline" }
  | { captured: CapturedTreeBackedDirectoryCreateDestination; type: "tree" }
>;

/**
 * Nominally binds one destination observation to the immutable parent root and
 * page-store capability used to prepare an ordinary create. Production
 * create-if-missing can inspect this capture and, when absent, reuse the exact
 * same observation for mutation preparation instead of traversing the
 * namespace again. Standalone callers still capture defensively below.
 */
export class CapturedOrdinaryEntryCreateDestination {
  readonly existingEntry: DirectoryLeafEntry | undefined;
  private readonly directoryPageStore: DirectoryPageTreePageStore;
  private readonly parent: DirectoryInodeEntry;
  private readonly representation: CapturedOrdinaryEntryCreateRepresentation;
  private readonly target: OrdinaryEntryCreateTargetDescriptor;

  private constructor({ directoryPageStore, existingEntry, parent, representation, target }: {
    directoryPageStore: DirectoryPageTreePageStore;
    existingEntry: DirectoryLeafEntry | undefined;
    parent: DirectoryInodeEntry;
    representation: CapturedOrdinaryEntryCreateRepresentation;
    target: OrdinaryEntryCreateTargetDescriptor;
  }) {
    this.directoryPageStore = directoryPageStore;
    this.existingEntry = existingEntry;
    this.parent = parent;
    this.representation = representation;
    this.target = target;
  }

  static async capture({ directoryPageStore, parent, target }: {
    directoryPageStore: DirectoryPageTreePageStore;
    parent: DirectoryInodeEntry;
    target: OrdinaryEntryCreateTargetDescriptor;
  }): Promise<CapturedOrdinaryEntryCreateDestination> {
    switch (parent.content.type) {
    case "inline": return new CapturedOrdinaryEntryCreateDestination({
      directoryPageStore,
      existingEntry: parent.content.entries.find(entry => entry.name === target.entryName),
      parent,
      representation: { type: "inline" },
      target,
    });
    case "tree": {
      const captured = await CapturedTreeBackedDirectoryCreateDestination.capture({
        entryName: target.entryName,
        pageStore: directoryPageStore,
        parent,
      });
      return new CapturedOrdinaryEntryCreateDestination({
        directoryPageStore,
        existingEntry: captured.existingEntry,
        parent,
        representation: { captured, type: "tree" },
        target,
      });
    }
    default: return parent.content satisfies never;
    }
  }

  release(): void {
    switch (this.representation.type) {
    case "inline": return;
    case "tree": this.representation.captured.release(); return;
    default: return this.representation satisfies never;
    }
  }

  async prepareCommit({
    baseCommit,
    inodeTablePageStore,
    maximumKnownInodeNumber,
    mutationId,
    operationTimestamp,
    request,
  }: Readonly<{
    baseCommit: FileSystemCommitPayload;
    inodeTablePageStore: RootInodeTablePageStore;
    maximumKnownInodeNumber: InodeNumber | undefined;
    mutationId: MutationId;
    operationTimestamp: TimestampMilliseconds;
    request: OrdinaryEntryCreateRequest;
  }>): Promise<PreparedOrdinaryEntryCreateCommit> {
    try {
      const plan = prepareOrdinaryEntryCreatePlan({
        maximumKnownInodeNumber,
        nextInodeNumber: baseCommit.nextInodeNumber,
        operationTimestamp,
        request,
        target: { ...this.target, destinationExists: this.existingEntry !== undefined },
      });
      const mutation: PreparedOrdinaryEntryCreateMutation = await (async () => {
        switch (this.representation.type) {
        case "inline": {
          const candidateParent = prepareInlineDirectoryCreateCandidateParent({ parent: this.parent, plan });
          if (inlineDirectoryCreateCandidateFits({ candidateParent })) {
            return prepareInlineDirectoryCreateMutationFromCandidate({ candidateParent, plan });
          }
          return await prepareInlineDirectoryPromotionCreateMutation({
            candidateParent,
            pageStore: this.directoryPageStore,
            plan,
          });
        }
        case "tree": return await this.representation.captured.prepareMutation({ plan });
        default: return this.representation satisfies never;
        }
      })();
      const prepared = await prepareRootInodeTableMutation({
        baseCommit,
        changes: mutation.changes,
        mutationId,
        pageStore: inodeTablePageStore,
      });
      switch (prepared.type) {
      case "unchanged":
        throw new Error("ordinary entry creation unexpectedly produced no Inode Table change");
      case "prepared": return {
        commitPayload: createFileSystemCommitPayload({ payload: {
          ...prepared.commitPayload,
          nextInodeNumber: plan.nextInodeNumber,
        } }),
        plan,
        updatedParent: mutation.updatedParent,
      };
      default: return prepared satisfies never;
      }
    } finally {
      this.release();
    }
  }
}

/**
 * Selects the logical directory representation while remaining independent of
 * authenticated storage and publication authority. Inline directories promote
 * to a private immutable Directory Page root before the replacement parent is
 * included in the same unpublished Commit as the newly allocated inode.
 */
export async function prepareOrdinaryEntryCreateCommit({
  baseCommit,
  directoryPageStore,
  inodeTablePageStore,
  maximumKnownInodeNumber,
  mutationId,
  operationTimestamp,
  parent,
  request,
  target,
}: Readonly<{
  baseCommit: FileSystemCommitPayload;
  directoryPageStore: DirectoryPageTreePageStore;
  inodeTablePageStore: RootInodeTablePageStore;
  maximumKnownInodeNumber: InodeNumber | undefined;
  mutationId: MutationId;
  operationTimestamp: TimestampMilliseconds;
  parent: DirectoryInodeEntry;
  request: OrdinaryEntryCreateRequest;
  target: OrdinaryEntryCreateTargetDescriptor;
}>): Promise<PreparedOrdinaryEntryCreateCommit> {
  const destination = await CapturedOrdinaryEntryCreateDestination.capture({
    directoryPageStore,
    parent,
    target,
  });
  return await destination.prepareCommit({
    baseCommit,
    inodeTablePageStore,
    maximumKnownInodeNumber,
    mutationId,
    operationTimestamp,
    request,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
