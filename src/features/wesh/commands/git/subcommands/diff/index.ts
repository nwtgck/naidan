import { createDiffOperations } from "@/features/wesh/commands/git/diff/algorithm";
import { createDiffInput, createLineComparator, getLineBytes } from "@/features/wesh/commands/git/diff/input";
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { cleanWorktreeBytes, loadWorktreeAttributes } from "@/features/wesh/commands/git/attributes";
import { getDiffRenamesConfigMode, readEffectiveConfig, readWorktreeContentConfig } from "@/features/wesh/commands/git/config";
import type { GitIndexEntry } from "@/features/wesh/commands/git/index-file";
import { readIndex } from "@/features/wesh/commands/git/index-file";
import { objectIdFor, readObject } from "@/features/wesh/commands/git/objects";
import type { GitRepository } from "@/features/wesh/commands/git/repository";
import { assertRepositoryHasUsableWorktree, repositoryHasWorktree, discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { pathExists } from "@/features/wesh/commands/git/files";
import { matchRepositoryPaths } from "@/features/wesh/commands/git/pathspec";
import { quoteGitPath, quoteNonAsciiFromConfig } from "@/features/wesh/commands/git/path-output";
import { compareGitPaths, sortGitPaths } from "@/features/wesh/commands/git/path-order";
import { readWorktreeContent, worktreeAbsolutePath } from "@/features/wesh/commands/git/worktree";
import { writeTwoParentCombinedDiff } from "./combined";
import { parseDiffArguments } from './arguments';
import type { GitExactRenameMatch } from "@/features/wesh/commands/git/renames";
import type { GitDiffSnapshot } from "@/features/wesh/commands/git/diff/revision";
import { changedPaths, defaultComparisonOptions, exactRenamesForPaths, gitlinkDiffBytes, snapshotFromTree, writeDiffStat, writeExactRenamePatch, writePatchEntry } from "@/features/wesh/commands/git/diff/revision";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";

function indexRegularMode({ entry }: { entry: GitIndexEntry }): 0o100644 | 0o100755 | undefined {
  switch (entry.mode) {
  case 0o100644:
  case 0o100755:
    return entry.mode;
  case 0o120000:
  case 0o160000:
    return undefined;
  default:
    throw new Error(`unsupported index mode ${entry.mode.toString(8)}: ${entry.path}`);
  }
}
async function snapshotFromIndex({ context, repository, entries }: {
  context: WeshCommandContext,
  repository: GitRepository,
  entries: readonly GitIndexEntry[],
}): Promise<GitDiffSnapshot> {
  const result: GitDiffSnapshot = new Map();
  for (const entry of entries) {
    if (entry.stage !== 0) throw new Error(`unmerged index entry is not supported yet: ${entry.path}`);
    if (entry.mode === 0o160000) {
      result.set(entry.path, {
        path: entry.path,
        mode: entry.mode,
        objectId: entry.objectId,
        bytes: gitlinkDiffBytes({ objectId: entry.objectId }),
      });
      continue;
    }
    const object = await readObject({ files: context.files, repository, objectId: entry.objectId });
    switch (object.type) {
    case 'blob':
      result.set(entry.path, {
        path: entry.path,
        mode: entry.mode,
        objectId: entry.objectId,
        bytes: object.body,
      });
      break;
    case 'tree':
    case 'commit':
    case 'tag':
      throw new Error(`index entry ${entry.path} does not reference a blob`);
    default: {
      const _ex: never = object.type;
      throw new Error(`Unhandled index object type: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return result;
}
async function writeUnmergedCombinedDiff({ context, repository, path, entries, quoteNonAscii }: {
  context: WeshCommandContext,
  repository: GitRepository,
  path: string,
  entries: readonly GitIndexEntry[],
  quoteNonAscii: boolean,
}): Promise<void> {
  const pathEntries = entries.filter(entry => entry.path === path);
  const firstParent = pathEntries.find(entry => entry.stage === 2);
  const secondParent = pathEntries.find(entry => entry.stage === 3);
  if (firstParent === undefined || secondParent === undefined) {
    await context.text().print({ text: `* Unmerged path ${path}\n` });
    return;
  }
  if ((firstParent.mode !== 0o100644 && firstParent.mode !== 0o100755) || secondParent.mode !== firstParent.mode) {
    throw new Error(`combined diff mode is not supported yet: ${path}`);
  }
  const firstObject = await readObject({ files: context.files, repository, objectId: firstParent.objectId });
  const secondObject = await readObject({ files: context.files, repository, objectId: secondParent.objectId });
  if (firstObject.type !== 'blob' || secondObject.type !== 'blob') {
    throw new Error(`combined diff index entry does not reference a blob: ${path}`);
  }
  const absolutePath = worktreeAbsolutePath({ repository, path });
  if (!await pathExists({ files: context.files, path: absolutePath })) {
    throw new Error(`combined diff worktree path is missing: ${path}`);
  }
  const stat = await context.files.lstat({ path: absolutePath });
  const content = await readWorktreeContent({
    files: context.files,
    absolutePath,
    type: stat.type,
    regularFileMode: firstParent.mode,
  });
  if (content.mode !== firstParent.mode) throw new Error(`combined diff mode change is not supported yet: ${path}`);
  const attributes = await loadWorktreeAttributes({ files: context.files, repository, contentConfig: await readWorktreeContentConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env }) });
  const resultBytes = attributes.clean({ path, bytes: content.bytes, indexBytes: firstObject.body });
  await writeTwoParentCombinedDiff({
    handle: context.stdout,
    path,
    firstParent: { objectId: firstParent.objectId, bytes: firstObject.body },
    secondParent: { objectId: secondParent.objectId, bytes: secondObject.body },
    resultBytes,
    quoteNonAscii,
  });
}
async function snapshotWorktreeForIndex({ context, repository, entries }: {
  context: WeshCommandContext,
  repository: GitRepository,
  entries: readonly GitIndexEntry[],
}): Promise<GitDiffSnapshot> {
  const result: GitDiffSnapshot = new Map();
  const attributes = await loadWorktreeAttributes({ files: context.files, repository, contentConfig: await readWorktreeContentConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env }) });
  for (const entry of entries) {
    if (entry.stage !== 0) throw new Error(`unmerged index entry is not supported yet: ${entry.path}`);
    if (entry.mode === 0o160000) {
      result.set(entry.path, { path: entry.path, mode: entry.mode, objectId: entry.objectId, bytes: new Uint8Array() });
      continue;
    }
    const absolutePath = worktreeAbsolutePath({ repository, path: entry.path });
    if (!await pathExists({ files: context.files, path: absolutePath })) continue;
    const stat = await context.files.lstat({ path: absolutePath });
    const content = await readWorktreeContent({
      files: context.files,
      absolutePath,
      type: stat.type,
      regularFileMode: indexRegularMode({ entry }),
    });
    const bytes = content.mode === 0o100644 || content.mode === 0o100755
      ? await cleanWorktreeBytes({ attributes, files: context.files, repository, path: entry.path, bytes: content.bytes, indexObjectId: entry.objectId })
      : content.bytes;
    const objectId = objectIdFor({ type: 'blob', body: bytes });
    result.set(entry.path, { path: entry.path, mode: content.mode, objectId, bytes });
  }
  return result;
}
function hasTrailingWhitespace({ bytes }: { bytes: Uint8Array }): boolean {
  if (bytes.byteLength === 0) return false;
  const last = bytes[bytes.byteLength - 1];
  return last === 0x20 || last === 0x09;
}
function isConflictMarkerLine({ text }: { text: string }): boolean {
  return text === '<<<<<<<' || text.startsWith('<<<<<<< ')
    || text === '|||||||' || text.startsWith('||||||| ')
    || text === '======='
    || text === '>>>>>>>' || text.startsWith('>>>>>>> ');
}
async function checkWhitespaceErrors({ context, paths, left, right }: {
  context: WeshCommandContext,
  paths: readonly string[],
  left: GitDiffSnapshot,
  right: GitDiffSnapshot,
}): Promise<boolean> {
  let found = false;
  const decoder = new TextDecoder();
  const comparisonOptions = defaultComparisonOptions();
  for (const path of paths) {
    const leftInput = createDiffInput({
      displayName: `a/${path}`,
      resolvedPath: undefined,
      mtime: undefined,
      bytes: left.get(path)?.bytes ?? new Uint8Array(),
    });
    const rightInput = createDiffInput({
      displayName: `b/${path}`,
      resolvedPath: undefined,
      mtime: undefined,
      bytes: right.get(path)?.bytes ?? new Uint8Array(),
    });
    const operations = createDiffOperations({
      leftLength: leftInput.lines.starts.length,
      rightLength: rightInput.lines.starts.length,
      areEqual: createLineComparator({ left: leftInput, right: rightInput, options: comparisonOptions }),
      preferSpeedOverCompatibility: false,
    });
    for (const operation of operations) {
      switch (operation.kind) {
      case 'equal':
      case 'delete':
        break;
      case 'insert':
        for (let offset = 0; offset < operation.length; offset += 1) {
          const lineIndex = operation.rightStart + offset;
          const bytes = getLineBytes({ input: rightInput, lineIndex, stripTrailingCarriageReturn: false });
          const text = decoder.decode(bytes);
          if (isConflictMarkerLine({ text })) {
            found = true;
            await context.text().print({ text: `${path}:${lineIndex + 1}: leftover conflict marker\n` });
          }
          if (hasTrailingWhitespace({ bytes })) {
            found = true;
            await context.text().print({
              text: `${path}:${lineIndex + 1}: trailing whitespace.\n+${text}\n`,
            });
          }
        }
        break;
      default: {
        const _ex: never = operation;
        throw new Error(`Unhandled diff operation: ${JSON.stringify(_ex)}`);
      }
      }
    }
  }
  return found;
}
export async function runDiff({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context });
  const {
    cached,
    nameOnly,
    nameStatus,
    stat,
    check,
    quiet,
    exitCode,
    nul,
    revisions,
    pathOperands,
  } = parseDiffArguments({ args });
  if ((nameOnly && nameStatus) || (check && (nameOnly || nameStatus)))
    throw new Error("options '--name-only', '--name-status', '--check', and '-s' cannot be used together");

  const repository = await discoverRepositoryFromContext({ context });
  if (!repositoryHasWorktree({ repository }) && !cached && revisions.length < 2) {
    assertRepositoryHasUsableWorktree({ context, repository });
  }
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env });
  const quoteNonAscii = quoteNonAsciiFromConfig({ config });
  const detectRenames = getDiffRenamesConfigMode({ config }) !== 'disabled';
  const indexEntries = await readIndex({ files: context.files, repository });
  const stageZeroEntries = indexEntries.filter(entry => entry.stage === 0);
  const unmergedIndexPaths = sortGitPaths({ paths: new Set(indexEntries.filter(entry => entry.stage !== 0).map(entry => entry.path)) });
  const defaultUnmergedSummary = !cached && revisions.length === 0 && unmergedIndexPaths.length > 0
    && (nameOnly || nameStatus || quiet || stat || check);
  const combinedUnmergedPatch = !cached && revisions.length === 0 && unmergedIndexPaths.length > 0
    && !nameOnly && !nameStatus && !quiet && !stat && !check;
  if (!cached && revisions.length < 2 && unmergedIndexPaths.length > 0
    && !defaultUnmergedSummary && !combinedUnmergedPatch) {
    throw new Error('combined diff for this unmerged comparison is not supported yet');
  }
  let left: GitDiffSnapshot;
  let right: GitDiffSnapshot;
  if (cached) {
    left = await snapshotFromTree({ context, repository, revision: revisions[0] ?? 'HEAD' });
    right = await snapshotFromIndex({ context, repository, entries: stageZeroEntries });
  } else if (revisions.length === 0) {
    const worktreeComparisonEntries = defaultUnmergedSummary
      ? [
        ...stageZeroEntries,
        ...indexEntries.filter(entry => entry.stage === 2).map(entry => ({ ...entry, stage: 0 as const })),
      ]
      : combinedUnmergedPatch
        ? stageZeroEntries
        : indexEntries;
    left = await snapshotFromIndex({ context, repository, entries: worktreeComparisonEntries });
    right = await snapshotWorktreeForIndex({ context, repository, entries: worktreeComparisonEntries });
  } else if (revisions.length === 1) {
    left = await snapshotFromTree({ context, repository, revision: revisions[0]! });
    right = await snapshotWorktreeForIndex({ context, repository, entries: indexEntries });
    for (const [path, entry] of await snapshotFromIndex({ context, repository, entries: indexEntries })) {
      if (!right.has(path) && !left.has(path)) right.set(path, entry);
    }
  } else {
    left = await snapshotFromTree({ context, repository, revision: revisions[0]! });
    right = await snapshotFromTree({ context, repository, revision: revisions[1]! });
  }

  let unmergedPaths = cached || defaultUnmergedSummary || combinedUnmergedPatch ? unmergedIndexPaths : [];
  let paths = changedPaths({ left, right });
  if (cached) paths = paths.filter(path => !unmergedPaths.includes(path));
  if (pathOperands.length > 0) {
    const matches = matchRepositoryPaths({
      repository,
      cwd: context.cwd,
      operands: pathOperands,
      availablePaths: new Set([...left.keys(), ...right.keys(), ...unmergedPaths]),
    });
    const selected = new Set([...matches.values()].flat());
    paths = paths.filter(path => selected.has(path));
    unmergedPaths = unmergedPaths.filter(path => selected.has(path));
  }
  const exactRenames = detectRenames ? exactRenamesForPaths({ paths, left, right }) : [];
  const exactRenameSources = new Set(exactRenames.map(rename => rename.sourcePath));
  const exactRenameDestinations = new Set(exactRenames.map(rename => rename.destinationPath));
  const hasDifferences = paths.length > 0 || unmergedPaths.length > 0;
  const differenceExitCode = exitCode && hasDifferences ? 1 : 0;
  if (quiet) return { exitCode: hasDifferences ? 1 : 0 };
  if (check) {
    const hasErrors = await checkWhitespaceErrors({ context, paths, left, right });
    return { exitCode: (hasErrors ? 2 : 0) | differenceExitCode };
  }
  if (stat && !nameOnly && !nameStatus) {
    await writeDiffStat({ context, paths, left, right, quoteNonAscii, detectRenames, unmergedPaths });
    return { exitCode: differenceExitCode };
  }
  if (nameOnly) {
    const separator = nul ? '\0' : '\n';
    const renderPath = ({ path }: { path: string }): string => (
      nul ? path : quoteGitPath({ path, quoteNonAscii, quoteSpaces: false })
    );
    if (defaultUnmergedSummary) {
      const rows = [
        ...unmergedPaths.map(path => ({ path, order: 0 })),
        ...paths.map(path => ({ path, order: 1 })),
      ].sort((leftRow, rightRow) => compareGitPaths({ left: leftRow.path, right: rightRow.path }) || leftRow.order - rightRow.order);
      await context.text().print({ text: rows.map(row => `${renderPath({ path: row.path })}${separator}`).join('') });
    } else {
      const outputPaths = sortGitPaths({
        paths: new Set([
          ...paths.filter(path => !exactRenameSources.has(path) && !exactRenameDestinations.has(path)),
          ...exactRenames.map(rename => rename.destinationPath),
          ...unmergedPaths,
        ]),
      });
      await context.text().print({ text: outputPaths.map(path => `${renderPath({ path })}${separator}`).join('') });
    }
    return { exitCode: differenceExitCode };
  }
  if (nameStatus) {
    const normal = new Map(paths.map(path => {
      const a = left.get(path);
      const b = right.get(path);
      const status = a === undefined ? 'A' : b === undefined ? 'D' : 'M';
      return [path, status] as const;
    }));
    const renderRow = ({ status, path }: { status: string, path: string }): string => {
      if (nul) return `${status}\0${path}\0`;
      return `${status}\t${quoteGitPath({ path, quoteNonAscii, quoteSpaces: false })}\n`;
    };
    const renderRenameRow = ({ rename }: { rename: GitExactRenameMatch }): string => {
      if (nul) return `R100\0${rename.sourcePath}\0${rename.destinationPath}\0`;
      const source = quoteGitPath({ path: rename.sourcePath, quoteNonAscii, quoteSpaces: false });
      const destination = quoteGitPath({ path: rename.destinationPath, quoteNonAscii, quoteSpaces: false });
      return `R100\t${source}\t${destination}\n`;
    };
    if (defaultUnmergedSummary) {
      const rows = [
        ...unmergedPaths.map(path => ({ path, status: 'U', order: 0 })),
        ...paths.map(path => ({ path, status: normal.get(path)!, order: 1 })),
      ].sort((leftRow, rightRow) => compareGitPaths({ left: leftRow.path, right: rightRow.path }) || leftRow.order - rightRow.order);
      await context.text().print({ text: rows.map(row => renderRow({ status: row.status, path: row.path })).join('') });
    } else {
      const unmerged = new Set(unmergedPaths);
      const rows = [
        ...paths
          .filter(path => !exactRenameSources.has(path) && !exactRenameDestinations.has(path))
          .map(path => ({ kind: 'normal' as const, sortPath: path, path })),
        ...unmergedPaths.map(path => ({ kind: 'normal' as const, sortPath: path, path })),
        ...exactRenames.map(rename => ({ kind: 'rename' as const, sortPath: rename.sourcePath, rename })),
      ].sort((leftRow, rightRow) => compareGitPaths({ left: leftRow.sortPath, right: rightRow.sortPath }));
      await context.text().print({
        text: rows.map(row => {
          switch (row.kind) {
          case 'normal':
            return renderRow({ status: unmerged.has(row.path) ? 'U' : normal.get(row.path)!, path: row.path });
          case 'rename':
            return renderRenameRow({ rename: row.rename });
          default: {
            const _ex: never = row;
            throw new Error(`Unhandled diff name-status row: ${JSON.stringify(_ex)}`);
          }
          }
        }).join(''),
      });
    }
    return { exitCode: differenceExitCode };
  }
  const outputRows = [
    ...paths
      .filter(path => !exactRenameSources.has(path) && !exactRenameDestinations.has(path))
      .map(path => ({ kind: 'path' as const, sortPath: path, path })),
    ...unmergedPaths.map(path => ({ kind: 'path' as const, sortPath: path, path })),
    ...exactRenames.map(rename => ({ kind: 'rename' as const, sortPath: rename.sourcePath, rename })),
  ].sort((leftRow, rightRow) => compareGitPaths({ left: leftRow.sortPath, right: rightRow.sortPath }));
  for (const row of outputRows) {
    switch (row.kind) {
    case 'path':
      if (unmergedPaths.includes(row.path)) {
        if (combinedUnmergedPatch) await writeUnmergedCombinedDiff({ context, repository, path: row.path, entries: indexEntries, quoteNonAscii });
        else await context.text().print({ text: `* Unmerged path ${row.path}\n` });
      } else {
        await writePatchEntry({ context, path: row.path, left: left.get(row.path), right: right.get(row.path), quoteNonAscii });
      }
      break;
    case 'rename':
      await writeExactRenamePatch({ context, rename: row.rename, quoteNonAscii });
      break;
    default: {
      const _ex: never = row;
      throw new Error(`Unhandled diff output row: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return { exitCode: differenceExitCode };
}

export const TEST_ONLY = {
};
