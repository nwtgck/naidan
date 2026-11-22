import { isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';
import { canonicalizePathAllowingMissingComponents, resolvePath } from '@/features/wesh/path';
import type { WeshCommandContext, WeshEntryRef, WeshOpenFlags, WeshStat, WeshTemporaryEntry } from '@/features/wesh/types';
import { WeshCommandInterruptedError, WeshRenameIncompleteError } from '@/features/wesh/types';
import {
  openFileReadStream,
  openHandleReadStream,
  writeAllBytesToHandle,
} from '@/features/wesh/utils/fs';
import type {
  PatchContent,
  PatchFileKind,
  PatchLineSource,
  PatchOptions,
  PatchSection,
  PatchTarget,
} from './types';
import {
  createPatchLineSourceFromBytes,
  createPatchLineSourceFromEntry,
} from './source';

const encoder = new TextEncoder();
let temporarySequence = 0;

export class PatchTargetResolutionError extends Error {
  constructor({ message }: { message: string }) {
    super(message);
    this.name = 'PatchTargetResolutionError';
  }
}

function basename({ path }: { path: string }): string {
  const normalized = path === '/' ? '/' : path.replace(/\/+$/u, '');
  const index = normalized.lastIndexOf('/');
  return index < 0 ? normalized : normalized.slice(index + 1);
}

function dirname({ path }: { path: string }): string {
  const normalized = path === '/' ? '/' : path.replace(/\/+$/u, '');
  const index = normalized.lastIndexOf('/');
  if (index <= 0) {
    return '/';
  }
  return normalized.slice(0, index);
}

function joinPath({ directory, name }: { directory: string, name: string }): string {
  return directory === '/' ? `/${name}` : `${directory}/${name}`;
}

async function pathStat({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<WeshStat | undefined> {
  try {
    return await context.files.lstat({ path });
  } catch (error: unknown) {
    if (isPathNotFoundError({ error })) {
      return undefined;
    }
    throw error;
  }
}

export async function pathExists({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<boolean> {
  return await pathStat({ context, path }) !== undefined;
}

async function collectStreamBytes({
  stream,
}: {
  stream: ReadableStream<Uint8Array>,
}): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readPatchInput({
  context,
  path,
  cwd,
}: {
  context: WeshCommandContext,
  path: string | undefined,
  cwd: string,
}): Promise<Uint8Array> {
  if (path === undefined || path === '-') {
    return collectStreamBytes({ stream: openHandleReadStream({ handle: context.stdin }) });
  }

  const fullPath = resolvePath({ cwd, path });
  return collectStreamBytes({ stream: await openFileReadStream({ files: context.files, path: fullPath }) });
}

export async function resolveEffectiveDirectory({
  context,
  cwd,
  directory,
}: {
  context: WeshCommandContext,
  cwd: string,
  directory: string,
}): Promise<string> {
  const displayDirectory = directory.length === 0 ? "''" : directory;
  if (directory.length === 0) {
    throw new Error(`Can't change to directory ${displayDirectory} : No such file or directory`);
  }

  const fullPath = resolvePath({ cwd, path: directory });
  let stat: Awaited<ReturnType<WeshCommandContext['files']['stat']>>;
  try {
    stat = await context.files.stat({ path: fullPath });
  } catch {
    throw new Error(`Can't change to directory ${displayDirectory} : No such file or directory`);
  }

  switch (stat.type) {
  case 'directory':
    return fullPath;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`Can't change to directory ${displayDirectory} : Not a directory`);
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled file type: ${_ex}`);
  }
  }
}

function stripPatchPath({
  path,
  stripCount,
}: {
  path: string | undefined,
  stripCount: number | undefined,
}): string | undefined {
  if (path === undefined || path === '/dev/null') {
    return undefined;
  }
  if (path.includes('\0')) {
    throw new Error('patch path contains a NUL byte');
  }
  if (path.startsWith('/')) {
    throw new Error(`unsafe absolute patch path '${path}'`);
  }

  const components = path.split('/').filter((component) => component.length > 0 && component !== '.');
  if (components.some((component) => component === '..')) {
    throw new Error(`unsafe patch path '${path}' contains '..'`);
  }

  const stripped = stripCount === undefined
    ? components.slice(-1)
    : components.slice(stripCount);
  if (stripped.length === 0) {
    return undefined;
  }
  return stripped.join('/');
}

async function ensureNoSymlinkAncestors({
  context,
  root,
  relativePath,
}: {
  context: WeshCommandContext,
  root: string,
  relativePath: string,
}): Promise<void> {
  const components = relativePath.split('/');
  let current = root;

  for (let index = 0; index < components.length - 1; index++) {
    current = joinPath({ directory: current, name: components[index]! });
    const stat = await pathStat({ context, path: current });
    if (stat === undefined) {
      return;
    }
    switch (stat.type) {
    case 'directory':
      break;
    case 'symlink':
      throw new Error(`unsafe patch path traverses symbolic link '${current}'`);
    case 'file':
    case 'fifo':
    case 'chardev':
      throw new Error(`patch path ancestor is not a directory: '${current}'`);
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled file type: ${_ex}`);
    }
    }
  }
}

async function resolvePatchRelativePath({
  context,
  root,
  rawPath,
  stripCount,
}: {
  context: WeshCommandContext,
  root: string,
  rawPath: string | undefined,
  stripCount: number | undefined,
}): Promise<string | undefined> {
  const relativePath = stripPatchPath({ path: rawPath, stripCount });
  if (relativePath === undefined) {
    return undefined;
  }
  await ensureNoSymlinkAncestors({ context, root, relativePath });
  return joinPath({ directory: root, name: relativePath });
}

function sourcePathCandidates({ section }: { section: PatchSection }): Array<string | undefined> {
  switch (section.header.operation) {
  case 'rename':
    return [section.header.oldPath, section.header.renameFrom, section.header.indexPath];
  case 'copy':
    return [section.header.oldPath, section.header.copyFrom, section.header.indexPath];
  case 'create':
    return [];
  case 'delete':
  case 'modify':
    return [section.header.oldPath, section.header.newPath, section.header.indexPath];
  default: {
    const _ex: never = section.header.operation;
    throw new Error(`Unhandled patch operation: ${_ex}`);
  }
  }
}

function destinationPathCandidates({ section }: { section: PatchSection }): Array<string | undefined> {
  switch (section.header.operation) {
  case 'rename':
    return [section.header.newPath, section.header.renameTo];
  case 'copy':
    return [section.header.newPath, section.header.copyTo];
  case 'create':
  case 'modify':
    return [section.header.newPath, section.header.oldPath, section.header.indexPath];
  case 'delete':
    return [section.header.oldPath, section.header.newPath, section.header.indexPath];
  default: {
    const _ex: never = section.header.operation;
    throw new Error(`Unhandled patch operation: ${_ex}`);
  }
  }
}

export async function resolvePatchTarget({
  context,
  section,
  explicitOriginalPath,
  effectiveDirectory,
  stripCount,
}: {
  context: WeshCommandContext,
  section: PatchSection,
  explicitOriginalPath: string | undefined,
  effectiveDirectory: string,
  stripCount: number | undefined,
}): Promise<PatchTarget> {
  if (explicitOriginalPath !== undefined) {
    const fullPath = resolvePath({ cwd: effectiveDirectory, path: explicitOriginalPath });
    switch (section.header.operation) {
    case 'create':
      return {
        displayPath: explicitOriginalPath,
        sourcePath: undefined,
        destinationPath: fullPath,
        operation: 'create',
      };
    case 'rename':
    case 'copy':
      return {
        displayPath: explicitOriginalPath,
        sourcePath: fullPath,
        destinationPath: fullPath,
        operation: 'modify',
      };
    case 'delete':
    case 'modify':
      return {
        displayPath: explicitOriginalPath,
        sourcePath: fullPath,
        destinationPath: fullPath,
        operation: section.header.operation,
      };
    default: {
      const _ex: never = section.header.operation;
      throw new Error(`Unhandled patch operation: ${_ex}`);
    }
    }
  }

  const resolvedSourceCandidates: string[] = [];
  for (const candidate of sourcePathCandidates({ section })) {
    const resolved = await resolvePatchRelativePath({
      context,
      root: effectiveDirectory,
      rawPath: candidate,
      stripCount,
    });
    if (resolved !== undefined) {
      resolvedSourceCandidates.push(resolved);
    }
  }

  let sourcePath = resolvedSourceCandidates[0];
  for (const candidate of resolvedSourceCandidates) {
    if (await pathExists({ context, path: candidate })) {
      sourcePath = candidate;
      break;
    }
  }

  let explicitDestinationPath: string | undefined;
  for (const candidate of destinationPathCandidates({ section })) {
    const resolved = await resolvePatchRelativePath({
      context,
      root: effectiveDirectory,
      rawPath: candidate,
      stripCount,
    });
    if (resolved !== undefined) {
      explicitDestinationPath = resolved;
      break;
    }
  }

  const destinationPath = (() => {
    switch (section.header.operation) {
    case 'modify':
    case 'delete':
      return sourcePath;
    case 'create':
    case 'copy':
    case 'rename':
      return explicitDestinationPath;
    default: {
      const _ex: never = section.header.operation;
      throw new Error(`Unhandled patch operation: ${_ex}`);
    }
    }
  })();

  if (destinationPath === undefined) {
    throw new PatchTargetResolutionError({
      message: `cannot determine file name for patch at input line ${section.sourceLineNumber}`,
    });
  }

  if (section.header.operation !== 'create' && sourcePath === undefined) {
    throw new PatchTargetResolutionError({
      message: `cannot determine source file for patch at input line ${section.sourceLineNumber}`,
    });
  }

  return {
    displayPath: effectiveDirectory === '/' && destinationPath.startsWith('/')
      ? destinationPath.slice(1)
      : destinationPath.startsWith(`${effectiveDirectory}/`)
        ? destinationPath.slice(effectiveDirectory.length + 1)
        : destinationPath,
    sourcePath,
    destinationPath,
    operation: section.header.operation,
  };
}

export interface ReadPatchSourceResult {
  kind: PatchFileKind,
  source: PatchLineSource,
  mode: number,
  entry: WeshEntryRef<'file' | 'symlink'> | undefined,
}

export async function readPatchSource({
  context,
  path,
  expectedKind,
}: {
  context: WeshCommandContext,
  path: string | undefined,
  expectedKind: PatchFileKind,
}): Promise<ReadPatchSourceResult> {
  if (path === undefined) {
    switch (expectedKind) {
    case 'regular':
      return {
        kind: 'regular',
        source: await createPatchLineSourceFromBytes({ bytes: new Uint8Array(0) }),
        mode: 0o644,
        entry: undefined,
      };
    case 'symlink':
      return {
        kind: 'symlink',
        source: await createPatchLineSourceFromBytes({ bytes: new Uint8Array(0) }),
        mode: 0o777,
        entry: undefined,
      };
    default: {
      const _ex: never = expectedKind;
      throw new Error(`Unhandled patch file kind: ${_ex}`);
    }
    }
  }

  const entry = await context.files.resolveEntry({ path, finalSymlinkTreatment: 'no-follow', pinBacking: true });
  const stat = await context.files.statEntry({ entry });
  switch (entry.type) {
  case 'file':
    switch (expectedKind) {
    case 'regular':
      return {
        kind: 'regular',
        source: await createPatchLineSourceFromEntry({ context, entry }),
        mode: stat.mode & 0o7777,
        entry,
      };
    case 'symlink':
      throw new Error(`expected symbolic link but found regular file: '${path}'`);
    default: {
      const _ex: never = expectedKind;
      throw new Error(`Unhandled patch file kind: ${_ex}`);
    }
    }
  case 'symlink': {
    switch (expectedKind) {
    case 'regular':
      throw new Error(`refusing to follow symbolic link '${path}'`);
    case 'symlink': {
      const target = encoder.encode(await context.files.readlinkEntry({ entry }));
      return {
        kind: 'symlink',
        source: await createPatchLineSourceFromBytes({ bytes: target }),
        mode: stat.mode & 0o7777,
        entry,
      };
    }
    default: {
      const _ex: never = expectedKind;
      throw new Error(`Unhandled patch file kind: ${_ex}`);
    }
    }
  }
  case 'directory':
  case 'fifo':
  case 'chardev':
    throw new Error(`unsupported patch target type '${entry.type}': '${path}'`);
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled patch target: ${String(_ex)}`);
  }
  }
}

async function ensureParentDirectory({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<void> {
  await context.files.mkdir({ path: dirname({ path }), recursive: true });
}

async function allocateTemporaryPath({
  context,
  targetPath,
  purpose,
}: {
  context: WeshCommandContext,
  targetPath: string,
  purpose: string,
}): Promise<string> {
  for (let attempt = 0; attempt < 10_000; attempt++) {
    temporarySequence += 1;
    const candidate = joinPath({
      directory: dirname({ path: targetPath }),
      name: `.${basename({ path: targetPath })}.wesh-patch-${purpose}-${temporarySequence}`,
    });
    if (!await pathExists({ context, path: candidate })) {
      return candidate;
    }
  }
  throw new Error(`cannot allocate temporary path for '${targetPath}'`);
}

async function writePatchContentToHandle({
  handle,
  content,
}: {
  handle: Awaited<ReturnType<WeshCommandContext['files']['open']>>,
  content: PatchContent,
}): Promise<void> {
  switch (content.kind) {
  case 'bytes':
    await writeAllBytesToHandle({ handle, data: content.bytes });
    return;
  case 'line-plan':
    for (const piece of content.pieces) {
      switch (piece.kind) {
      case 'source': {
        const start = content.source.boundaryOffset({ lineIndex: piece.startLine });
        const end = content.source.boundaryOffset({ lineIndex: piece.endLine });
        await content.source.forEachChunk({
          start,
          end,
          consume: async ({ chunk }) => {
            await writeAllBytesToHandle({ handle, data: chunk });
          },
        });
        break;
      }
      case 'bytes':
        await writeAllBytesToHandle({ handle, data: piece.bytes });
        break;
      default: {
        const _ex: never = piece;
        throw new Error(`Unhandled output piece: ${JSON.stringify(_ex)}`);
      }
      }
    }
    return;
  case 'sequence':
    for (const child of content.contents) {
      await writePatchContentToHandle({ handle, content: child });
    }
    return;
  default: {
    const _ex: never = content;
    throw new Error(`Unhandled patch content: ${JSON.stringify(_ex)}`);
  }
  }
}

export function getPatchContentByteLength({
  content,
}: {
  content: PatchContent,
}): number {
  switch (content.kind) {
  case 'bytes':
    return content.bytes.byteLength;
  case 'line-plan': {
    let byteLength = 0;
    for (const piece of content.pieces) {
      switch (piece.kind) {
      case 'source':
        byteLength += content.source.boundaryOffset({ lineIndex: piece.endLine })
          - content.source.boundaryOffset({ lineIndex: piece.startLine });
        break;
      case 'bytes':
        byteLength += piece.bytes.byteLength;
        break;
      default: {
        const _ex: never = piece;
        throw new Error(`Unhandled output piece: ${JSON.stringify(_ex)}`);
      }
      }
      if (!Number.isSafeInteger(byteLength)) {
        throw new Error('patched output is too large');
      }
    }
    return byteLength;
  }
  case 'sequence': {
    let byteLength = 0;
    for (const child of content.contents) {
      byteLength += getPatchContentByteLength({ content: child });
      if (!Number.isSafeInteger(byteLength)) {
        throw new Error('patched output is too large');
      }
    }
    return byteLength;
  }
  default: {
    const _ex: never = content;
    throw new Error(`Unhandled patch content: ${JSON.stringify(_ex)}`);
  }
  }
}

export async function materializePatchContent({
  content,
}: {
  content: PatchContent,
}): Promise<Uint8Array> {
  const byteLength = getPatchContentByteLength({ content });
  const result = new Uint8Array(byteLength);
  let offset = 0;
  const sink = {
    async write({ buffer, offset: requestedOffset, length }: {
      buffer: Uint8Array,
      offset?: number,
      length?: number,
    }) {
      const sourceOffset = requestedOffset ?? 0;
      const sourceLength = length ?? (buffer.byteLength - sourceOffset);
      result.set(buffer.subarray(sourceOffset, sourceOffset + sourceLength), offset);
      offset += sourceLength;
      return { bytesWritten: sourceLength };
    },
    async read() {
      return { bytesRead: 0 };
    },
    async close() {},
    async stat() {
      return { size: result.byteLength, mode: 0o644, type: 'file' as const, mtime: 0, ino: 0, uid: 0, gid: 0 };
    },
    async truncate() {},
    async ioctl() {
      return { ret: 0 };
    },
  };
  await writePatchContentToHandle({ handle: sink, content });
  return result;
}

async function preparePatchedEntry({
  context,
  path,
  kind,
  content,
  mode,
}: {
  context: WeshCommandContext,
  path: string,
  kind: PatchFileKind,
  content: PatchContent,
  mode: number,
}): Promise<WeshTemporaryEntry> {
  switch (kind) {
  case 'regular': {
    const temporary = await context.files.createTemporaryFile({ path });
    try {
      try {
        await writePatchContentToHandle({ handle: temporary.handle, content });
      } finally {
        await temporary.handle.close();
      }
      return temporary;
    } catch (error: unknown) {
      await temporary.discard().catch(() => {});
      throw error;
    }
  }
  case 'symlink':
    return context.files.createTemporarySymlink({
      path,
      targetPath: new TextDecoder('utf-8', { fatal: true }).decode(
        await materializePatchContent({ content }),
      ),
      mode: mode & 0o7777,
    });
  default: {
    const _ex: never = kind;
    throw new Error(`Unhandled patch file kind: ${_ex}`);
  }
  }
}

async function findNumberedBackupPath({
  context,
  targetPath,
}: {
  context: WeshCommandContext,
  targetPath: string,
}): Promise<string> {
  for (let number = 1; number <= Number.MAX_SAFE_INTEGER; number++) {
    const candidate = `${targetPath}.~${number}~`;
    if (!await pathExists({ context, path: candidate })) {
      return candidate;
    }
  }
  throw new Error(`cannot allocate numbered backup for '${targetPath}'`);
}

async function hasNumberedBackup({
  context,
  targetPath,
}: {
  context: WeshCommandContext,
  targetPath: string,
}): Promise<boolean> {
  const directoryPath = dirname({ path: targetPath });
  if (!await pathExists({ context, path: directoryPath })) {
    return false;
  }
  const prefix = `${basename({ path: targetPath })}.~`;
  for await (const entry of context.files.readDir({ path: directoryPath })) {
    if (entry.name.startsWith(prefix) && entry.name.endsWith('~')) {
      return true;
    }
  }
  return false;
}

async function resolveBackupPath({
  context,
  targetPath,
  options,
  cwd,
}: {
  context: WeshCommandContext,
  targetPath: string,
  options: PatchOptions,
  cwd: string,
}): Promise<string> {
  let basePath = targetPath;
  if (options.backupBasenamePrefix !== undefined) {
    basePath = joinPath({
      directory: dirname({ path: targetPath }),
      name: `${options.backupBasenamePrefix}${basename({ path: targetPath })}`,
    });
  }
  if (options.backupPrefix !== undefined) {
    const rootPrefix = cwd === '/' ? '/' : `${cwd}/`;
    const relative = basePath.startsWith(rootPrefix)
      ? basePath.slice(rootPrefix.length)
      : basePath.startsWith('/')
        ? basePath.slice(1)
        : basePath;
    basePath = resolvePath({ cwd, path: `${options.backupPrefix}${relative}` });
  }

  if (
    (options.backupPrefix !== undefined || options.backupBasenamePrefix !== undefined)
    && !options.backupSuffixExplicit
  ) {
    return basePath;
  }

  switch (options.backupStyle) {
  case 'simple':
    return `${basePath}${options.backupSuffix}`;
  case 'numbered':
    return findNumberedBackupPath({ context, targetPath: basePath });
  case 'existing':
    return await hasNumberedBackup({ context, targetPath: basePath })
      ? findNumberedBackupPath({ context, targetPath: basePath })
      : `${basePath}${options.backupSuffix}`;
  default: {
    const _ex: never = options.backupStyle;
    throw new Error(`Unhandled backup style: ${_ex}`);
  }
  }
}

export async function createBackup({
  context,
  targetPath,
  source,
  options,
  cwd,
}: {
  context: WeshCommandContext,
  targetPath: string,
  source: ReadPatchSourceResult | undefined,
  options: PatchOptions,
  cwd: string,
}): Promise<string> {
  const backupPath = await resolveBackupPath({ context, targetPath, options, cwd });
  if (backupPath === targetPath) {
    throw new Error(`backup path would overwrite '${targetPath}'`);
  }
  if (source?.entry === undefined) {
    await installPatchedEntry({
      context,
      targetPath: backupPath,
      kind: 'regular',
      content: { kind: 'bytes', bytes: new Uint8Array(0) },
      mode: 0o644,
    });
    return backupPath;
  }

  const current = await resolvePatchEntry({ context, path: targetPath });
  if (current === undefined || await context.files.compareEntryIdentity({ first: source.entry, second: current }) !== 'same') {
    throw new Error(`Source entry changed: ${targetPath}`);
  }
  const expected = await resolvePatchEntry({ context, path: backupPath });
  if (expected !== undefined) {
    const relation = await context.files.compareEntryIdentity({ first: source.entry, second: expected });
    if (relation === 'same' || relation === 'shared-backing') {
      throw new Error(`backup path would overwrite '${targetPath}'`);
    }
  }
  await publishPatchedEntry({
    context,
    targetPath: backupPath,
    expected,
    kind: source.kind,
    content: {
      kind: 'line-plan',
      source: source.source,
      pieces: [{ kind: 'source', startLine: 0, endLine: source.source.lineCount }],
    },
    mode: source.mode,
  });
  return backupPath;
}

export async function resolvePatchEntry({ context, path }: {
  context: WeshCommandContext,
  path: string,
}): Promise<WeshEntryRef | undefined> {
  try {
    return await context.files.resolveEntry({ path, finalSymlinkTreatment: 'no-follow', pinBacking: true });
  } catch (error: unknown) {
    if (isPathNotFoundError({ error })) {
      return undefined;
    }
    throw error;
  }
}

export async function samePatchOutput({ context, first, second }: {
  context: WeshCommandContext,
  first: string,
  second: string,
}): Promise<boolean> {
  if (first === second) {
    return true;
  }
  const left = await resolvePatchEntry({ context, path: first });
  const right = await resolvePatchEntry({ context, path: second });
  if (left !== undefined && right !== undefined) {
    const relation = await context.files.compareEntryIdentity({ first: left, second: right });
    return relation === 'same' || relation === 'shared-backing';
  }
  if (basename({ path: first }) !== basename({ path: second })) {
    return false;
  }
  let firstParent = await canonicalizePathAllowingMissingComponents({ context, path: dirname({ path: first }) });
  let secondParent = await canonicalizePathAllowingMissingComponents({ context, path: dirname({ path: second }) });
  // Compare physical directories after peeling off any identical missing suffix.
  while (firstParent !== secondParent) {
    const leftParent = await resolvePatchEntry({ context, path: firstParent });
    const rightParent = await resolvePatchEntry({ context, path: secondParent });
    if (leftParent !== undefined || rightParent !== undefined) {
      return leftParent !== undefined && rightParent !== undefined
        && await context.files.compareEntryIdentity({ first: leftParent, second: rightParent }) === 'same';
    }
    if (basename({ path: firstParent }) !== basename({ path: secondParent })) {
      return false;
    }
    firstParent = dirname({ path: firstParent });
    secondParent = dirname({ path: secondParent });
  }
  return true;
}

export async function publishPatchedEntry({ context, targetPath, expected, kind, content, mode }: {
  context: WeshCommandContext,
  targetPath: string,
  expected: WeshEntryRef | undefined,
  kind: PatchFileKind,
  content: PatchContent,
  mode: number,
}): Promise<WeshEntryRef> {
  await ensureParentDirectory({ context, path: targetPath });
  const temporaryPath = await allocateTemporaryPath({ context, targetPath, purpose: 'output' });
  const temporary = await preparePatchedEntry({ context, path: temporaryPath, kind, content, mode });
  try {
    return await context.files.replaceEntry({ entry: temporary.entry, path: targetPath, expected, backupPath: undefined });
  } catch (error: unknown) {
    if (!(error instanceof WeshRenameIncompleteError)) {
      await temporary.discard().catch(() => {});
    }
    throw error;
  }
}

export async function installPatchedEntry({
  context,
  targetPath,
  kind,
  content,
  mode,
}: {
  context: WeshCommandContext,
  targetPath: string,
  kind: PatchFileKind,
  content: PatchContent,
  mode: number,
}): Promise<void> {
  const expected = await resolvePatchEntry({ context, path: targetPath });
  await publishPatchedEntry({ context, targetPath, expected, kind, content, mode });
}

export async function removePatchedEntry({ context, entry, retainedEntry, mode }: {
  context: WeshCommandContext,
  entry: WeshEntryRef<'file' | 'symlink'>,
  retainedEntry: WeshEntryRef | undefined,
  mode: number,
}): Promise<void> {
  const path = entry.fullPath;
  const retainedEntries = retainedEntry === undefined ? [] : [retainedEntry];
  switch (entry.type) {
  case 'file':
    await context.files.unlink({ path, expected: { entry, retainedEntries } });
    return;
  case 'symlink':
    break;
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled removal entry: ${String(_ex)}`);
  }
  }

  // A symlink has two provider entries. Keep its target recoverable if only one is removed.
  const recoveryPath = await allocateTemporaryPath({ context, targetPath: path, purpose: 'recovery' });
  const targetPath = await context.files.readlinkEntry({ entry });
  const recovery = await context.files.createTemporarySymlink({ path: recoveryPath, targetPath, mode });
  retainedEntries.push(recovery.entry);
  try {
    await context.files.unlink({ path, expected: { entry, retainedEntries } });
  } catch (cause: unknown) {
    if (cause instanceof WeshCommandInterruptedError) {
      await recovery.discard();
      throw cause;
    }
    throw new Error(`Could not remove '${path}' (${String(cause)}). Recovery path: '${recoveryPath}'`, { cause });
  }
  await recovery.discard();
}

export async function installRenamedEntry({
  context,
  sourceEntry,
  destinationPath,
  kind,
  content,
  mode,
  sourceMode,
}: {
  context: WeshCommandContext,
  sourceEntry: WeshEntryRef<'file' | 'symlink'>,
  destinationPath: string,
  kind: PatchFileKind,
  content: PatchContent,
  mode: number,
  sourceMode: number,
}): Promise<void> {
  if (sourceEntry.fullPath === destinationPath) {
    await publishPatchedEntry({
      context,
      targetPath: destinationPath,
      expected: sourceEntry,
      kind,
      content,
      mode,
    });
    return;
  }

  if (await pathExists({ context, path: destinationPath })) {
    throw new Error(`rename destination already exists: '${destinationPath}'`);
  }

  const retainedEntry = await publishPatchedEntry({
    context,
    targetPath: destinationPath,
    kind,
    content,
    mode,
    expected: undefined,
  });

  await removePatchedEntry({ context, entry: sourceEntry, retainedEntry, mode: sourceMode });
}

export async function appendFileBytes({
  context,
  path,
  bytes,
}: {
  context: WeshCommandContext,
  path: string,
  bytes: Uint8Array,
}): Promise<void> {
  const flags: WeshOpenFlags = {
    access: 'write',
    creation: 'if-needed',
    truncate: 'preserve',
    append: 'append',
  };
  await ensureParentDirectory({ context, path });
  const handle = await context.files.open({ path, flags });
  try {
    await writeAllBytesToHandle({ handle, data: bytes });
  } finally {
    await handle.close();
  }
}

export async function writeOutputContent({
  context,
  path,
  content,
  expected,
}: {
  context: WeshCommandContext,
  path: string,
  content: PatchContent,
  expected: WeshEntryRef | undefined,
}): Promise<void> {
  if (path === '-') {
    await writePatchContentToHandle({ handle: context.stdout, content });
    return;
  }

  await publishPatchedEntry({
    context,
    targetPath: path,
    expected,
    kind: 'regular',
    content,
    mode: 0o644,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  basename,
  dirname,
  stripPatchPath,
};
