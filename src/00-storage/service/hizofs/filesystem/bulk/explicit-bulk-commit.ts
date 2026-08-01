import {
  createFileSystemCommitPayload,
  type FileSystemCommitPayload,
  type InodeLeafEntry,
  type InodeNumber,
  type MutationId,
} from "@/00-storage/service/hizofs/00-format";
import type { SealedExplicitBulkCandidate } from "@/00-storage/service/hizofs/filesystem/bulk/explicit-bulk-candidate";
import {
  StreamingDirectoryImport,
  type StreamingDirectoryImportLimits,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-directory-import";
import type { DirectoryPageTreePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import {
  prepareRootInodeTableMutation,
  type RootInodeTableMutation,
  type RootInodeTablePageStore,
} from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";

export type ExplicitBulkCommitPreparationErrorCode =
  | "allocator_regression"
  | "candidate_inode_out_of_range"
  | "duplicate_inode"
  | "missing_target_directory"
  | "target_directory_not_preexisting"
  | "unchanged_candidate";

export class ExplicitBulkCommitPreparationError extends Error {
  readonly code: ExplicitBulkCommitPreparationErrorCode;

  constructor({ code, message }: { code: ExplicitBulkCommitPreparationErrorCode; message: string }) {
    super(message);
    this.code = code;
    this.name = "ExplicitBulkCommitPreparationError";
  }
}

function compareInodeNumbers({ left, right }: { left: InodeNumber; right: InodeNumber }): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateAndOrderEntries({ baseCommit, candidate, directories }: {
  baseCommit: FileSystemCommitPayload;
  candidate: SealedExplicitBulkCandidate;
  directories: readonly InodeLeafEntry[];
}): readonly InodeLeafEntry[] {
  if (candidate.nextInodeNumber < baseCommit.nextInodeNumber) {
    throw new ExplicitBulkCommitPreparationError({
      code: "allocator_regression",
      message: "explicit bulk candidate cannot move the Inode Number allocator backwards",
    });
  }
  if (candidate.targetDirectoryInodeNumber >= baseCommit.nextInodeNumber) {
    throw new ExplicitBulkCommitPreparationError({
      code: "target_directory_not_preexisting",
      message: "explicit bulk target directory must predate the private candidate allocator range",
    });
  }

  const entries = [...directories, ...candidate.files, ...candidate.symlinks]
    .sort((left, right) => compareInodeNumbers({ left: left.inodeNumber, right: right.inodeNumber }));
  const seen = new Set<InodeNumber>();
  let foundTarget = false;
  for (const entry of entries) {
    if (seen.has(entry.inodeNumber)) {
      throw new ExplicitBulkCommitPreparationError({
        code: "duplicate_inode",
        message: "explicit bulk candidate contains a duplicate Inode Number",
      });
    }
    seen.add(entry.inodeNumber);
    if (entry.inodeNumber === candidate.targetDirectoryInodeNumber) {
      switch (entry.inodeKind) {
      case "directory": foundTarget = true; break;
      case "file":
      case "symlink": throw new ExplicitBulkCommitPreparationError({
        code: "missing_target_directory",
        message: "explicit bulk target identity must resolve to a candidate directory",
      });
      default: entry satisfies never;
      }
      continue;
    }
    if (entry.inodeNumber < baseCommit.nextInodeNumber || entry.inodeNumber >= candidate.nextInodeNumber) {
      throw new ExplicitBulkCommitPreparationError({
        code: "candidate_inode_out_of_range",
        message: "explicit bulk-created Inode Number is outside the candidate allocator range",
      });
    }
  }
  if (!foundTarget) {
    throw new ExplicitBulkCommitPreparationError({
      code: "missing_target_directory",
      message: "explicit bulk candidate omitted its target directory Inode",
    });
  }
  return entries;
}

/**
 * Materializes one private explicit-bulk candidate into canonical private
 * Directory Page and Inode Table records without crossing a publication gate.
 * The caller may publish only the returned Commit payload, so no partially
 * prepared namespace can become authoritative.
 */
export async function prepareExplicitBulkCommit({
  baseCommit,
  candidate,
  directoryImportLimits,
  directoryPageStore,
  inodeTablePageStore,
  mutationId,
}: {
  baseCommit: FileSystemCommitPayload;
  candidate: SealedExplicitBulkCandidate;
  directoryImportLimits: StreamingDirectoryImportLimits;
  directoryPageStore: DirectoryPageTreePageStore;
  inodeTablePageStore: RootInodeTablePageStore;
  mutationId: MutationId;
}): Promise<FileSystemCommitPayload> {
  const directories: InodeLeafEntry[] = [];
  for (const directory of candidate.directories) {
    const importer = new StreamingDirectoryImport({
      inodeNumber: directory.inodeNumber,
      inodeRevision: directory.inodeRevision,
      limits: directoryImportLimits,
      pageStore: directoryPageStore,
      timestamps: directory.timestamps,
    });
    for (const entry of directory.entries) await importer.addEntry({ entry });
    directories.push(await importer.finalize());
  }

  const entries = validateAndOrderEntries({ baseCommit, candidate, directories });
  const changes: RootInodeTableMutation[] = entries.map(entry => ({ entry, type: "set" }));
  const prepared = await prepareRootInodeTableMutation({
    baseCommit,
    changes,
    mutationId,
    pageStore: inodeTablePageStore,
  });
  switch (prepared.type) {
  case "prepared": return createFileSystemCommitPayload({ payload: {
    ...prepared.commitPayload,
    nextInodeNumber: candidate.nextInodeNumber,
  } });
  case "unchanged": throw new ExplicitBulkCommitPreparationError({
    code: "unchanged_candidate",
    message: "explicit bulk candidate produced no Inode Table change",
  });
  default: return prepared satisfies never;
  }
}

export const TEST_ONLY = {
};
