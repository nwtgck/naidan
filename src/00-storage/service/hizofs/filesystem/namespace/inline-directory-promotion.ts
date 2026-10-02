import {
  assertInodeLeafEntryFitsMetadataPage,
  encodedDirectoryLeafEntryByteLength,
  HIZOFS_V1_FORMAT_CONSTANTS,
  type DirectoryInodeEntry,
  type DirectoryLeafEntry,
} from "@/00-storage/service/hizofs/00-format";
import type { DirectoryPageTreePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import type { RootInodeTableMutation } from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import type { OrdinaryEntryCreatePlan } from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-create-plan";

export type InlineDirectoryPromotionCreateMutation = Readonly<{
  changes: readonly RootInodeTableMutation[];
  updatedParent: DirectoryInodeEntry;
}>;

export type InlineDirectoryCandidateParent = Readonly<
  Omit<DirectoryInodeEntry, "content"> & {
    content: Extract<DirectoryInodeEntry["content"], { type: "inline" }>;
  }
>;

export function inlineDirectoryEntriesFit({ entries }: {
  entries: readonly DirectoryLeafEntry[];
}): boolean {
  const encodedBytes = entries.reduce(
    (total, entry) => total + encodedDirectoryLeafEntryByteLength({ entry }),
    0,
  );
  return encodedBytes <= HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineDirectoryEncodedBytes;
}

export async function promoteInlineDirectoryParent({
  candidateParent,
  pageStore,
}: {
  candidateParent: InlineDirectoryCandidateParent;
  pageStore: DirectoryPageTreePageStore;
}): Promise<DirectoryInodeEntry> {
  // The candidate is at most one entry beyond the 4 KiB inline bound, so the
  // complete promotion set fits in a single 64 KiB Directory Page root. The
  // root remains private until the replacement parent publishes in the Commit.
  const directoryTreeRootHomeRef = await pageStore.writePage({
    isRoot: true,
    page: {
      entries: [...candidateParent.content.entries],
      level: 0,
      type: "leaf",
    },
  });
  const updatedParent: DirectoryInodeEntry = {
    ...candidateParent,
    content: { directoryTreeRootHomeRef, type: "tree" },
  };

  // Directory Page records are immutable and remain unreachable until the
  // replacement parent is published in one Commit.
  assertInodeLeafEntryFitsMetadataPage({ entry: updatedParent });
  return updatedParent;
}

export async function prepareInlineDirectoryPromotionCreateMutation({ candidateParent, pageStore, plan }: {
  candidateParent: InlineDirectoryCandidateParent;
  pageStore: DirectoryPageTreePageStore;
  plan: OrdinaryEntryCreatePlan;
}): Promise<InlineDirectoryPromotionCreateMutation> {
  const updatedParent = await promoteInlineDirectoryParent({ candidateParent, pageStore });
  return {
    changes: [
      { entry: updatedParent, type: "set" },
      { entry: plan.inode, type: "set" },
    ],
    updatedParent,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
