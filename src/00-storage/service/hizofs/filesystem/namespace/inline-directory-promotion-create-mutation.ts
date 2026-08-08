import {
  assertInodeLeafEntryFitsMetadataPage,
  type DirectoryInodeEntry,
} from "@/00-storage/service/hizofs/00-format";
import type { DirectoryPageTreePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import type { RootInodeTableMutation } from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import type { InlineDirectoryCreateCandidateParent } from "@/00-storage/service/hizofs/filesystem/namespace/inline-directory-create-mutation";
import type { OrdinaryEntryCreatePlan } from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-create-plan";

export type InlineDirectoryPromotionCreateMutation = Readonly<{
  changes: readonly RootInodeTableMutation[];
  updatedParent: DirectoryInodeEntry;
}>;

export async function prepareInlineDirectoryPromotionCreateMutation({
  candidateParent,
  pageStore,
  plan,
}: {
  candidateParent: InlineDirectoryCreateCandidateParent;
  pageStore: DirectoryPageTreePageStore;
  plan: OrdinaryEntryCreatePlan;
}): Promise<InlineDirectoryPromotionCreateMutation> {
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
  // replacement parent and its new child inode publish in one Commit.
  assertInodeLeafEntryFitsMetadataPage({ entry: updatedParent });

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
