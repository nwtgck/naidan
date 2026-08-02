import {
  compareUnsignedBytes,
  createInodeRevision,
  encodeDirectoryEntry,
  encodeFilenameComponent,
  encodeInodeLeafPage,
  HIZOFS_V1_FORMAT_CONSTANTS,
  UINT64_MAXIMUM,
  type DirectoryInodeEntry,
  type DirectoryLeafEntry,
} from "@/00-storage/service/hizofs/00-format";
import type { RootInodeTableMutation } from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import type { OrdinaryEntryCreatePlan } from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-create-plan";

export type InlineDirectoryCreateMutationErrorCode =
  | "destination_exists"
  | "parent_identity_mismatch"
  | "parent_revision_exhausted"
  | "parent_tree_not_supported";

export class InlineDirectoryCreateMutationError extends Error {
  readonly code: InlineDirectoryCreateMutationErrorCode;

  constructor({ code, message }: { code: InlineDirectoryCreateMutationErrorCode; message: string }) {
    super(message);
    this.name = "InlineDirectoryCreateMutationError";
    this.code = code;
  }
}

export type InlineDirectoryCreateCandidateParent = Readonly<
  Omit<DirectoryInodeEntry, "content"> & {
    content: Extract<DirectoryInodeEntry["content"], { type: "inline" }>;
  }
>;

export type InlineDirectoryCreateMutation = Readonly<{
  changes: readonly RootInodeTableMutation[];
  updatedParent: DirectoryInodeEntry;
}>;

function compareDirectoryEntries({ left, right }: {
  left: DirectoryLeafEntry;
  right: DirectoryLeafEntry;
}): number {
  return compareUnsignedBytes({
    left: encodeFilenameComponent({ value: left.name }),
    right: encodeFilenameComponent({ value: right.name }),
  });
}

export function prepareInlineDirectoryCreateCandidateParent({
  parent,
  plan,
}: {
  parent: DirectoryInodeEntry;
  plan: OrdinaryEntryCreatePlan;
}): InlineDirectoryCreateCandidateParent {
  if (parent.inodeNumber !== plan.parentDirectoryInodeNumber) {
    throw new InlineDirectoryCreateMutationError({
      code: "parent_identity_mismatch",
      message: "inline directory create plan does not target the captured parent inode",
    });
  }
  if (parent.inodeRevision === UINT64_MAXIMUM) {
    throw new InlineDirectoryCreateMutationError({
      code: "parent_revision_exhausted",
      message: "inline directory parent revision is exhausted",
    });
  }
  const currentEntries = (() => {
    switch (parent.content.type) {
    case "inline": return parent.content.entries;
    case "tree":
      throw new InlineDirectoryCreateMutationError({
        code: "parent_tree_not_supported",
        message: "tree-backed directory creation requires the directory-page mutation executor",
      });
    default: {
      const exhaustive: never = parent.content;
      throw new Error(`Unhandled directory content: ${((exhaustive satisfies never) as { readonly type: string }).type}`);
    }
    }
  })();
  if (currentEntries.some(entry => entry.name === plan.directoryEntry.name)) {
    throw new InlineDirectoryCreateMutationError({
      code: "destination_exists",
      message: "inline directory destination changed after creation planning",
    });
  }

  const entries = [...currentEntries, plan.directoryEntry].sort((left, right) =>
    compareDirectoryEntries({ left, right })
  );
  return {
    ...parent,
    content: { entries, type: "inline" },
    inodeRevision: createInodeRevision({ value: parent.inodeRevision + 1n }),
    timestamps: {
      ...parent.timestamps,
      modifiedAt: plan.inode.timestamps.modifiedAt,
    },
  };
}

export function inlineDirectoryCreateCandidateFits({ candidateParent }: {
  candidateParent: InlineDirectoryCreateCandidateParent;
}): boolean {
  const encodedBytes = candidateParent.content.entries.reduce(
    (total, entry) => total + encodeDirectoryEntry({ entry }).byteLength,
    0,
  );
  return encodedBytes <= HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineDirectoryEncodedBytes;
}

export function prepareInlineDirectoryCreateMutationFromCandidate({
  candidateParent,
  plan,
}: {
  candidateParent: InlineDirectoryCreateCandidateParent;
  plan: OrdinaryEntryCreatePlan;
}): InlineDirectoryCreateMutation {
  // The authoritative inode codec enforces the inline-directory byte bound and
  // canonical UTF-8 entry ordering before any page mutation is prepared.
  encodeInodeLeafPage({ entries: [candidateParent], isRoot: false });

  return {
    changes: [
      { entry: candidateParent, type: "set" },
      { entry: plan.inode, type: "set" },
    ],
    updatedParent: candidateParent,
  };
}

export function prepareInlineDirectoryCreateMutation({
  parent,
  plan,
}: {
  parent: DirectoryInodeEntry;
  plan: OrdinaryEntryCreatePlan;
}): InlineDirectoryCreateMutation {
  return prepareInlineDirectoryCreateMutationFromCandidate({
    candidateParent: prepareInlineDirectoryCreateCandidateParent({ parent, plan }),
    plan,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
