import { createChangeGroups, createDiffOperations } from '@/features/wesh/commands/git/diff/algorithm';
import type { GitFiles } from './files';
import type { GitIndexEntry } from './index-file';
import type { GitTreeMergeConflict } from './merge-tree';
import { readObject, writeObject } from './objects';
import type { GitRepository } from './repository';

interface TextChange {
  start: number,
  end: number,
  replacement: string[],
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

function splitLines({ text }: { text: string }): string[] | undefined {
  if (text.length === 0) return [];
  if (!text.endsWith('\n')) return undefined;
  return text.match(/[^\n]*\n/gu) ?? [];
}

function createChanges({ baseLines, sideLines }: { baseLines: readonly string[], sideLines: readonly string[] }): TextChange[] {
  const operations = createDiffOperations({
    leftLength: baseLines.length,
    rightLength: sideLines.length,
    areEqual: ({ leftIndex, rightIndex }) => baseLines[leftIndex] === sideLines[rightIndex],
  });
  return createChangeGroups({ operations }).map(group => ({
    start: group.leftStart,
    end: group.leftStart + group.leftCount,
    replacement: sideLines.slice(group.rightStart, group.rightStart + group.rightCount),
  }));
}

function changesConflict({ left, right }: { left: TextChange, right: TextChange }): boolean {
  if (left.start === left.end && right.start === right.end) return left.start === right.start;
  if (left.start === left.end) return left.start >= right.start && left.start <= right.end;
  if (right.start === right.end) return right.start >= left.start && right.start <= left.end;
  return left.start < right.end && right.start < left.end;
}

function sameChange({ left, right }: { left: TextChange, right: TextChange }): boolean {
  return left.start === right.start
    && left.end === right.end
    && left.replacement.length === right.replacement.length
    && left.replacement.every((line, index) => line === right.replacement[index]);
}

function mergeChanges({ baseLines, ours, theirs }: {
  baseLines: readonly string[],
  ours: readonly TextChange[],
  theirs: readonly TextChange[],
}): string[] | undefined {
  for (const oursChange of ours) {
    for (const theirsChange of theirs) {
      if (changesConflict({ left: oursChange, right: theirsChange }) && !sameChange({ left: oursChange, right: theirsChange })) {
        return undefined;
      }
    }
  }
  const changes = [...ours];
  for (const theirsChange of theirs) {
    if (!changes.some(oursChange => sameChange({ left: oursChange, right: theirsChange }))) changes.push(theirsChange);
  }
  changes.sort((left, right) => left.start - right.start || left.end - right.end);
  const result: string[] = [];
  let cursor = 0;
  for (const change of changes) {
    if (change.start < cursor) return undefined;
    result.push(...baseLines.slice(cursor, change.start), ...change.replacement);
    cursor = change.end;
  }
  result.push(...baseLines.slice(cursor));
  return result;
}

async function readBlobLines({ files, repository, entry }: {
  files: GitFiles,
  repository: GitRepository,
  entry: GitIndexEntry,
}): Promise<string[] | undefined> {
  if (entry.mode !== 0o100644 && entry.mode !== 0o100755) return undefined;
  const object = await readObject({ files, repository, objectId: entry.objectId });
  if (object.type !== 'blob' || object.body.includes(0)) return undefined;
  try {
    return splitLines({ text: decoder.decode(object.body) });
  } catch {
    return undefined;
  }
}

export function createLocalizedConflictText({ baseText, oursText, theirsText, oursLabel, theirsLabel }: {
  baseText: string,
  oursText: string,
  theirsText: string,
  oursLabel: string,
  theirsLabel: string,
}): string | undefined {
  const baseLines = splitLines({ text: baseText });
  const oursLines = splitLines({ text: oursText });
  const theirsLines = splitLines({ text: theirsText });
  if (baseLines === undefined || oursLines === undefined || theirsLines === undefined) return undefined;
  const oursChanges = createChanges({ baseLines, sideLines: oursLines });
  const theirsChanges = createChanges({ baseLines, sideLines: theirsLines });
  if (oursChanges.length === 0 || oursChanges.length !== theirsChanges.length) return undefined;

  const result: string[] = [];
  let cursor = 0;
  let conflictCount = 0;
  for (let index = 0; index < oursChanges.length; index += 1) {
    const oursChange = oursChanges[index]!;
    const theirsChange = theirsChanges[index]!;
    if (oursChange.start !== theirsChange.start || oursChange.end !== theirsChange.end
      || oursChange.start < cursor) return undefined;
    result.push(...baseLines.slice(cursor, oursChange.start));
    if (sameChange({ left: oursChange, right: theirsChange })) {
      result.push(...oursChange.replacement);
    } else {
      conflictCount += 1;
      result.push(
        `<<<<<<< ${oursLabel}\n`,
        ...oursChange.replacement,
        '=======\n',
        ...theirsChange.replacement,
        `>>>>>>> ${theirsLabel}\n`,
      );
    }
    cursor = oursChange.end;
  }
  if (conflictCount === 0) return undefined;
  result.push(...baseLines.slice(cursor));
  return result.join('');
}

export async function autoMergeTextConflicts({ files, repository, conflicts }: {
  files: GitFiles,
  repository: GitRepository,
  conflicts: readonly GitTreeMergeConflict[],
}): Promise<{ entries: GitIndexEntry[], conflicts: GitTreeMergeConflict[] }> {
  const entries: GitIndexEntry[] = [];
  const remaining: GitTreeMergeConflict[] = [];
  for (const conflict of conflicts) {
    if (conflict.base === undefined || conflict.ours === undefined || conflict.theirs === undefined
      || conflict.base.mode !== conflict.ours.mode || conflict.base.mode !== conflict.theirs.mode) {
      remaining.push(conflict);
      continue;
    }
    const baseLines = await readBlobLines({ files, repository, entry: conflict.base });
    const oursLines = await readBlobLines({ files, repository, entry: conflict.ours });
    const theirsLines = await readBlobLines({ files, repository, entry: conflict.theirs });
    if (baseLines === undefined || oursLines === undefined || theirsLines === undefined) {
      remaining.push(conflict);
      continue;
    }
    const mergedLines = mergeChanges({
      baseLines,
      ours: createChanges({ baseLines, sideLines: oursLines }),
      theirs: createChanges({ baseLines, sideLines: theirsLines }),
    });
    if (mergedLines === undefined) {
      remaining.push(conflict);
      continue;
    }
    const body = encoder.encode(mergedLines.join(''));
    entries.push({
      path: conflict.path,
      objectId: await writeObject({ files, repository, type: 'blob', body }),
      mode: conflict.ours.mode,
      size: body.byteLength,
      stage: 0,
    });
  }
  return { entries, conflicts: remaining };
}

export const TEST_ONLY = {
  changesConflict,
  createChanges,
  mergeChanges,
  sameChange,
  createLocalizedConflictText,
  splitLines,
};
