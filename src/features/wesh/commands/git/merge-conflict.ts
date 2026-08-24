import { loadWorktreeAttributes } from './attributes';
import type { GitWorktreeContentConfig } from './config';
import type { GitFiles } from './files';
import { writeFileBytes } from './files';
import type { GitIndexEntry } from './index-file';
import type { GitTreeMergeConflict } from './merge-tree';
import { readObject } from './objects';
import type { GitRepository } from './repository';
import { worktreeAbsolutePath } from './worktree';
import { createLocalizedConflictText } from './text-merge';

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

export type GitMergeConflictKind = 'content' | 'add/add' | 'modify/delete';

export interface GitPreparedMergeConflict {
  path: string,
  indexEntries: GitIndexEntry[],
  worktreeBytes: Uint8Array,
  kind: GitMergeConflictKind,
  binary: boolean,
  deletedLabel: string | undefined,
  modifiedLabel: string | undefined,
}

function isRegularMode({ mode }: { mode: number }): boolean {
  return mode === 0o100644 || mode === 0o100755;
}

async function readRegularBlob({ files, repository, entry }: {
  files: GitFiles,
  repository: GitRepository,
  entry: GitIndexEntry,
}): Promise<Uint8Array> {
  if (!isRegularMode({ mode: entry.mode })) throw new Error(`unsupported merge conflict mode ${entry.mode.toString(8)}: ${entry.path}`);
  const object = await readObject({ files, repository, objectId: entry.objectId });
  switch (object.type) {
  case 'blob':
    return object.body;
  case 'tree':
  case 'commit':
  case 'tag':
    throw new Error(`merge conflict entry is not a blob: ${entry.path}`);
  default: {
    const _ex: never = object.type;
    throw new Error(`Unhandled merge conflict object type: ${_ex}`);
  }
  }
}

function decodeConflictText({ bytes }: { bytes: Uint8Array }): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

function withFinalNewline({ text }: { text: string }): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function stagedEntries({ conflict }: { conflict: GitTreeMergeConflict }): GitIndexEntry[] {
  const result: GitIndexEntry[] = [];
  if (conflict.base !== undefined) result.push({ ...conflict.base, stage: 1 });
  if (conflict.ours !== undefined) result.push({ ...conflict.ours, stage: 2 });
  if (conflict.theirs !== undefined) result.push({ ...conflict.theirs, stage: 3 });
  return result;
}

export async function prepareMergeConflicts({ files, repository, conflicts, oursLabel, theirsLabel, contentConfig }: {
  files: GitFiles,
  repository: GitRepository,
  conflicts: readonly GitTreeMergeConflict[],
  oursLabel: string,
  theirsLabel: string,
  contentConfig: GitWorktreeContentConfig,
}): Promise<GitPreparedMergeConflict[]> {
  const attributes = await loadWorktreeAttributes({ files, repository, contentConfig });
  const result: GitPreparedMergeConflict[] = [];
  for (const conflict of conflicts) {
    const indexEntries = stagedEntries({ conflict });
    if (conflict.ours === undefined || conflict.theirs === undefined) {
      const surviving = conflict.ours ?? conflict.theirs;
      if (conflict.base === undefined || surviving === undefined) {
        throw new Error(`invalid add/delete merge conflict: ${conflict.path}`);
      }
      const bytes = await readRegularBlob({ files, repository, entry: surviving });
      const oursSurvives = conflict.ours !== undefined;
      result.push({
        path: conflict.path,
        indexEntries,
        worktreeBytes: attributes.smudge({ path: conflict.path, bytes }),
        kind: 'modify/delete',
        binary: false,
        deletedLabel: oursSurvives ? theirsLabel : oursLabel,
        modifiedLabel: oursSurvives ? oursLabel : theirsLabel,
      });
      continue;
    }

    const oursBytes = await readRegularBlob({ files, repository, entry: conflict.ours });
    const theirsBytes = await readRegularBlob({ files, repository, entry: conflict.theirs });
    const baseBytes = conflict.base === undefined ? undefined : await readRegularBlob({ files, repository, entry: conflict.base });
    const oursText = decodeConflictText({ bytes: oursBytes });
    const theirsText = decodeConflictText({ bytes: theirsBytes });
    const baseText = baseBytes === undefined ? undefined : decodeConflictText({ bytes: baseBytes });
    const kind: GitMergeConflictKind = conflict.base === undefined ? 'add/add' : 'content';
    if (oursText === undefined || theirsText === undefined) {
      result.push({
        path: conflict.path,
        indexEntries,
        worktreeBytes: attributes.smudge({ path: conflict.path, bytes: oursBytes }),
        kind,
        binary: true,
        deletedLabel: undefined,
        modifiedLabel: undefined,
      });
      continue;
    }
    const localized = baseText === undefined ? undefined : createLocalizedConflictText({
      baseText,
      oursText,
      theirsText,
      oursLabel,
      theirsLabel,
    });
    const markerBytes = encoder.encode(localized
      ?? `<<<<<<< ${oursLabel}\n${withFinalNewline({ text: oursText })}=======\n${withFinalNewline({ text: theirsText })}>>>>>>> ${theirsLabel}\n`);
    result.push({
      path: conflict.path,
      indexEntries,
      worktreeBytes: attributes.smudge({ path: conflict.path, bytes: markerBytes }),
      kind,
      binary: false,
      deletedLabel: undefined,
      modifiedLabel: undefined,
    });
  }
  return result;
}


export function formatPreparedMergeConflict({ conflict, oursLabel, theirsLabel }: {
  conflict: GitPreparedMergeConflict,
  oursLabel: string,
  theirsLabel: string,
}): string[] {
  const lines: string[] = [];
  if (conflict.binary) lines.push(`warning: Cannot merge binary files: ${conflict.path} (${oursLabel} vs. ${theirsLabel})\n`);
  switch (conflict.kind) {
  case 'content':
    lines.push(`Auto-merging ${conflict.path}\n`, `CONFLICT (content): Merge conflict in ${conflict.path}\n`);
    break;
  case 'add/add':
    lines.push(`Auto-merging ${conflict.path}\n`, `CONFLICT (add/add): Merge conflict in ${conflict.path}\n`);
    break;
  case 'modify/delete':
    if (conflict.deletedLabel === undefined || conflict.modifiedLabel === undefined) {
      throw new Error(`modify/delete conflict is missing labels: ${conflict.path}`);
    }
    lines.push(
      `CONFLICT (modify/delete): ${conflict.path} deleted in ${conflict.deletedLabel} and modified in ${conflict.modifiedLabel}.  Version ${conflict.modifiedLabel} of ${conflict.path} left in tree.\n`,
    );
    break;
  default: {
    const _ex: never = conflict.kind;
    throw new Error(`Unhandled merge conflict kind: ${_ex}`);
  }
  }
  return lines;
}

export async function materializePreparedMergeConflicts({ files, repository, conflicts }: {
  files: GitFiles,
  repository: GitRepository,
  conflicts: readonly GitPreparedMergeConflict[],
}): Promise<void> {
  for (const conflict of conflicts) {
    await writeFileBytes({
      files,
      path: worktreeAbsolutePath({ repository, path: conflict.path }),
      bytes: conflict.worktreeBytes,
    });
  }
}

export const TEST_ONLY = {
  decodeConflictText,
  stagedEntries,
  withFinalNewline,
};
