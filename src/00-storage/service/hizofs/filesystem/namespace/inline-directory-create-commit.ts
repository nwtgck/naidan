import {
  createFileSystemCommitPayload,
  type FileSystemCommitPayload,
  type InodeNumber,
  type MutationId,
  type TimestampMilliseconds,
} from "@/00-storage/service/hizofs/00-format";
import {
  prepareRootInodeTableMutation,
  type RootInodeTablePageStore,
} from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import {
  prepareInlineDirectoryCreateMutation,
} from "@/00-storage/service/hizofs/filesystem/namespace/inline-directory-create-mutation";
import {
  prepareOrdinaryEntryCreatePlan,
  type OrdinaryEntryCreatePlan,
  type OrdinaryEntryCreateRequest,
  type OrdinaryEntryCreateTarget,
} from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-create-plan";
import type { DirectoryInodeEntry } from "@/00-storage/service/hizofs/00-format";

export type PreparedInlineDirectoryCreateCommit = Readonly<{
  commitPayload: FileSystemCommitPayload;
  plan: OrdinaryEntryCreatePlan;
}>;

export async function prepareInlineDirectoryCreateCommit({
  baseCommit,
  maximumKnownInodeNumber,
  mutationId,
  operationTimestamp,
  pageStore,
  parent,
  request,
  target,
}: Readonly<{
  baseCommit: FileSystemCommitPayload;
  maximumKnownInodeNumber: InodeNumber | undefined;
  mutationId: MutationId;
  operationTimestamp: TimestampMilliseconds;
  pageStore: RootInodeTablePageStore;
  parent: DirectoryInodeEntry;
  request: OrdinaryEntryCreateRequest;
  target: OrdinaryEntryCreateTarget;
}>): Promise<PreparedInlineDirectoryCreateCommit> {
  const plan = prepareOrdinaryEntryCreatePlan({
    maximumKnownInodeNumber,
    nextInodeNumber: baseCommit.nextInodeNumber,
    operationTimestamp,
    request,
    target,
  });
  const mutation = prepareInlineDirectoryCreateMutation({ parent, plan });
  const prepared = await prepareRootInodeTableMutation({
    baseCommit,
    changes: mutation.changes,
    mutationId,
    pageStore,
  });
  switch (prepared.type) {
  case "unchanged":
    throw new Error("inline directory creation unexpectedly produced no Inode Table change");
  case "prepared": return {
    commitPayload: createFileSystemCommitPayload({ payload: {
      ...prepared.commitPayload,
      nextInodeNumber: plan.nextInodeNumber,
    } }),
    plan,
  };
  default: {
    const exhaustive: never = prepared;
    throw new Error(`Unhandled prepared mutation: ${((exhaustive satisfies never) as { readonly type: string }).type}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
