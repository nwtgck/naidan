import { normalizePath } from '@/features/wesh/path';
import type { GitAttributesMatcher } from './attributes';
import { cleanWorktreeBytes, loadIndexAttributes } from './attributes';
import type { GitWorktreeContentConfig } from './config';
import type { WeshFileType } from '@/features/wesh/types';
import type { GitFiles } from './files';
import { pathExists, readFileBytes, writeFileBytes } from './files';
import { objectIdFor, readObject, writeObject } from './objects';
import { sortGitPaths } from './path-order';
import { assertSafeGitRepositoryPath } from './path-safety';
import type { GitIndexEntry } from './index-file';
import type { GitRepository } from './repository';
import { joinPath, relativeToWorktree } from './repository';

const textEncoder = new TextEncoder();

export interface GitWorktreeEntry {
  path: string,
  objectId: string,
  mode: number,
  size: number,
}

export async function readWorktreeContent({ files, absolutePath, type, regularFileMode }: {
  files: GitFiles,
  absolutePath: string,
  type: WeshFileType,
  regularFileMode: 0o100644 | 0o100755 | undefined,
}): Promise<{ bytes: Uint8Array, mode: number }> {
  switch (type) {
  case 'file':
    return { bytes: await readFileBytes({ files, path: absolutePath }), mode: regularFileMode ?? 0o100644 };
  case 'symlink':
    return { bytes: textEncoder.encode(await files.readlink({ path: absolutePath })), mode: 0o120000 };
  case 'directory':
    throw new Error(`cannot hash directory as blob: ${absolutePath}`);
  case 'fifo':
  case 'chardev':
    throw new Error(`unsupported worktree entry type ${type}: ${absolutePath}`);
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled worktree entry type: ${_ex}`);
  }
  }
}

export async function hashWorktreeEntry({ files, repository, path, write, regularFileMode, attributes, indexObjectId }: {
  files: GitFiles,
  repository: GitRepository,
  path: string,
  write: boolean,
  regularFileMode: 0o100644 | 0o100755 | undefined,
  attributes: GitAttributesMatcher,
  indexObjectId?: string,
}): Promise<GitWorktreeEntry> {
  const absolutePath = normalizePath({ cwd: repository.worktreePath, path });
  const stat = await files.lstat({ path: absolutePath });
  const { bytes, mode } = await readWorktreeContent({ files, absolutePath, type: stat.type, regularFileMode });
  const objectBytes = mode === 0o100644 || mode === 0o100755
    ? await cleanWorktreeBytes({ attributes, files, repository, path, bytes, indexObjectId })
    : bytes;
  const objectId = write
    ? await writeObject({ files, repository, type: 'blob', body: objectBytes })
    : objectIdFor({ type: 'blob', body: objectBytes });
  return { path, objectId, mode, size: bytes.byteLength };
}

export async function listWorktreeEntries({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<string[]> {
  const result: string[] = [];
  const visit = async ({ absoluteDirectory }: { absoluteDirectory: string }): Promise<void> => {
    for await (const entry of files.readDir({ path: absoluteDirectory })) {
      const relativePath = relativeToWorktree({ repository, absolutePath: entry.fullPath });
      if (relativePath === '.git') continue;
      switch (entry.type) {
      case 'directory':
        await visit({ absoluteDirectory: entry.fullPath });
        break;
      case 'file':
      case 'symlink':
        result.push(relativePath);
        break;
      case 'fifo':
      case 'chardev':
        break;
      default: {
        const _ex: never = entry.type;
        throw new Error(`Unhandled directory entry type: ${_ex}`);
      }
      }
    }
  };
  await visit({ absoluteDirectory: repository.worktreePath });
  return sortGitPaths({ paths: result });
}

export async function collectPathsForAdd({ files, repository, cwd, operands }: {
  files: GitFiles,
  repository: GitRepository,
  cwd: string,
  operands: readonly string[],
}): Promise<Set<string>> {
  const selected = new Set<string>();

  const visitPath = async ({ absolutePath }: { absolutePath: string }): Promise<void> => {
    let stat;
    try {
      stat = await files.lstat({ path: absolutePath });
    } catch {
      const relative = relativeToWorktree({ repository, absolutePath });
      if (relative.length > 0) selected.add(relative);
      return;
    }
    const relative = relativeToWorktree({ repository, absolutePath });
    if (relative === '.git' || relative.startsWith('.git/')) return;
    switch (stat.type) {
    case 'directory':
      for await (const child of files.readDir({ path: absolutePath })) {
        await visitPath({ absolutePath: child.fullPath });
      }
      break;
    case 'file':
    case 'symlink':
      if (relative.length > 0) selected.add(relative);
      break;
    case 'fifo':
    case 'chardev':
      throw new Error(`unsupported path type: ${relative}`);
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled path type: ${_ex}`);
    }
    }
  };

  for (const operand of operands) {
    const absolutePath = normalizePath({ cwd, path: operand });
    relativeToWorktree({ repository, absolutePath });
    await visitPath({ absolutePath });
  }
  return selected;
}

export function worktreeAbsolutePath({ repository, path }: {
  repository: GitRepository,
  path: string,
}): string {
  assertSafeGitRepositoryPath({ path, source: 'worktree' });
  return joinPath({ base: repository.worktreePath, child: path });
}

async function removeWorktreePathRecursively({ files, path }: {
  files: GitFiles,
  path: string,
}): Promise<void> {
  if (!await pathExists({ files, path })) return;
  const stat = await files.lstat({ path });
  switch (stat.type) {
  case 'directory':
    for await (const child of files.readDir({ path })) {
      await removeWorktreePathRecursively({ files, path: child.fullPath });
    }
    await files.rmdir({ path });
    break;
  case 'file':
  case 'symlink':
  case 'fifo':
  case 'chardev':
    await files.unlink({ path });
    break;
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled worktree entry type: ${_ex}`);
  }
  }
}

function parentPath({ path }: { path: string }): string {
  const slashIndex = path.lastIndexOf('/');
  return slashIndex <= 0 ? '/' : path.slice(0, slashIndex);
}

async function ensureWorktreeDirectory({ files, repository, directoryPath }: {
  files: GitFiles,
  repository: GitRepository,
  directoryPath: string,
}): Promise<void> {
  if (directoryPath === repository.worktreePath || directoryPath === '/') return;
  await ensureWorktreeDirectory({
    files,
    repository,
    directoryPath: parentPath({ path: directoryPath }),
  });
  if (await pathExists({ files, path: directoryPath })) {
    const stat = await files.lstat({ path: directoryPath });
    switch (stat.type) {
    case 'directory':
      return;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      await removeWorktreePathRecursively({ files, path: directoryPath });
      break;
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled file type: ${_ex}`);
    }
    }
  }
  await files.mkdir({ path: directoryPath, recursive: false });
}

type PreparedWorktreeMaterialization =
  | { type: 'file', path: string, bytes: Uint8Array }
  | { type: 'symlink', path: string, targetPath: string }
  | { type: 'gitlink', path: string };

async function prepareWorktreeMaterialization({ files, repository, entry, attributes }: {
  files: GitFiles,
  repository: GitRepository,
  entry: GitIndexEntry,
  attributes: GitAttributesMatcher,
}): Promise<PreparedWorktreeMaterialization> {
  const path = worktreeAbsolutePath({ repository, path: entry.path });
  switch (entry.mode) {
  case 0o100644:
  case 0o100755: {
    const object = await readObject({ files, repository, objectId: entry.objectId });
    switch (object.type) {
    case 'blob':
      return { type: 'file', path, bytes: attributes.smudge({ path: entry.path, bytes: object.body }) };
    case 'tree':
    case 'commit':
    case 'tag':
      throw new Error(`worktree file ${entry.path} does not reference a blob`);
    default: {
      const _ex: never = object.type;
      throw new Error(`Unhandled object type: ${_ex}`);
    }
    }
  }
  case 0o120000: {
    const object = await readObject({ files, repository, objectId: entry.objectId });
    switch (object.type) {
    case 'blob':
      return {
        type: 'symlink',
        path,
        targetPath: new TextDecoder('utf-8', { fatal: true }).decode(object.body),
      };
    case 'tree':
    case 'commit':
    case 'tag':
      throw new Error(`worktree symlink ${entry.path} does not reference a blob`);
    default: {
      const _ex: never = object.type;
      throw new Error(`Unhandled object type: ${_ex}`);
    }
    }
  }
  case 0o160000:
    if (await pathExists({ files, path })) {
      const stat = await files.lstat({ path });
      if (stat.type === 'directory' && await pathExists({ files, path: joinPath({ base: path, child: '.git' }) })) {
        throw new Error(`initialized gitlink worktree is not supported yet: ${entry.path}`);
      }
    }
    return { type: 'gitlink', path };
  default:
    throw new Error(`unsupported worktree mode ${entry.mode.toString(8)}: ${entry.path}`);
  }
}

async function applyPreparedWorktreeMaterialization({ files, repository, prepared }: {
  files: GitFiles,
  repository: GitRepository,
  prepared: PreparedWorktreeMaterialization,
}): Promise<void> {
  await ensureWorktreeDirectory({ files, repository, directoryPath: parentPath({ path: prepared.path }) });
  switch (prepared.type) {
  case 'file':
    if (await pathExists({ files, path: prepared.path })) {
      const stat = await files.lstat({ path: prepared.path });
      switch (stat.type) {
      case 'file':
        break;
      case 'directory':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        await removeWorktreePathRecursively({ files, path: prepared.path });
        break;
      default: {
        const _ex: never = stat.type;
        throw new Error(`Unhandled file type: ${_ex}`);
      }
      }
    }
    await writeFileBytes({ files, path: prepared.path, bytes: prepared.bytes });
    return;
  case 'symlink':
    await removeWorktreePathRecursively({ files, path: prepared.path });
    await files.symlink({ path: prepared.path, targetPath: prepared.targetPath });
    return;
  case 'gitlink':
    if (await pathExists({ files, path: prepared.path })) {
      const stat = await files.lstat({ path: prepared.path });
      switch (stat.type) {
      case 'directory':
        if (await pathExists({ files, path: joinPath({ base: prepared.path, child: '.git' }) })) {
          throw new Error(`initialized gitlink worktree is not supported yet: ${prepared.path}`);
        }
        return;
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        await removeWorktreePathRecursively({ files, path: prepared.path });
        break;
      default: {
        const _ex: never = stat.type;
        throw new Error(`Unhandled gitlink worktree type: ${_ex}`);
      }
      }
    }
    await files.mkdir({ path: prepared.path, recursive: false });
    return;
  default: {
    const _ex: never = prepared;
    throw new Error(`Unhandled prepared worktree materialization: ${_ex}`);
  }
  }
}

async function removeEmptyParentDirectories({ files, repository, path }: {
  files: GitFiles,
  repository: GitRepository,
  path: string,
}): Promise<void> {
  let current = parentPath({ path });
  while (current !== repository.worktreePath && current !== '/') {
    let hasEntries = false;
    for await (const _entry of files.readDir({ path: current })) {
      hasEntries = true;
      break;
    }
    if (hasEntries) return;
    await files.rmdir({ path: current });
    current = parentPath({ path: current });
  }
}

export async function removeWorktreePaths({ files, repository, paths }: {
  files: GitFiles,
  repository: GitRepository,
  paths: Iterable<string>,
}): Promise<void> {
  for (const path of sortGitPaths({ paths }).reverse()) {
    const absolutePath = worktreeAbsolutePath({ repository, path });
    if (!await pathExists({ files, path: absolutePath })) continue;
    await removeWorktreePathRecursively({ files, path: absolutePath });
    await removeEmptyParentDirectories({ files, repository, path: absolutePath });
  }
}

async function removeGitlinkDirectoryIfEmpty({ files, path }: { files: GitFiles, path: string }): Promise<void> {
  if (!await pathExists({ files, path })) return;
  const stat = await files.lstat({ path });
  switch (stat.type) {
  case 'directory':
    for await (const _entry of files.readDir({ path })) return;
    await files.rmdir({ path });
    return;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    await removeWorktreePathRecursively({ files, path });
    return;
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled gitlink worktree type: ${_ex}`);
  }
  }
}

export async function replaceTrackedWorktreePaths({ files, repository, previousEntries, targetEntries, paths, contentConfig }: {
  files: GitFiles,
  repository: GitRepository,
  previousEntries: readonly GitIndexEntry[],
  targetEntries: readonly GitIndexEntry[],
  paths: ReadonlySet<string>,
  contentConfig: GitWorktreeContentConfig,
}): Promise<void> {
  const previousByPath = new Map(previousEntries.map(entry => [entry.path, entry]));
  const targetByPath = new Map(targetEntries.map(entry => [entry.path, entry]));
  const attributes = await loadIndexAttributes({ files, repository, entries: targetEntries, contentConfig });
  const sortedPaths = sortGitPaths({ paths });
  const preparedByPath = new Map<string, PreparedWorktreeMaterialization>();
  for (const path of sortedPaths) {
    const targetEntry = targetByPath.get(path);
    if (targetEntry === undefined) continue;
    if (targetEntry.stage !== 0) throw new Error(`cannot materialize unmerged index entry: ${path}`);
    preparedByPath.set(path, await prepareWorktreeMaterialization({ files, repository, entry: targetEntry, attributes }));
  }
  for (const path of sortedPaths) {
    const previousEntry = previousByPath.get(path);
    const targetEntry = targetByPath.get(path);
    if (previousEntry !== undefined && previousEntry.stage !== 0) {
      throw new Error(`cannot replace worktree with unmerged index entry: ${path}`);
    }
    if (targetEntry === undefined) {
      const absolutePath = worktreeAbsolutePath({ repository, path });
      if (previousEntry?.mode === 0o160000) await removeGitlinkDirectoryIfEmpty({ files, path: absolutePath });
      else await removeWorktreePathRecursively({ files, path: absolutePath });
      continue;
    }
    const prepared = preparedByPath.get(path);
    if (prepared === undefined) throw new Error(`missing prepared worktree materialization: ${path}`);
    await applyPreparedWorktreeMaterialization({ files, repository, prepared });
  }
}

export async function replaceTrackedWorktree({ files, repository, previousEntries, targetEntries, attributeEntries, contentConfig }: {
  files: GitFiles,
  repository: GitRepository,
  previousEntries: readonly GitIndexEntry[],
  targetEntries: readonly GitIndexEntry[],
  attributeEntries?: readonly GitIndexEntry[],
  contentConfig: GitWorktreeContentConfig,
}): Promise<void> {
  const targetPaths = new Set(targetEntries.map(entry => entry.path));
  const attributes = await loadIndexAttributes({ files, repository, entries: attributeEntries ?? targetEntries, contentConfig });
  const preparedEntries: PreparedWorktreeMaterialization[] = [];
  for (const entry of targetEntries) {
    if (entry.stage !== 0) throw new Error(`cannot materialize unmerged index entry: ${entry.path}`);
    preparedEntries.push(await prepareWorktreeMaterialization({ files, repository, entry, attributes }));
  }
  for (const previousEntry of previousEntries) {
    if (previousEntry.stage !== 0) throw new Error(`cannot replace worktree with unmerged index entry: ${previousEntry.path}`);
    if (!targetPaths.has(previousEntry.path)) {
      const absolutePath = worktreeAbsolutePath({ repository, path: previousEntry.path });
      if (previousEntry.mode === 0o160000) await removeGitlinkDirectoryIfEmpty({ files, path: absolutePath });
      else await removeWorktreePathRecursively({ files, path: absolutePath });
    }
  }
  for (const prepared of preparedEntries) {
    await applyPreparedWorktreeMaterialization({ files, repository, prepared });
  }
}

export const TEST_ONLY = {
};
