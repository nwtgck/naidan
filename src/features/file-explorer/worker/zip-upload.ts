import {
  StreamingZipReader,
  createBlobZipSource,
  createWebZipCompressionCodec,
  type ZipArchiveEntry,
} from '@/utils/zip-stream';
import { getFileExtension, getMimeCategory } from '@/features/file-explorer/logic/utils';
import {
  copyFileSystemFileHandle,
  isFileSystemEntryLookupMiss,
  writeReadableStreamToFileHandle,
} from '@/utils/file-system-stream';
import type {
  FileExplorerZipUploadPlacement,
  FileExplorerZipUploadPreviewAction,
  FileExplorerZipUploadPreviewEntry,
  FileExplorerZipUploadPreviewSummary,
} from './types';

const ZIP_UPLOAD_MAX_ENTRY_COUNT = 100_000;
const ZIP_UPLOAD_MAX_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024;
const ZIP_UPLOAD_MAX_PATH_DEPTH = 256;

export interface ParsedZipUploadEntry {
  readonly archiveEntry: ZipArchiveEntry,
  readonly path: string,
  readonly kind: 'file' | 'directory',
}

export interface ParsedZipUpload {
  readonly blob: Blob,
  readonly fileName: string,
  readonly entries: readonly ParsedZipUploadEntry[],
  readonly singleRootDirectoryName: string | undefined,
  readonly totalUncompressedSize: number,
}

function normalizeZipEntryPath({
  name,
  isDirectory,
}: {
  name: string,
  isDirectory: boolean,
}): string | undefined {
  if (name.includes('\0')) {
    throw new Error('ZIP entry name contains a NUL character');
  }
  const withForwardSlashes = name.replaceAll('\\', '/');
  if (
    withForwardSlashes.startsWith('/')
    || withForwardSlashes.startsWith('//')
    || /^[A-Za-z]:\//u.test(withForwardSlashes)
  ) {
    throw new Error(`ZIP entry uses an absolute path: ${name}`);
  }
  const segments = withForwardSlashes
    .split('/')
    .filter(segment => segment.length > 0 && segment !== '.');
  if (segments.some(segment => segment === '..')) {
    throw new Error(`ZIP entry escapes the target directory: ${name}`);
  }
  if (segments.length > ZIP_UPLOAD_MAX_PATH_DEPTH) {
    throw new Error(`ZIP entry path is too deep: ${name}`);
  }
  if (segments.length === 0) {
    if (isDirectory) {
      return undefined;
    }
    throw new Error(`ZIP file entry has an empty path: ${name}`);
  }
  return segments.join('/');
}

function detectSingleRootDirectoryName({
  entries,
}: {
  entries: readonly ParsedZipUploadEntry[],
}): string | undefined {
  const firstSegments = new Set<string>();
  let hasNestedEntry = false;
  for (const entry of entries) {
    const [first, ...rest] = entry.path.split('/');
    if (first === undefined) {
      continue;
    }
    firstSegments.add(first);
    if (rest.length > 0 || (entry.kind === 'directory' && entry.path === first)) {
      hasNestedEntry = true;
    }
  }
  if (firstSegments.size !== 1 || !hasNestedEntry) {
    return undefined;
  }
  return [...firstSegments][0];
}

function validateInternalPathKinds({
  entries,
}: {
  entries: readonly ParsedZipUploadEntry[],
}): void {
  const kinds = new Map<string, 'file' | 'directory'>();
  const caseFoldedPaths = new Map<string, string>();
  for (const entry of entries) {
    const existingKind = kinds.get(entry.path);
    if (existingKind !== undefined) {
      throw new Error(`ZIP contains a duplicate path: ${entry.path}`);
    }
    const segments = entry.path.split('/');
    for (let index = 1; index <= segments.length; index += 1) {
      const spelling = segments.slice(0, index).join('/');
      const folded = spelling.toLocaleLowerCase('en-US');
      const existingSpelling = caseFoldedPaths.get(folded);
      if (existingSpelling !== undefined && existingSpelling !== spelling) {
        throw new Error(`ZIP contains case-conflicting paths: ${existingSpelling}, ${spelling}`);
      }
      caseFoldedPaths.set(folded, spelling);
    }
    kinds.set(entry.path, entry.kind);
  }

  for (const entry of entries) {
    const segments = entry.path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const parentPath = segments.slice(0, index).join('/');
      const parentKind = kinds.get(parentPath);
      switch (parentKind) {
      case 'file':
        throw new Error(`ZIP file path is also used as a directory: ${parentPath}`);
      case 'directory':
      case undefined:
        break;
      default: {
        const _exhaustiveCheck: never = parentKind;
        throw new Error(`Unhandled ZIP parent kind: ${String(_exhaustiveCheck)}`);
      }
      }
    }
  }
}

export async function parseZipUpload({
  blob,
  fileName,
}: {
  blob: Blob,
  fileName: string,
}): Promise<ParsedZipUpload> {
  const source = createBlobZipSource({ blob });
  const reader = new StreamingZipReader({
    source,
    compressionCodec: createWebZipCompressionCodec(),
  });
  const entries: ParsedZipUploadEntry[] = [];
  let totalUncompressedSize = 0;

  try {
    for await (const archiveEntry of reader.entries()) {
      if (entries.length >= ZIP_UPLOAD_MAX_ENTRY_COUNT) {
        throw new Error('ZIP contains too many entries');
      }
      const path = normalizeZipEntryPath({
        name: archiveEntry.name,
        isDirectory: archiveEntry.isDirectory,
      });
      if (path === undefined) {
        continue;
      }
      totalUncompressedSize += archiveEntry.uncompressedSize;
      if (totalUncompressedSize > ZIP_UPLOAD_MAX_UNCOMPRESSED_BYTES) {
        throw new Error('ZIP uncompressed size exceeds the supported limit');
      }
      entries.push({
        archiveEntry,
        path,
        kind: archiveEntry.isDirectory ? 'directory' : 'file',
      });
    }
  } finally {
    await source.close();
  }

  validateInternalPathKinds({ entries });
  return {
    blob,
    fileName,
    entries,
    singleRootDirectoryName: detectSingleRootDirectoryName({ entries }),
    totalUncompressedSize,
  };
}

function mapArchivePath({
  path,
  placement,
  singleRootDirectoryName,
}: {
  path: string,
  placement: FileExplorerZipUploadPlacement,
  singleRootDirectoryName: string | undefined,
}): string | undefined {
  switch (placement.kind) {
  case 'keep_archive':
    return undefined;
  case 'extract':
    switch (placement.rootHandling) {
    case 'preserve':
    case 'not_applicable':
      return path;
    case 'strip': {
      if (singleRootDirectoryName === undefined) {
        throw new Error('Cannot strip a ZIP without a single root directory');
      }
      if (path === singleRootDirectoryName) {
        return undefined;
      }
      const prefix = `${singleRootDirectoryName}/`;
      if (!path.startsWith(prefix)) {
        throw new Error(`ZIP entry is outside the single root directory: ${path}`);
      }
      return path.slice(prefix.length);
    }
    default: {
      const _exhaustiveCheck: never = placement.rootHandling;
      throw new Error(`Unhandled ZIP root handling: ${String(_exhaustiveCheck)}`);
    }
    }
  default: {
    const _exhaustiveCheck: never = placement;
    throw new Error(`Unhandled ZIP placement: ${String(_exhaustiveCheck)}`);
  }
  }
}

interface PreviewChild {
  readonly name: string,
  readonly path: string,
  readonly kind: 'file' | 'directory',
  readonly size: number | undefined,
  readonly lastModified: number | undefined,
}

function listArchivePreviewChildren({
  analysis,
  placement,
  relativePath,
}: {
  analysis: ParsedZipUpload,
  placement: FileExplorerZipUploadPlacement,
  relativePath: string,
}): PreviewChild[] {
  switch (placement.kind) {
  case 'keep_archive':
    if (relativePath !== '') {
      return [];
    }
    return [{
      name: analysis.fileName,
      path: analysis.fileName,
      kind: 'file',
      size: analysis.blob.size,
      lastModified: undefined,
    }];
  case 'extract':
    break;
  default: {
    const _exhaustiveCheck: never = placement;
    throw new Error(`Unhandled ZIP placement: ${String(_exhaustiveCheck)}`);
  }
  }

  const prefix = relativePath === '' ? '' : `${relativePath}/`;
  const children = new Map<string, PreviewChild>();
  for (const entry of analysis.entries) {
    const mappedPath = mapArchivePath({
      path: entry.path,
      placement,
      singleRootDirectoryName: analysis.singleRootDirectoryName,
    });
    if (mappedPath === undefined || !mappedPath.startsWith(prefix)) {
      continue;
    }
    const remainder = mappedPath.slice(prefix.length);
    if (remainder.length === 0) {
      continue;
    }
    const [name, ...rest] = remainder.split('/');
    if (name === undefined) {
      continue;
    }
    const childPath = relativePath === '' ? name : `${relativePath}/${name}`;
    const isSynthesizedDirectory = rest.length > 0;
    const kind = isSynthesizedDirectory ? 'directory' : entry.kind;
    const existing = children.get(name);
    if (existing !== undefined) {
      switch (existing.kind) {
      case 'directory':
        continue;
      case 'file':
        break;
      default: {
        const _exhaustiveCheck: never = existing.kind;
        throw new Error(`Unhandled existing preview child kind: ${String(_exhaustiveCheck)}`);
      }
      }
    }
    let size: number | undefined;
    let lastModified: number | undefined;
    switch (kind) {
    case 'file':
      size = entry.archiveEntry.uncompressedSize;
      lastModified = entry.archiveEntry.modifiedAt.getTime();
      break;
    case 'directory':
      size = undefined;
      lastModified = undefined;
      break;
    default: {
      const _exhaustiveCheck: never = kind;
      throw new Error(`Unhandled preview child kind: ${String(_exhaustiveCheck)}`);
    }
    }
    children.set(name, {
      name,
      path: childPath,
      kind,
      size,
      lastModified,
    });
  }
  return [...children.values()];
}

function toPreviewAction({
  existingKind,
  plannedKind,
}: {
  existingKind: 'file' | 'directory' | undefined,
  plannedKind: 'file' | 'directory' | undefined,
}): FileExplorerZipUploadPreviewAction {
  if (plannedKind === undefined) {
    return 'existing';
  }
  if (existingKind === undefined) {
    return 'add';
  }
  if (existingKind !== plannedKind) {
    return 'blocked';
  }
  switch (plannedKind) {
  case 'directory':
    return 'merge';
  case 'file':
    return 'replace';
  default: {
    const _exhaustiveCheck: never = plannedKind;
    throw new Error(`Unhandled planned entry kind: ${String(_exhaustiveCheck)}`);
  }
  }
}

export async function buildZipUploadPreview({
  analysis,
  placement,
  relativePath,
  existingEntries,
  blockedPaths,
}: {
  analysis: ParsedZipUpload,
  placement: FileExplorerZipUploadPlacement,
  relativePath: string,
  existingEntries: readonly PreviewChild[],
  blockedPaths: ReadonlySet<string>,
}): Promise<{
  entries: FileExplorerZipUploadPreviewEntry[],
  summary: FileExplorerZipUploadPreviewSummary,
}> {
  const archiveChildren = listArchivePreviewChildren({ analysis, placement, relativePath });
  const blockedPreviewPaths = new Set<string>();
  for (const blockedPath of blockedPaths) {
    const segments = blockedPath.split('/');
    for (let index = 1; index <= segments.length; index += 1) {
      blockedPreviewPaths.add(segments.slice(0, index).join('/'));
    }
  }
  const existingByName = new Map(existingEntries.map(entry => [entry.name, entry]));
  const plannedByName = new Map(archiveChildren.map(entry => [entry.name, entry]));
  const names = new Set([...existingByName.keys(), ...plannedByName.keys()]);
  const entries: FileExplorerZipUploadPreviewEntry[] = [];
  const summary: FileExplorerZipUploadPreviewSummary = {
    addedCount: 0,
    mergedCount: 0,
    replacedCount: 0,
    blockedCount: 0,
  };

  for (const name of names) {
    const existing = existingByName.get(name);
    const planned = plannedByName.get(name);
    const action = planned !== undefined && blockedPreviewPaths.has(planned.path)
      ? 'blocked'
      : toPreviewAction({
        existingKind: existing?.kind,
        plannedKind: planned?.kind,
      });
    switch (action) {
    case 'add':
      summary.addedCount += 1;
      break;
    case 'merge':
      summary.mergedCount += 1;
      break;
    case 'replace':
      summary.replacedCount += 1;
      break;
    case 'blocked':
      summary.blockedCount += 1;
      break;
    case 'existing':
      break;
    default: {
      const _exhaustiveCheck: never = action;
      throw new Error(`Unhandled ZIP preview action: ${String(_exhaustiveCheck)}`);
    }
    }
    const chosen = planned ?? existing;
    if (chosen === undefined) {
      continue;
    }
    let extension: string;
    let canNavigate: boolean;
    switch (chosen.kind) {
    case 'file':
      extension = getFileExtension({ name });
      canNavigate = false;
      break;
    case 'directory':
      extension = '';
      canNavigate = true;
      break;
    default: {
      const _exhaustiveCheck: never = chosen.kind;
      throw new Error(`Unhandled chosen preview kind: ${String(_exhaustiveCheck)}`);
    }
    }
    entries.push({
      path: chosen.path,
      name,
      kind: chosen.kind,
      size: planned?.size ?? existing?.size,
      lastModified: planned?.lastModified ?? existing?.lastModified,
      extension,
      mimeCategory: getMimeCategory({ extension }),
      action,
      canNavigate,
    });
  }

  entries.sort((left, right) => {
    if (left.kind !== right.kind) {
      switch (left.kind) {
      case 'directory':
        return -1;
      case 'file':
        return 1;
      default: {
        const _exhaustiveCheck: never = left.kind;
        throw new Error(`Unhandled preview entry kind: ${String(_exhaustiveCheck)}`);
      }
      }
    }
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  return { entries, summary };
}

async function getDirectoryAtRelativePath({
  root,
  relativePath,
  create,
}: {
  root: FileSystemDirectoryHandle,
  relativePath: string,
  create: boolean,
}): Promise<FileSystemDirectoryHandle> {
  let current = root;
  if (relativePath === '') {
    return current;
  }
  for (const segment of relativePath.split('/')) {
    current = await current.getDirectoryHandle(segment, { create });
  }
  return current;
}

async function getFileAtRelativePath({
  root,
  relativePath,
  create,
}: {
  root: FileSystemDirectoryHandle,
  relativePath: string,
  create: boolean,
}): Promise<FileSystemFileHandle> {
  const segments = relativePath.split('/');
  const name = segments.pop();
  if (name === undefined || name.length === 0) {
    throw new Error(`Invalid file path: ${relativePath}`);
  }
  const parent = await getDirectoryAtRelativePath({
    root,
    relativePath: segments.join('/'),
    create,
  });
  return parent.getFileHandle(name, { create });
}

async function existingHandleKind({
  root,
  relativePath,
}: {
  root: FileSystemDirectoryHandle,
  relativePath: string,
}): Promise<'file' | 'directory' | undefined> {
  try {
    await getFileAtRelativePath({ root, relativePath, create: false });
    return 'file';
  } catch (error) {
    if (!isFileSystemEntryLookupMiss({ error })) {
      throw error;
    }
  }
  try {
    await getDirectoryAtRelativePath({ root, relativePath, create: false });
    return 'directory';
  } catch (error) {
    if (!isFileSystemEntryLookupMiss({ error })) {
      throw error;
    }
    return undefined;
  }
}

function buildPlannedChildrenByDirectory({
  analysis,
  placement,
}: {
  analysis: ParsedZipUpload,
  placement: FileExplorerZipUploadPlacement,
}): Map<string, Map<string, 'file' | 'directory'>> {
  const childrenByDirectory = new Map<string, Map<string, 'file' | 'directory'>>();

  function addMappedPath({ path, kind }: { path: string, kind: 'file' | 'directory' }): void {
    const segments = path.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index];
      if (name === undefined) {
        continue;
      }
      const parentPath = segments.slice(0, index).join('/');
      const childKind = index === segments.length - 1 ? kind : 'directory';
      let children = childrenByDirectory.get(parentPath);
      if (children === undefined) {
        children = new Map();
        childrenByDirectory.set(parentPath, children);
      }
      const existingKind = children.get(name);
      if (existingKind === 'file' && childKind === 'directory') {
        throw new Error(`ZIP file path is also used as a directory: ${path}`);
      }
      children.set(name, childKind);
    }
  }

  switch (placement.kind) {
  case 'keep_archive':
    addMappedPath({ path: analysis.fileName, kind: 'file' });
    break;
  case 'extract':
    for (const entry of analysis.entries) {
      const mappedPath = mapArchivePath({
        path: entry.path,
        placement,
        singleRootDirectoryName: analysis.singleRootDirectoryName,
      });
      if (mappedPath === undefined) {
        continue;
      }
      addMappedPath({ path: mappedPath, kind: entry.kind });
    }
    break;
  default: {
    const _exhaustiveCheck: never = placement;
    throw new Error(`Unhandled ZIP placement: ${String(_exhaustiveCheck)}`);
  }
  }
  return childrenByDirectory;
}

export interface ZipUploadTargetInspection {
  readonly blockedPaths: Set<string>,
  readonly fingerprint: string,
}

export async function inspectZipUploadTarget({
  analysis,
  placement,
  targetDirectory,
}: {
  analysis: ParsedZipUpload,
  placement: FileExplorerZipUploadPlacement,
  targetDirectory: FileSystemDirectoryHandle,
}): Promise<ZipUploadTargetInspection> {
  const childrenByDirectory = buildPlannedChildrenByDirectory({ analysis, placement });
  const blockedPaths = new Set<string>();
  const fingerprintParts: string[] = [];

  async function compareDirectory({
    target,
    relativePath,
  }: {
    target: FileSystemDirectoryHandle,
    relativePath: string,
  }): Promise<void> {
    const plannedChildren = childrenByDirectory.get(relativePath);
    if (plannedChildren === undefined) {
      return;
    }
    const existingChildren = new Map<string, FileSystemHandle>();
    for await (const child of target.values()) {
      existingChildren.set(child.name, child);
    }
    for (const [name, plannedKind] of plannedChildren) {
      const existing = existingChildren.get(name);
      const childPath = relativePath === '' ? name : `${relativePath}/${name}`;
      if (existing === undefined) {
        fingerprintParts.push(`${childPath}\0missing`);
        continue;
      }
      switch (existing.kind) {
      case 'file': {
        const file = await (existing as FileSystemFileHandle).getFile();
        fingerprintParts.push(`${childPath}\0file\0${file.size}\0${file.lastModified}`);
        break;
      }
      case 'directory':
        fingerprintParts.push(`${childPath}\0directory`);
        break;
      default:
        throw new Error(`Unhandled existing target kind: ${String(existing.kind)}`);
      }
      if (existing.kind !== plannedKind) {
        blockedPaths.add(childPath);
        continue;
      }
      switch (plannedKind) {
      case 'file':
        break;
      case 'directory':
        await compareDirectory({
          target: existing as FileSystemDirectoryHandle,
          relativePath: childPath,
        });
        break;
      default: {
        const _exhaustiveCheck: never = plannedKind;
        throw new Error(`Unhandled planned entry kind: ${String(_exhaustiveCheck)}`);
      }
      }
    }
  }

  await compareDirectory({ target: targetDirectory, relativePath: '' });
  fingerprintParts.sort();
  return {
    blockedPaths,
    fingerprint: fingerprintParts.join('\n'),
  };
}

type JournalEntry =
  | { readonly kind: 'created-file', readonly path: string }
  | { readonly kind: 'created-directory', readonly path: string }
  | { readonly kind: 'replaced-file', readonly path: string, readonly backupPath: string };

async function copyDirectoryContentsWithJournal({
  source,
  target,
  backupRoot,
  relativePath,
  journal,
  signal,
}: {
  source: FileSystemDirectoryHandle,
  target: FileSystemDirectoryHandle,
  backupRoot: FileSystemDirectoryHandle,
  relativePath: string,
  journal: JournalEntry[],
  signal: AbortSignal,
}): Promise<void> {
  for await (const child of source.values()) {
    signal.throwIfAborted();
    const childPath = relativePath === '' ? child.name : `${relativePath}/${child.name}`;
    switch (child.kind) {
    case 'directory': {
      const currentKind = await existingHandleKind({ root: target, relativePath: child.name });
      switch (currentKind) {
      case 'file':
        throw new DOMException(`Target entry type changed: ${childPath}`, 'InvalidStateError');
      case 'directory':
      case undefined:
        break;
      default: {
        const _exhaustiveCheck: never = currentKind;
        throw new Error(`Unhandled current directory entry kind: ${String(_exhaustiveCheck)}`);
      }
      }
      const targetChild = await target.getDirectoryHandle(child.name, { create: true });
      if (currentKind === undefined) {
        journal.push({ kind: 'created-directory', path: childPath });
      }
      await copyDirectoryContentsWithJournal({
        source: child as FileSystemDirectoryHandle,
        target: targetChild,
        backupRoot,
        relativePath: childPath,
        journal,
        signal,
      });
      break;
    }
    case 'file': {
      const currentKind = await existingHandleKind({ root: target, relativePath: child.name });
      let targetFile: FileSystemFileHandle;
      switch (currentKind) {
      case 'directory':
        throw new DOMException(`Target entry type changed: ${childPath}`, 'InvalidStateError');
      case 'file': {
        targetFile = await target.getFileHandle(child.name);
        const backupFile = await getFileAtRelativePath({
          root: backupRoot,
          relativePath: childPath,
          create: true,
        });
        await copyFileSystemFileHandle({
          sourceHandle: targetFile,
          targetHandle: backupFile,
          signal,
        });
        journal.push({ kind: 'replaced-file', path: childPath, backupPath: childPath });
        break;
      }
      case undefined:
        targetFile = await target.getFileHandle(child.name, { create: true });
        journal.push({ kind: 'created-file', path: childPath });
        break;
      default: {
        const _exhaustiveCheck: never = currentKind;
        throw new Error(`Unhandled current file entry kind: ${String(_exhaustiveCheck)}`);
      }
      }
      await copyFileSystemFileHandle({
        sourceHandle: child as FileSystemFileHandle,
        targetHandle: targetFile,
        signal,
      });
      break;
    }
    default: {
      const _exhaustiveCheck: never = child;
      throw new Error(`Unhandled staged child: ${String(_exhaustiveCheck)}`);
    }
    }
  }
}

async function rollbackJournal({
  targetRoot,
  backupRoot,
  journal,
}: {
  targetRoot: FileSystemDirectoryHandle,
  backupRoot: FileSystemDirectoryHandle,
  journal: readonly JournalEntry[],
}): Promise<void> {
  const rollbackErrors: unknown[] = [];
  for (const entry of [...journal].reverse()) {
    try {
      switch (entry.kind) {
      case 'created-file': {
        const segments = entry.path.split('/');
        const name = segments.pop();
        if (name !== undefined) {
          const parent = await getDirectoryAtRelativePath({
            root: targetRoot,
            relativePath: segments.join('/'),
            create: false,
          });
          await parent.removeEntry(name);
        }
        break;
      }
      case 'created-directory': {
        const segments = entry.path.split('/');
        const name = segments.pop();
        if (name !== undefined) {
          const parent = await getDirectoryAtRelativePath({
            root: targetRoot,
            relativePath: segments.join('/'),
            create: false,
          });
          await parent.removeEntry(name);
        }
        break;
      }
      case 'replaced-file': {
        const backup = await getFileAtRelativePath({
          root: backupRoot,
          relativePath: entry.backupPath,
          create: false,
        });
        const target = await getFileAtRelativePath({
          root: targetRoot,
          relativePath: entry.path,
          create: true,
        });
        await copyFileSystemFileHandle({
          sourceHandle: backup,
          targetHandle: target,
          signal: undefined,
        });
        break;
      }
      default: {
        const _exhaustiveCheck: never = entry;
        throw new Error(`Unhandled upload journal entry: ${String(_exhaustiveCheck)}`);
      }
      }
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if (rollbackErrors.length > 0) {
    throw new AggregateError(rollbackErrors, 'Some ZIP upload changes could not be restored');
  }
}

async function createTemporaryUploadDirectory({
  targetDirectory,
  jobId,
}: {
  targetDirectory: FileSystemDirectoryHandle,
  jobId: string,
}): Promise<{
  name: string,
  handle: FileSystemDirectoryHandle,
}> {
  const sanitizedJobId = jobId.replaceAll(/[^A-Za-z0-9_-]/gu, '_');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? '' : `_${attempt}`;
    const name = `.__naidan_zip_upload_${sanitizedJobId}${suffix}`;
    const existingKind = await existingHandleKind({ root: targetDirectory, relativePath: name });
    if (existingKind !== undefined) {
      continue;
    }
    return {
      name,
      handle: await targetDirectory.getDirectoryHandle(name, { create: true }),
    };
  }
  throw new DOMException('Could not reserve a temporary ZIP upload directory', 'InvalidStateError');
}

export async function executeParsedZipUpload({
  analysis,
  placement,
  targetDirectory,
  jobId,
  expectedFingerprint,
  signal,
}: {
  analysis: ParsedZipUpload,
  placement: FileExplorerZipUploadPlacement,
  targetDirectory: FileSystemDirectoryHandle,
  jobId: string,
  expectedFingerprint: string,
  signal: AbortSignal,
}): Promise<'completed' | 'preview-outdated'> {
  const inspection = await inspectZipUploadTarget({ analysis, placement, targetDirectory });
  if (
    inspection.blockedPaths.size > 0
    || inspection.fingerprint !== expectedFingerprint
  ) {
    return 'preview-outdated';
  }

  const temporaryDirectory = await createTemporaryUploadDirectory({ targetDirectory, jobId });
  const temporaryName = temporaryDirectory.name;
  const temporaryRoot = temporaryDirectory.handle;
  const journal: JournalEntry[] = [];
  let backupRoot: FileSystemDirectoryHandle | undefined;
  let source: ReturnType<typeof createBlobZipSource> | undefined;

  try {
    const stagedRoot = await temporaryRoot.getDirectoryHandle('staged', { create: true });
    backupRoot = await temporaryRoot.getDirectoryHandle('backup', { create: true });
    switch (placement.kind) {
    case 'keep_archive': {
      const stagedArchive = await getFileAtRelativePath({
        root: stagedRoot,
        relativePath: analysis.fileName,
        create: true,
      });
      await writeReadableStreamToFileHandle({
        source: analysis.blob.stream(),
        targetHandle: stagedArchive,
        signal,
      });
      break;
    }
    case 'extract': {
      source = createBlobZipSource({ blob: analysis.blob });
      const reader = new StreamingZipReader({
        source,
        compressionCodec: createWebZipCompressionCodec(),
      });
      for (const entry of analysis.entries) {
        signal.throwIfAborted();
        const mappedPath = mapArchivePath({
          path: entry.path,
          placement,
          singleRootDirectoryName: analysis.singleRootDirectoryName,
        });
        if (mappedPath === undefined) {
          continue;
        }
        switch (entry.kind) {
        case 'directory':
          await getDirectoryAtRelativePath({
            root: stagedRoot,
            relativePath: mappedPath,
            create: true,
          });
          break;
        case 'file': {
          const target = await getFileAtRelativePath({
            root: stagedRoot,
            relativePath: mappedPath,
            create: true,
          });
          await writeReadableStreamToFileHandle({
            source: await reader.openEntry({ entry: entry.archiveEntry }),
            targetHandle: target,
            signal,
          });
          break;
        }
        default: {
          const _exhaustiveCheck: never = entry.kind;
          throw new Error(`Unhandled ZIP entry kind: ${String(_exhaustiveCheck)}`);
        }
        }
      }
      break;
    }
    default: {
      const _exhaustiveCheck: never = placement;
      throw new Error(`Unhandled ZIP placement: ${String(_exhaustiveCheck)}`);
    }
    }

    const commitInspection = await inspectZipUploadTarget({
      analysis,
      placement,
      targetDirectory,
    });
    if (
      commitInspection.blockedPaths.size > 0
      || commitInspection.fingerprint !== expectedFingerprint
    ) {
      await targetDirectory.removeEntry(temporaryName, { recursive: true });
      return 'preview-outdated';
    }

    await copyDirectoryContentsWithJournal({
      source: stagedRoot,
      target: targetDirectory,
      backupRoot,
      relativePath: '',
      journal,
      signal,
    });
    await targetDirectory.removeEntry(temporaryName, { recursive: true });
    return 'completed';
  } catch (error) {
    let rollbackError: unknown;
    if (backupRoot !== undefined) {
      try {
        await rollbackJournal({
          targetRoot: targetDirectory,
          backupRoot,
          journal,
        });
      } catch (caughtRollbackError) {
        rollbackError = caughtRollbackError;
      }
    }
    let cleanupError: unknown;
    try {
      await targetDirectory.removeEntry(temporaryName, { recursive: true });
    } catch (caughtCleanupError) {
      cleanupError = caughtCleanupError;
    }
    const recoveryErrors = [rollbackError, cleanupError].filter(value => value !== undefined);
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        'ZIP upload failed and cleanup or restoration was incomplete',
      );
    }
    if (error instanceof DOMException && error.name === 'InvalidStateError') {
      return 'preview-outdated';
    }
    throw error;
  } finally {
    await source?.close();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
