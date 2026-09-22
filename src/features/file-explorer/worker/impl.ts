import { readVirtualFileBlob, readVirtualFileText } from './virtual-file-content';
import { BlobViewZipReadError } from '@/utils/blob-view-zip-source';
import { createNativeFileCopy, createNativeFileWriteScope } from './native-file-writes';
import { createWorkerBlobContext } from '@/utils/worker-blob-context';
import type { BlobContext } from '@/utils/blob-view';

import { releaseWorkerProxyArgument, type WorkerServerApi } from '@/utils/worker-transport';
import { WeshVFS } from '@/features/wesh/vfs';
import { openFileReadStream } from '@/features/wesh/utils/fs';
import { NaidanSysfsProvider } from '@/features/wesh/naidan-sysfs/provider';
import {
  createOpfsNaidanSysfsStorageReader,
  createRemoteNaidanSysfsStorageReader,
} from '@/features/wesh/naidan-sysfs/storage-reader';
import { EXTENSION_LANGUAGE_MAP, MEDIA_PREVIEW_SIZE_LIMIT, TEXT_PREVIEW_SIZE_LIMIT } from '@/features/file-explorer/logic/constants';
import { getFileExtension, getMimeCategory } from '@/features/file-explorer/logic/utils';
import {
  isDirectoryDownloadPathExcluded,
  isSafeDirectoryDownloadPathSegment,
  normalizeDirectoryDownloadRelativePath,
} from '@/features/file-explorer/logic/directory-download';
import {
  createFileExplorerDirectoryArchive,
  type FileExplorerDirectoryArchiveAccess,
  type FileExplorerDirectoryArchiveSourceEntry,
} from './directory-archive';
import {
  buildZipUploadPreview,
  executeParsedZipUpload,
  ZipUploadRecoveryError,
  inspectZipUploadTarget,
  parseZipUpload,
  type ParsedZipUpload,
} from './zip-upload';
import { isFileSystemEntryLookupMiss } from '@/utils/file-system-stream';
import { createFileSystemDirectoryHandleReferenceResolver } from '@/utils/file-system-handle-transport';
import type { NaidanSysfsRemoteReader } from '@/features/wesh/naidan-sysfs/types';
import {
  fileExplorerCancelDirectoryArchiveRequestSchema,
  fileExplorerAnalyzeZipUploadRequestSchema,
  fileExplorerAnalyzeZipUploadResponseSchema,
  fileExplorerCancelZipUploadRequestSchema,
  fileExplorerDisposeZipUploadAnalysisRequestSchema,
  fileExplorerExecuteZipUploadRequestSchema,
  fileExplorerExecuteZipUploadResponseSchema,
  fileExplorerReadZipUploadPreviewDirectoryRequestSchema,
  fileExplorerReadZipUploadPreviewDirectoryResponseSchema,
  fileExplorerCreateDirectoryArchiveRequestSchema,
  fileExplorerCreateDirectoryArchiveResponseSchema,
  fileExplorerCreateFileRequestSchema,
  fileExplorerCreateFolderRequestSchema,
  fileExplorerDeleteEntriesRequestSchema,
  fileExplorerDisposeSessionRequestSchema,
  fileExplorerPathSegmentSchema,
  fileExplorerPrepareSessionRequestSchema,
  fileExplorerPrepareSessionResponseSchema,
  fileExplorerReadDirectoryRequestSchema,
  fileExplorerReadDirectoryResponseSchema,
  fileExplorerReadFileRequestSchema,
  fileExplorerReadFileResponseSchema,
  fileExplorerReadPreviewRequestSchema,
  fileExplorerReadPreviewResponseSchema,
  fileExplorerRenameEntryRequestSchema,
  fileExplorerTransferEntriesRequestSchema,
  fileExplorerSuggestArchiveExclusionsRequestSchema,
  fileExplorerSuggestArchiveExclusionsResponseSchema,
  fileExplorerUploadFilesRequestSchema,
  type FileExplorerEntryRecord,
  type FileExplorerPathSegment,
  type FileExplorerRootDescriptor,
  type FileExplorerZipUploadPlacement,
  type IFileExplorerWorker,
} from './types';

type FileExplorerSession = {
  naidanSysfsRemoteReader: NaidanSysfsRemoteReader | undefined,
  blobs: BlobContext,
  reads: AbortController,
  zipTasks: Set<Promise<void>>,
  copyFile: ReturnType<typeof createNativeFileCopy>,
  writes: ReturnType<typeof createNativeFileWriteScope>,
} & (
  | {
    kind: 'native-directory',
    rootName: string,
    rootHandle: FileSystemDirectoryHandle,
    readOnly: boolean,
  }
  | {
    kind: 'wesh-mounts',
    rootName: string,
    vfs: WeshVFS,
  }
);

type ResolvedDirectory =
  | {
    kind: 'native-directory',
    name: string,
    path: string,
    handle: FileSystemDirectoryHandle,
    readOnly: boolean,
  }
  | {
    kind: 'virtual-directory',
    name: string,
    path: string,
    readOnly: boolean,
  };

type ResolvedFile = {
  kind: 'native-file',
  name: string,
  path: string,
  handle: FileSystemFileHandle,
  readOnly: boolean,
};

type ResolvedVirtualFile = {
  kind: 'virtual-file',
  name: string,
  path: string,
  readOnly: boolean,
  vfs: WeshVFS,
};

const sessions = new Map<string, FileExplorerSession>();
const sessionDisposals = new Map<string, Promise<void>>();
const directoryArchiveJobs = new Map<string, AbortController>();
const zipUploadJobs = new Map<string, AbortController>();
const zipAnalysisJobs = new Map<string, AbortController>();
const zipUploadAnalyses = new Map<string, {
  readonly targetDirectoryPath: string,
  readonly analysis: ParsedZipUpload,
  readonly previewFingerprints: Map<string, string>,
}>();

/** Track cleanup, not success: rollback must finish before releasing the shared host. */
function trackZipTask({ session }: { session: FileExplorerSession }): () => void {
  let finish: () => void = () => undefined;
  const settled = new Promise<void>(resolve => {
    finish = resolve;
  });
  session.zipTasks.add(settled);
  return () => {
    session.zipTasks.delete(settled);
    finish();
  };
}

function createZipUploadKey({ sessionId, id }: { sessionId: string, id: string }): string {
  return `${sessionId}\0${id}`;
}

function createZipUploadPlacementKey({
  placement,
}: {
  placement: FileExplorerZipUploadPlacement,
}): string {
  switch (placement.kind) {
  case 'keep_archive':
    return 'keep_archive';
  case 'extract':
    return `extract:${placement.rootHandling}`;
  default: {
    const _exhaustiveCheck: never = placement;
    throw new Error(`Unhandled ZIP upload placement: ${String(_exhaustiveCheck)}`);
  }
  }
}

function createDirectoryArchiveJobKey({ sessionId, jobId }: { sessionId: string, jobId: string }): string {
  return `${sessionId}\0${jobId}`;
}

function normalizeArchiveExcludedRelativePaths({ paths }: { paths: readonly string[] }): string[] {
  const normalizedPaths = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeDirectoryDownloadRelativePath({ path });
    if (normalized === undefined) {
      throw new Error(`Invalid archive exclusion path: ${path}`);
    }
    normalizedPaths.add(normalized);
  }
  return [...normalizedPaths];
}

function createSessionId(): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `file-explorer-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeExplorerPath({ path }: { path: string }): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') {
    return '/';
  }
  return `/${trimmed.split('/').filter(segment => segment.length > 0).join('/')}`;
}

function splitExplorerPath({ path }: { path: string }): string[] {
  const normalized = normalizeExplorerPath({ path });
  if (normalized === '/') {
    return [];
  }
  return normalized.slice(1).split('/');
}

function joinExplorerPath({ parentPath, name }: { parentPath: string, name: string }): string {
  const normalizedParentPath = normalizeExplorerPath({ path: parentPath });
  return normalizedParentPath === '/' ? `/${name}` : `${normalizedParentPath}/${name}`;
}

function getBaseNameFromPath({ path, rootName }: { path: string, rootName: string }): string {
  const segments = splitExplorerPath({ path });
  return segments.at(-1) ?? rootName;
}

function getParentPath({ path }: { path: string }): string {
  const segments = splitExplorerPath({ path });
  if (segments.length <= 1) {
    return '/';
  }
  return `/${segments.slice(0, -1).join('/')}`;
}

function getSession({ sessionId }: { sessionId: string }): FileExplorerSession {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`File explorer session not found: ${sessionId}`);
  }
  return session;
}

async function createSessionFromRoot({
  root,
  naidanSysfsRemoteReader,
  blobs,
}: {
  root: FileExplorerRootDescriptor,
  blobs: BlobContext,
  naidanSysfsRemoteReader: NaidanSysfsRemoteReader | undefined,
}): Promise<FileExplorerSession> {
  const directoryHandleResolver = createFileSystemDirectoryHandleReferenceResolver();
  const writes = createNativeFileWriteScope({ blobs });
  const reads = new AbortController();
  const zipTasks = new Set<Promise<void>>();
  const copyFile = createNativeFileCopy({ blobs });
  switch (root.kind) {
  case 'opfs-root':
    return {
      kind: 'native-directory',
      blobs,
      naidanSysfsRemoteReader,
      reads,
      zipTasks,
      copyFile,
      writes,
      rootName: root.rootName,
      rootHandle: await navigator.storage.getDirectory(),
      readOnly: false,
    };
  case 'native-directory':
    return {
      kind: 'native-directory',
      blobs,
      naidanSysfsRemoteReader,
      reads,
      zipTasks,
      copyFile,
      writes,
      rootName: root.rootName,
      rootHandle: await directoryHandleResolver.resolve({ reference: root.handle }),
      readOnly: root.readOnly,
    };
  case 'wesh-mounts': {
    const vfs = new WeshVFS({ rootHandle: undefined, blobs });
    for (const mount of root.mounts) {
      switch (mount.type) {
      case 'directory':
        await vfs.mount({
          path: mount.path,
          handle: await directoryHandleResolver.resolve({ reference: mount.handle }),
          readOnly: mount.readOnly,
        });
        break;
      case 'naidan_sysfs': {
        const reader = await (() => {
          switch (mount.storageType) {
          case 'opfs':
            return createOpfsNaidanSysfsStorageReader({ blobs });
          case 'local':
          case 'memory':
            if (naidanSysfsRemoteReader === undefined) {
              throw new Error(`Naidan sysfs remote reader is required for ${mount.storageType} storage`);
            }
            return createRemoteNaidanSysfsStorageReader({
              remoteReader: naidanSysfsRemoteReader,
            });
          default: {
            const _exhaustiveCheck: never = mount.storageType;
            throw new Error(`Unhandled naidan sysfs storage type: ${String(_exhaustiveCheck)}`);
          }
          }
        })();

        vfs.mountVirtual({
          path: mount.path,
          readOnly: mount.readOnly,
          provider: new NaidanSysfsProvider({
            reader,
            blobs,
            visibility: mount.visibility,
            binaryObjectAccess: mount.binaryObjectAccess,
            currentChatId: mount.currentChatId,
            currentChatGroupId: mount.currentChatGroupId,
          }),
        });
        break;
      }
      default: {
        const _exhaustiveCheck: never = mount;
        throw new Error(`Unhandled wesh mount: ${String(_exhaustiveCheck)}`);
      }
      }
    }
    return {
      kind: 'wesh-mounts',
      blobs,
      naidanSysfsRemoteReader,
      reads,
      zipTasks,
      copyFile,
      writes,
      rootName: root.rootName,
      vfs,
    };
  }
  default: {
    const _exhaustiveCheck: never = root;
    throw new Error(`Unhandled root descriptor: ${String(_exhaustiveCheck)}`);
  }
  }
}

async function resolveNativeDirectoryHandle({
  rootHandle,
  path,
}: {
  rootHandle: FileSystemDirectoryHandle,
  path: string,
}): Promise<FileSystemDirectoryHandle> {
  let current = rootHandle;
  for (const segment of splitExplorerPath({ path })) {
    current = await current.getDirectoryHandle(segment);
  }
  return current;
}

async function resolveNativeDirectory({
  rootHandle,
  rootName,
  readOnly,
  path,
}: {
  rootHandle: FileSystemDirectoryHandle,
  rootName: string,
  readOnly: boolean,
  path: string,
}): Promise<ResolvedDirectory> {
  const normalizedPath = normalizeExplorerPath({ path });
  const handle = await resolveNativeDirectoryHandle({ rootHandle, path: normalizedPath });
  return {
    kind: 'native-directory',
    name: getBaseNameFromPath({ path: normalizedPath, rootName }),
    path: normalizedPath,
    handle,
    readOnly,
  };
}

async function resolveWeshDirectory({
  vfs,
  rootName,
  path,
}: {
  vfs: WeshVFS,
  rootName: string,
  path: string,
}): Promise<ResolvedDirectory> {
  const normalizedPath = normalizeExplorerPath({ path });
  const stat = await vfs.stat({ path: normalizedPath });
  switch (stat.type) {
  case 'directory':
    break;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new DOMException(`Expected a directory: ${normalizedPath}`, 'TypeMismatchError');
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled virtual file type: ${String(_ex)}`);
  }
  }

  const nativeHandle = await vfs.getNativeHandle({ path: normalizedPath });
  if (nativeHandle !== null && nativeHandle.kind === 'directory') {
    return {
      kind: 'native-directory',
      name: getBaseNameFromPath({ path: normalizedPath, rootName }),
      path: normalizedPath,
      handle: nativeHandle as FileSystemDirectoryHandle,
      readOnly: vfs.getReadOnlyForPath({ path: normalizedPath }),
    };
  }

  return {
    kind: 'virtual-directory',
    name: getBaseNameFromPath({ path: normalizedPath, rootName }),
    path: normalizedPath,
    readOnly: true,
  };
}

async function resolveDirectory({
  session,
  path,
}: {
  session: FileExplorerSession,
  path: string,
}): Promise<ResolvedDirectory> {
  switch (session.kind) {
  case 'native-directory':
    return resolveNativeDirectory({
      rootHandle: session.rootHandle,
      rootName: session.rootName,
      readOnly: session.readOnly,
      path,
    });
  case 'wesh-mounts':
    return resolveWeshDirectory({
      vfs: session.vfs,
      rootName: session.rootName,
      path,
    });
  default: {
    const _exhaustiveCheck: never = session;
    throw new Error(`Unhandled file explorer session: ${String(_exhaustiveCheck)}`);
  }
  }
}

async function resolveFile({
  session,
  path,
}: {
  session: FileExplorerSession,
  path: string,
}): Promise<ResolvedFile | ResolvedVirtualFile> {
  const normalizedPath = normalizeExplorerPath({ path });
  const name = getBaseNameFromPath({
    path: normalizedPath,
    rootName: session.rootName,
  });

  switch (session.kind) {
  case 'native-directory': {
    const parentHandle = await resolveNativeDirectoryHandle({
      rootHandle: session.rootHandle,
      path: getParentPath({ path: normalizedPath }),
    });
    const handle = await parentHandle.getFileHandle(name);
    return {
      kind: 'native-file',
      name,
      path: normalizedPath,
      handle,
      readOnly: session.readOnly,
    };
  }
  case 'wesh-mounts': {
    const nativeHandle = await session.vfs.getNativeHandle({ path: normalizedPath });
    if (nativeHandle !== null && nativeHandle.kind === 'file') {
      return {
        kind: 'native-file',
        name,
        path: normalizedPath,
        handle: nativeHandle as FileSystemFileHandle,
        readOnly: session.vfs.getReadOnlyForPath({ path: normalizedPath }),
      };
    }

    const stat = await session.vfs.stat({ path: normalizedPath });
    switch (stat.type) {
    case 'file':
      break;
    case 'directory':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      throw new DOMException(`Expected a file: ${normalizedPath}`, 'TypeMismatchError');
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled virtual file type: ${String(_ex)}`);
    }
    }

    return {
      kind: 'virtual-file',
      name,
      path: normalizedPath,
      readOnly: session.vfs.getReadOnlyForPath({ path: normalizedPath }),
      vfs: session.vfs,
    };
  }
  default: {
    const _exhaustiveCheck: never = session;
    throw new Error(`Unhandled file explorer session: ${String(_exhaustiveCheck)}`);
  }
  }
}

function assertDirectoryIsWritable({ directory }: {
  directory: ResolvedDirectory,
}): void {
  if (directory.readOnly || directory.kind !== 'native-directory') {
    throw new DOMException('Read-only file system', 'NotAllowedError');
  }
}

function getWritableNativeDirectory({ directory }: {
  directory: ResolvedDirectory,
}): FileSystemDirectoryHandle {
  assertDirectoryIsWritable({ directory });
  switch (directory.kind) {
  case 'native-directory':
    return directory.handle;
  case 'virtual-directory':
    throw new DOMException('Read-only file system', 'NotAllowedError');
  default: {
    const _exhaustiveCheck: never = directory;
    throw new Error(`Unhandled resolved directory: ${String(_exhaustiveCheck)}`);
  }
  }
}

async function listDirectoryEntries({
  session,
  directory,
}: {
  session: FileExplorerSession,
  directory: ResolvedDirectory,
}): Promise<FileExplorerEntryRecord[]> {
  switch (directory.kind) {
  case 'native-directory':
    return listNativeDirectoryEntries({
      handle: directory.handle,
      directoryPath: directory.path,
      readOnly: directory.readOnly,
    });
  case 'virtual-directory':
    switch (session.kind) {
    case 'wesh-mounts':
      return listWeshVirtualDirectoryEntries({
        vfs: session.vfs,
        directoryPath: directory.path,
      });
    case 'native-directory':
      throw new Error(`Virtual directory not supported for native session: ${directory.path}`);
    default: {
      const _exhaustiveCheck: never = session;
      throw new Error(`Unhandled file explorer session: ${String(_exhaustiveCheck)}`);
    }
    }
  default: {
    const _exhaustiveCheck: never = directory;
    throw new Error(`Unhandled resolved directory: ${String(_exhaustiveCheck)}`);
  }
  }
}

async function listNativeDirectoryEntries({
  handle,
  directoryPath,
  readOnly,
}: {
  handle: FileSystemDirectoryHandle,
  directoryPath: string,
  readOnly: boolean,
}): Promise<FileExplorerEntryRecord[]> {
  const entries: FileExplorerEntryRecord[] = [];

  for await (const childHandle of handle.values()) {
    switch (childHandle.kind) {
    case 'directory':
      entries.push({
        path: joinExplorerPath({ parentPath: directoryPath, name: childHandle.name }),
        name: childHandle.name,
        kind: 'directory',
        size: undefined,
        lastModified: undefined,
        extension: '',
        mimeCategory: 'binary',
        readOnly,
        canNavigate: true,
        canMutate: !readOnly,
      });
      break;
    case 'file': {
      const extension = getFileExtension({ name: childHandle.name });
      const mimeCategory = getMimeCategory({ extension });
      let size: number | undefined;
      let lastModified: number | undefined;
      try {
        const file = await (childHandle as FileSystemFileHandle).getFile();
        size = file.size;
        lastModified = file.lastModified;
      } catch {
        size = undefined;
        lastModified = undefined;
      }
      entries.push({
        path: joinExplorerPath({ parentPath: directoryPath, name: childHandle.name }),
        name: childHandle.name,
        kind: 'file',
        size,
        lastModified,
        extension,
        mimeCategory,
        readOnly,
        canNavigate: false,
        canMutate: !readOnly,
      });
      break;
    }
    default: {
      throw new Error(`Unhandled directory child kind: ${((childHandle satisfies never) as { readonly kind: string }).kind}`);
    }
    }
  }

  return entries;
}

async function listWeshVirtualDirectoryEntries({
  vfs,
  directoryPath,
}: {
  vfs: WeshVFS,
  directoryPath: string,
}): Promise<FileExplorerEntryRecord[]> {
  const entries: FileExplorerEntryRecord[] = [];

  for await (const entry of vfs.readDir({ path: directoryPath })) {
    switch (entry.type) {
    case 'directory': {
      const nativeHandle = await vfs.getNativeHandle({ path: entry.fullPath });
      const readOnly = nativeHandle !== null && nativeHandle.kind === 'directory'
        ? vfs.getReadOnlyForPath({ path: entry.fullPath })
        : true;

      entries.push({
        path: normalizeExplorerPath({ path: entry.fullPath }),
        name: entry.name,
        kind: 'directory',
        size: undefined,
        lastModified: undefined,
        extension: '',
        mimeCategory: 'binary',
        readOnly,
        canNavigate: true,
        canMutate: false,
      });
      break;
    }
    case 'file': {
      const nativeHandle = await vfs.getNativeHandle({ path: entry.fullPath });
      const extension = getFileExtension({ name: entry.name });
      const mimeCategory = getMimeCategory({ extension });
      const stat = await vfs.stat({ path: entry.fullPath });

      entries.push({
        path: normalizeExplorerPath({ path: entry.fullPath }),
        name: entry.name,
        kind: 'file',
        size: stat.size,
        lastModified: stat.mtime || undefined,
        extension,
        mimeCategory,
        readOnly: nativeHandle !== null && nativeHandle.kind === 'file'
          ? vfs.getReadOnlyForPath({ path: entry.fullPath })
          : true,
        canNavigate: false,
        canMutate: false,
      });
      break;
    }
    case 'symlink': {
      const resolved = await vfs.resolve({ path: entry.fullPath });
      const extension = getFileExtension({ name: entry.name });
      const mimeCategory = getMimeCategory({ extension });

      switch (resolved.stat.type) {
      case 'directory':
        entries.push({
          path: normalizeExplorerPath({ path: entry.fullPath }),
          name: entry.name,
          kind: 'directory',
          size: undefined,
          lastModified: resolved.stat.mtime || undefined,
          extension: '',
          mimeCategory: 'binary',
          readOnly: true,
          canNavigate: true,
          canMutate: false,
        });
        break;
      case 'file':
        entries.push({
          path: normalizeExplorerPath({ path: entry.fullPath }),
          name: entry.name,
          kind: 'file',
          size: resolved.stat.size,
          lastModified: resolved.stat.mtime || undefined,
          extension,
          mimeCategory,
          readOnly: true,
          canNavigate: false,
          canMutate: false,
        });
        break;
      case 'fifo':
      case 'chardev':
      case 'symlink':
        break;
      default: {
        const _exhaustiveCheck: never = resolved.stat.type;
        throw new Error(`Unhandled resolved VFS entry type: ${String(_exhaustiveCheck)}`);
      }
      }
      break;
    }
    case 'fifo':
    case 'chardev':
      break;
    default: {
      const _exhaustiveCheck: never = entry.type;
      throw new Error(`Unhandled VFS entry type: ${String(_exhaustiveCheck)}`);
    }
    }
  }

  return entries;
}


function createDirectoryArchiveAccess({
  session,
  signal,
}: {
  session: FileExplorerSession,
  signal: AbortSignal,
}): FileExplorerDirectoryArchiveAccess {
  return {
    async listDirectory({ path }) {
      const directory = await resolveDirectory({ session, path });
      switch (directory.kind) {
      case 'native-directory': {
        const entries = [];
        for await (const childHandle of directory.handle.values()) {
          switch (childHandle.kind) {
          case 'directory':
            entries.push({
              name: childHandle.name,
              kind: 'directory' as const,
              modifiedAt: undefined,
            });
            break;
          case 'file': {
            const file = await (childHandle as FileSystemFileHandle).getFile();
            entries.push({
              name: childHandle.name,
              kind: 'file' as const,
              modifiedAt: new Date(file.lastModified),
            });
            break;
          }
          default: {
            const _ex: never = childHandle;
            throw new Error(`Unhandled native archive entry: ${String(_ex)}`);
          }
          }
        }
        return entries;
      }
      case 'virtual-directory':
        switch (session.kind) {
        case 'wesh-mounts': {
          const entries = [];
          for await (const entry of session.vfs.readDir({ path: directory.path })) {
            switch (entry.type) {
            case 'directory': {
              const stat = await session.vfs.stat({ path: entry.fullPath });
              entries.push({
                name: entry.name,
                kind: 'directory' as const,
                modifiedAt: stat.mtime > 0 ? new Date(stat.mtime) : undefined,
              });
              break;
            }
            case 'file': {
              const stat = await session.vfs.stat({ path: entry.fullPath });
              entries.push({
                name: entry.name,
                kind: 'file' as const,
                modifiedAt: stat.mtime > 0 ? new Date(stat.mtime) : undefined,
              });
              break;
            }
            case 'symlink':
            case 'fifo':
            case 'chardev':
              entries.push({
                name: entry.name,
                kind: 'unsupported' as const,
                modifiedAt: undefined,
              });
              break;
            default: {
              const _ex: never = entry.type;
              throw new Error(`Unhandled virtual archive entry: ${String(_ex)}`);
            }
            }
          }
          return entries;
        }
        case 'native-directory':
          throw new Error(`Virtual directory not supported for native session: ${directory.path}`);
        default: {
          const _ex: never = session;
          throw new Error(`Unhandled file explorer session: ${String(_ex)}`);
        }
        }
      default: {
        const _ex: never = directory;
        throw new Error(`Unhandled archive directory: ${String(_ex)}`);
      }
      }
    },
    async openFileStream({ path }) {
      const file = await resolveFile({ session, path });
      switch (file.kind) {
      case 'native-file':
        return session.blobs.fromNative({ blob: await file.handle.getFile() }).stream({ signal });
      case 'virtual-file':
        return openFileReadStream({ files: file.vfs, path: file.path });
      default: {
        const _ex: never = file;
        throw new Error(`Unhandled archive file: ${String(_ex)}`);
      }
      }
    },
  };
}

async function listDirectoryArchiveSuggestionEntries({
  session,
  path,
}: {
  session: FileExplorerSession,
  path: string,
}): Promise<FileExplorerDirectoryArchiveSourceEntry[]> {
  const directory = await resolveDirectory({ session, path });
  switch (directory.kind) {
  case 'native-directory': {
    const entries: FileExplorerDirectoryArchiveSourceEntry[] = [];
    for await (const childHandle of directory.handle.values()) {
      switch (childHandle.kind) {
      case 'directory':
      case 'file':
        entries.push({
          name: childHandle.name,
          kind: childHandle.kind,
          modifiedAt: undefined,
        });
        break;
      default: {
        const _ex: never = childHandle;
        throw new Error(`Unhandled native archive suggestion entry: ${String(_ex)}`);
      }
      }
    }
    return entries;
  }
  case 'virtual-directory':
    switch (session.kind) {
    case 'wesh-mounts': {
      const entries: FileExplorerDirectoryArchiveSourceEntry[] = [];
      for await (const entry of session.vfs.readDir({ path: directory.path })) {
        switch (entry.type) {
        case 'directory':
        case 'file':
          entries.push({
            name: entry.name,
            kind: entry.type,
            modifiedAt: undefined,
          });
          break;
        case 'symlink':
        case 'fifo':
        case 'chardev':
          break;
        default: {
          const _ex: never = entry.type;
          throw new Error(`Unhandled virtual archive suggestion entry: ${String(_ex)}`);
        }
        }
      }
      return entries;
    }
    case 'native-directory':
      throw new Error(`Virtual directory not supported for native session: ${directory.path}`);
    default: {
      const _ex: never = session;
      throw new Error(`Unhandled file explorer session: ${String(_ex)}`);
    }
    }
  default: {
    const _ex: never = directory;
    throw new Error(`Unhandled archive suggestion directory: ${String(_ex)}`);
  }
  }
}

function resolveArchiveSuggestionQuery({ query }: { query: string }): {
  parentRelativePath: string,
  nameQuery: string,
} | undefined {
  if (query.startsWith('/')) {
    return undefined;
  }
  const segments = query.split('/');
  if (segments.some(segment => segment === '..')) {
    return undefined;
  }
  const nameQuery = segments.pop() ?? '';
  const parentSegments = segments.filter(segment => segment !== '' && segment !== '.');
  if (parentSegments.some(segment => !isSafeDirectoryDownloadPathSegment({ name: segment }))) {
    return undefined;
  }
  return {
    parentRelativePath: parentSegments.join('/'),
    nameQuery,
  };
}

function joinRelativePath({ parentPath, name }: { parentPath: string, name: string }): string {
  return parentPath === '' ? name : `${parentPath}/${name}`;
}

function isArchiveSuggestionEntry(
  entry: FileExplorerDirectoryArchiveSourceEntry,
): entry is FileExplorerDirectoryArchiveSourceEntry & { kind: 'file' | 'directory' } {
  switch (entry.kind) {
  case 'file':
  case 'directory':
    return true;
  case 'unsupported':
    return false;
  default: {
    const _ex: never = entry.kind;
    throw new Error(`Unhandled archive entry kind: ${String(_ex)}`);
  }
  }
}

function getArchiveSuggestionKindOrder({ kind }: { kind: 'file' | 'directory' }): number {
  switch (kind) {
  case 'directory':
    return 0;
  case 'file':
    return 1;
  default: {
    const _ex: never = kind;
    throw new Error(`Unhandled archive suggestion kind: ${String(_ex)}`);
  }
  }
}

function joinDirectoryRelativePath({ directoryPath, relativePath }: { directoryPath: string, relativePath: string }): string {
  if (relativePath === '') {
    return normalizeExplorerPath({ path: directoryPath });
  }
  return joinExplorerPath({
    parentPath: normalizeExplorerPath({ path: directoryPath }),
    name: relativePath,
  });
}

function buildPathSegments({
  path,
  rootName,
}: {
  path: string,
  rootName: string,
}): FileExplorerPathSegment[] {
  const normalizedPath = normalizeExplorerPath({ path });
  const segments = splitExplorerPath({ path: normalizedPath });
  const pathSegments: FileExplorerPathSegment[] = [
    fileExplorerPathSegmentSchema.parse({
      name: rootName,
      path: '/',
    }),
  ];

  for (let i = 0; i < segments.length; i += 1) {
    pathSegments.push(fileExplorerPathSegmentSchema.parse({
      name: segments[i]!,
      path: `/${segments.slice(0, i + 1).join('/')}`,
    }));
  }

  return pathSegments;
}

/** Resolve the source kind only. Read/write failures must never trigger a directory retry. */
async function resolveNativeCopySource({ session, path }: {
  session: FileExplorerSession,
  path: string,
}): Promise<FileSystemFileHandle | FileSystemDirectoryHandle> {
  switch (session.kind) {
  case 'native-directory': {
    const parent = await resolveNativeDirectoryHandle({ rootHandle: session.rootHandle, path: getParentPath({ path }) });
    const name = getBaseNameFromPath({ path, rootName: session.rootName });
    try {
      return await parent.getFileHandle(name);
    } catch (error) {
      if (!isFileSystemEntryLookupMiss({ error })) throw error;
      return parent.getDirectoryHandle(name);
    }
  }
  case 'wesh-mounts': {
    const handle = await session.vfs.getNativeHandle({ path });
    if (handle === null) throw new Error(`Cannot copy virtual entry: ${path}`);
    switch (handle.kind) {
    case 'file':
      return handle as FileSystemFileHandle;
    case 'directory':
      return handle as FileSystemDirectoryHandle;
    default: {
      const _ex: never = handle.kind;
      throw new Error(`Unhandled native copy source: ${String(_ex)}`);
    }
    }
  }
  default: {
    const _ex: never = session;
    throw new Error(`Unhandled copy session: ${String(_ex)}`);
  }
  }
}

async function deleteEntryPath({
  session,
  path,
  signal,
}: {
  session: FileExplorerSession,
  path: string,
  signal: AbortSignal | undefined,
}): Promise<void> {
  signal?.throwIfAborted();
  const normalizedPath = normalizeExplorerPath({ path });
  const name = getBaseNameFromPath({
    path: normalizedPath,
    rootName: session.rootName,
  });
  const parentDirectory = await resolveDirectory({
    session,
    path: getParentPath({ path: normalizedPath }),
  });
  const writableParentDirectory = getWritableNativeDirectory({ directory: parentDirectory });
  signal?.throwIfAborted();
  await writableParentDirectory.removeEntry(name, { recursive: true });
}

async function listZipUploadExistingEntries({
  targetDirectory,
  relativePath,
}: {
  targetDirectory: FileSystemDirectoryHandle,
  relativePath: string,
}): Promise<Array<{
  name: string,
  path: string,
  kind: 'file' | 'directory',
  size: number | undefined,
  lastModified: number | undefined,
}>> {
  let directory = targetDirectory;
  if (relativePath !== '') {
    for (const segment of relativePath.split('/')) {
      try {
        directory = await directory.getDirectoryHandle(segment);
      } catch (error) {
        if (isFileSystemEntryLookupMiss({ error })) {
          return [];
        }
        throw error;
      }
    }
  }
  const entries: Array<{
    name: string,
    path: string,
    kind: 'file' | 'directory',
    size: number | undefined,
    lastModified: number | undefined,
  }> = [];
  for await (const child of directory.values()) {
    switch (child.kind) {
    case 'directory':
      entries.push({
        name: child.name,
        path: relativePath === '' ? child.name : `${relativePath}/${child.name}`,
        kind: 'directory',
        size: undefined,
        lastModified: undefined,
      });
      break;
    case 'file': {
      const file = await (child as FileSystemFileHandle).getFile();
      entries.push({
        name: child.name,
        path: relativePath === '' ? child.name : `${relativePath}/${child.name}`,
        kind: 'file',
        size: file.size,
        lastModified: file.lastModified,
      });
      break;
    }
    default: {
      const _exhaustiveCheck: never = child;
      throw new Error(`Unhandled preview child: ${String(_exhaustiveCheck)}`);
    }
    }
  }
  return entries;
}

export function createFileExplorerWorker(): WorkerServerApi<IFileExplorerWorker> {
  return {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy values must remain top-level arguments.
    async prepareSession({ request }, naidanSysfsRemoteReader, blobReadHost) {
      const blobs = createWorkerBlobContext({ host: blobReadHost });
      try {
        const validated = fileExplorerPrepareSessionRequestSchema.parse(request);
        const sessionId = createSessionId();
        const response = fileExplorerPrepareSessionResponseSchema.parse({ sessionId });
        const session = await createSessionFromRoot({ root: validated.root, naidanSysfsRemoteReader, blobs });
        sessions.set(sessionId, session);
        return response;
      } catch (error) {
        try {
          blobs.dispose();
        } finally {
          if (naidanSysfsRemoteReader !== undefined) releaseWorkerProxyArgument({ value: naidanSysfsRemoteReader });
        }
        throw error;
      }
    },

    async readDirectory({ request }) {
      const validated = fileExplorerReadDirectoryRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      const directory = await resolveDirectory({
        session,
        path: validated.path,
      });
      const entries = await listDirectoryEntries({ session, directory });

      return fileExplorerReadDirectoryResponseSchema.parse({
        directoryName: directory.name,
        directoryPath: directory.path,
        readOnly: directory.readOnly,
        pathSegments: buildPathSegments({
          path: directory.path,
          rootName: session.rootName,
        }),
        entries,
      });
    },

    async readPreview({ request }) {
      const validated = fileExplorerReadPreviewRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      const signal = session.reads.signal;
      signal.throwIfAborted();
      const normalizedPath = normalizeExplorerPath({ path: validated.path });

      try {
        await resolveDirectory({ session, path: normalizedPath });
        signal.throwIfAborted();
        return fileExplorerReadPreviewResponseSchema.parse({ kind: 'directory' });
      } catch (error) {
        signal.throwIfAborted();
        if (!isFileSystemEntryLookupMiss({ error })) throw error;
        // Only an entry-kind lookup miss can fall through. Storage failures
        // must not trigger another lookup or become an empty/missing preview.
      }

      const resolvedFile = await resolveFile({ session, path: normalizedPath });
      signal.throwIfAborted();
      const extension = getFileExtension({ name: resolvedFile.name });
      const mimeCategory = getMimeCategory({ extension });
      // Resolve existence and permissions, but do not acquire the binary body
      // just to return its placeholder (notably sysfs attachment `data`).
      switch (mimeCategory) {
      case 'binary': return fileExplorerReadPreviewResponseSchema.parse({ kind: 'binary', oversized: false });
      case 'text': case 'image': case 'video': case 'audio': break;
      default: {
        const _ex: never = mimeCategory;
        throw new Error(`Unhandled mime category: ${String(_ex)}`);
      }
      }
      const byteLimit = (() => {
        switch (validated.mode) {
        case 'force': return undefined;
        case 'bounded':
          switch (mimeCategory) {
          case 'text': return TEXT_PREVIEW_SIZE_LIMIT;
          case 'image': case 'video': case 'audio': return MEDIA_PREVIEW_SIZE_LIMIT;
          default: {
            const _ex: never = mimeCategory;
            throw new Error(`Unhandled preview category: ${String(_ex)}`);
          }
          }
        default: {
          const _ex: never = validated.mode;
          throw new Error(`Unhandled preview mode: ${String(_ex)}`);
        }
        }
      })();
      const source = await (() => {
        switch (resolvedFile.kind) {
        case 'native-file': return resolvedFile.handle.getFile().then(blob => ({ kind: 'blob' as const, blob }));
        case 'virtual-file': return Promise.resolve({ kind: 'virtual' as const, files: resolvedFile.vfs });
        default: {
          const _ex: never = resolvedFile;
          throw new Error(`Unhandled resolved file: ${String(_ex)}`);
        }
        }
      })();
      signal.throwIfAborted();
      switch (mimeCategory) {
      case 'text': {
        const content = await (() => {
          switch (source.kind) {
          case 'blob':
            if (byteLimit !== undefined && source.blob.size > byteLimit) return { status: 'oversized' as const };
            return session.blobs.fromNative({ blob: source.blob }).text({ signal })
              .then(value => ({ status: 'complete' as const, value }));
          case 'virtual':
            return readVirtualFileText({ files: source.files, path: resolvedFile.path, byteLimit, signal });
          default: {
            const _ex: never = source;
            throw new Error(`Unhandled preview source: ${String(_ex)}`);
          }
          }
        })();
        signal.throwIfAborted();
        switch (content.status) {
        case 'oversized':
          return fileExplorerReadPreviewResponseSchema.parse({
            kind: 'text', rawText: '', displayText: '', languageHint: EXTENSION_LANGUAGE_MAP[extension], oversized: true,
          });
        case 'complete': break;
        default: {
          const _ex: never = content;
          throw new Error(`Unhandled text result: ${String(_ex)}`);
        }
        }
        const rawText = content.value;
        let displayText = rawText;
        if (extension === '.json' || extension === '.jsonl') {
          try {
            displayText = JSON.stringify(JSON.parse(rawText), null, 2);
          } catch {
            displayText = rawText;
          }
        }
        return fileExplorerReadPreviewResponseSchema.parse({
          kind: 'text', rawText, displayText, languageHint: EXTENSION_LANGUAGE_MAP[extension], oversized: false,
        });
      }
      case 'image': case 'video': case 'audio': {
        const content = await (() => {
          switch (source.kind) {
          case 'blob':
            return byteLimit !== undefined && source.blob.size > byteLimit
              ? { status: 'oversized' as const }
              : { status: 'complete' as const, value: source.blob };
          case 'virtual':
            return readVirtualFileBlob({ files: source.files, path: resolvedFile.path, byteLimit, signal });
          default: {
            const _ex: never = source;
            throw new Error(`Unhandled preview source: ${String(_ex)}`);
          }
          }
        })();
        signal.throwIfAborted();
        const mimeType = (() => {
          switch (source.kind) {
          case 'blob': return source.blob.type;
          case 'virtual': return '';
          default: {
            const _ex: never = source;
            throw new Error(`Unhandled preview source: ${String(_ex)}`);
          }
          }
        })();
        switch (content.status) {
        case 'oversized':
          return fileExplorerReadPreviewResponseSchema.parse({ kind: 'media', mediaKind: mimeCategory, blob: new Blob([]), mimeType, oversized: true });
        case 'complete':
          return fileExplorerReadPreviewResponseSchema.parse({ kind: 'media', mediaKind: mimeCategory, blob: content.value, mimeType, oversized: false });
        default: {
          const _ex: never = content;
          throw new Error(`Unhandled media result: ${String(_ex)}`);
        }
        }
      }
      default: {
        const _ex: never = mimeCategory;
        throw new Error(`Unhandled mime category: ${String(_ex)}`);
      }
      }
    },

    async readFile({ request }) {
      const validated = fileExplorerReadFileRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      const signal = session.reads.signal;
      signal.throwIfAborted();
      const resolvedFile = await resolveFile({ session, path: validated.path });
      signal.throwIfAborted();
      switch (resolvedFile.kind) {
      case 'native-file': {
        const blob = await resolvedFile.handle.getFile();
        signal.throwIfAborted();
        return fileExplorerReadFileResponseSchema.parse({ blob });
      }
      case 'virtual-file': {
        const content = await readVirtualFileBlob({ files: resolvedFile.vfs, path: resolvedFile.path, byteLimit: undefined, signal });
        signal.throwIfAborted();
        switch (content.status) {
        case 'complete': return fileExplorerReadFileResponseSchema.parse({ blob: content.value });
        case 'oversized': throw new Error('Unbounded virtual file read unexpectedly exceeded a limit');
        default: {
          const _ex: never = content;
          throw new Error(`Unhandled file result: ${String(_ex)}`);
        }
        }
      }
      default: {
        const _ex: never = resolvedFile;
        throw new Error(`Unhandled resolved file: ${String(_ex)}`);
      }
      }
    },

    async suggestArchiveExclusions({ request }) {
      const validated = fileExplorerSuggestArchiveExclusionsRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      const query = resolveArchiveSuggestionQuery({ query: validated.query });
      if (query === undefined) {
        return fileExplorerSuggestArchiveExclusionsResponseSchema.parse({
          suggestions: [],
          resultState: 'complete',
        });
      }

      const excludedRelativePaths = new Set(normalizeArchiveExcludedRelativePaths({
        paths: validated.excludedRelativePaths,
      }));
      if (query.parentRelativePath !== '' && isDirectoryDownloadPathExcluded({
        relativePath: query.parentRelativePath,
        excludedRelativePaths,
      })) {
        return fileExplorerSuggestArchiveExclusionsResponseSchema.parse({
          suggestions: [],
          resultState: 'complete',
        });
      }
      const directoryPath = joinDirectoryRelativePath({
        directoryPath: validated.directoryPath,
        relativePath: query.parentRelativePath,
      });
      const entries = await listDirectoryArchiveSuggestionEntries({
        session,
        path: directoryPath,
      });
      const matchingEntries = entries
        .filter(isArchiveSuggestionEntry)
        .filter(entry => isSafeDirectoryDownloadPathSegment({ name: entry.name }))
        .filter(entry => entry.name.toLocaleLowerCase().includes(query.nameQuery.toLocaleLowerCase()))
        .map(entry => ({
          relativePath: joinRelativePath({
            parentPath: query.parentRelativePath,
            name: entry.name,
          }),
          name: entry.name,
          kind: entry.kind,
        }))
        .filter(entry => !isDirectoryDownloadPathExcluded({
          relativePath: entry.relativePath,
          excludedRelativePaths,
        }))
        .sort((a, b) => {
          const kindOrder = getArchiveSuggestionKindOrder({ kind: a.kind })
            - getArchiveSuggestionKindOrder({ kind: b.kind });
          return kindOrder !== 0 ? kindOrder : a.name.localeCompare(b.name);
        });
      const maximumSuggestionCount = 50;
      return fileExplorerSuggestArchiveExclusionsResponseSchema.parse({
        suggestions: matchingEntries.slice(0, maximumSuggestionCount),
        resultState: matchingEntries.length > maximumSuggestionCount ? 'truncated' : 'complete',
      });
    },

    async createDirectoryArchive({ request }) {
      const validated = fileExplorerCreateDirectoryArchiveRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      const jobKey = createDirectoryArchiveJobKey({
        sessionId: validated.sessionId,
        jobId: validated.jobId,
      });
      if (directoryArchiveJobs.has(jobKey)) {
        throw new Error(`Directory archive job already exists: ${validated.jobId}`);
      }
      const abortController = new AbortController();
      directoryArchiveJobs.set(jobKey, abortController);
      const finish = trackZipTask({ session });
      try {
        const normalizedPath = normalizeExplorerPath({ path: validated.directoryPath });
        const archiveRootName = getBaseNameFromPath({
          path: normalizedPath,
          rootName: session.rootName,
        });
        const result = await createFileExplorerDirectoryArchive({
          access: createDirectoryArchiveAccess({ session, signal: abortController.signal }),
          sourceRootPath: normalizedPath,
          archiveRootName,
          excludedRelativePaths: normalizeArchiveExcludedRelativePaths({
            paths: validated.excludedRelativePaths,
          }),
          signal: abortController.signal,
        });
        abortController.signal.throwIfAborted();
        return fileExplorerCreateDirectoryArchiveResponseSchema.parse({
          status: 'completed',
          blob: result.blob,
          skippedEntryCount: result.skippedEntryCount,
        });
      } catch (error: unknown) {
        if (abortController.signal.aborted) {
          return fileExplorerCreateDirectoryArchiveResponseSchema.parse({ status: 'cancelled' });
        }
        throw error;
      } finally {
        directoryArchiveJobs.delete(jobKey);
        finish();
      }
    },

    async cancelDirectoryArchive({ request }) {
      const validated = fileExplorerCancelDirectoryArchiveRequestSchema.parse(request);
      const jobKey = createDirectoryArchiveJobKey({
        sessionId: validated.sessionId,
        jobId: validated.jobId,
      });
      const job = directoryArchiveJobs.get(jobKey);
      if (job === undefined) {
        return;
      }
      job.abort(new DOMException('Directory archive cancelled', 'AbortError'));
    },

    async createFile({ request }) {
      const validated = fileExplorerCreateFileRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      const directory = await resolveDirectory({
        session,
        path: validated.parentPath,
      });
      const writableDirectory = getWritableNativeDirectory({ directory });
      const fileHandle = await writableDirectory.getFileHandle(validated.name, { create: true });
      const writable = await (fileHandle as unknown as {
        createWritable: () => Promise<FileSystemWritableFileStream>,
      }).createWritable();
      await writable.close();
    },

    async createFolder({ request }) {
      const validated = fileExplorerCreateFolderRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      const directory = await resolveDirectory({
        session,
        path: validated.parentPath,
      });
      const writableDirectory = getWritableNativeDirectory({ directory });
      await writableDirectory.getDirectoryHandle(validated.name, { create: true });
    },

    async deleteEntries({ request }) {
      const validated = fileExplorerDeleteEntriesRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      for (const path of validated.paths) {
        await deleteEntryPath({ session, path, signal: undefined });
      }
    },

    async renameEntry({ request }) {
      const validated = fileExplorerRenameEntryRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      await session.writes.run({ operation: async ({ writer }) => {
        const normalizedSourcePath = normalizeExplorerPath({ path: validated.path });
        const sourceName = getBaseNameFromPath({ path: normalizedSourcePath, rootName: session.rootName });
        const parentDirectory = await resolveDirectory({ session, path: getParentPath({ path: normalizedSourcePath }) });
        const writableParentDirectory = getWritableNativeDirectory({ directory: parentDirectory });
        const source = await resolveNativeCopySource({ session, path: normalizedSourcePath });
        writer.signal.throwIfAborted();
        if (sourceName === validated.newName) return;
        await writer.copyEntry({ source, targetDirectory: writableParentDirectory, name: validated.newName });
        writer.signal.throwIfAborted();
        await writableParentDirectory.removeEntry(sourceName, { recursive: true });
      } });
    },

    async copyEntries({ request }) {
      const validated = fileExplorerTransferEntriesRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      await session.writes.run({ operation: async ({ writer }) => {
        const targetDirectory = await resolveDirectory({ session, path: validated.targetDirectoryPath });
        const writableTargetDirectory = getWritableNativeDirectory({ directory: targetDirectory });
        for (const sourcePath of validated.sourcePaths) {
          writer.signal.throwIfAborted();
          const normalizedSourcePath = normalizeExplorerPath({ path: sourcePath });
          const source = await resolveNativeCopySource({ session, path: normalizedSourcePath });
          await writer.copyEntry({ source, targetDirectory: writableTargetDirectory, name: source.name });
        }
      } });
    },

    async moveEntries({ request }) {
      const validated = fileExplorerTransferEntriesRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      await session.writes.run({ operation: async ({ writer }) => {
        await this.copyEntries({ request: validated });
        for (const sourcePath of validated.sourcePaths) {
          await deleteEntryPath({ session, path: sourcePath, signal: writer.signal });
        }
      } });
    },

    async analyzeZipUpload({ request }) {
      const validated = fileExplorerAnalyzeZipUploadRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      const analysisKey = createZipUploadKey({ sessionId: validated.sessionId, id: validated.analysisId });
      const abortController = new AbortController();
      zipAnalysisJobs.get(analysisKey)?.abort(new DOMException('ZIP analysis replaced', 'AbortError'));
      zipAnalysisJobs.set(analysisKey, abortController);
      zipUploadAnalyses.delete(analysisKey);
      const finish = trackZipTask({ session });
      try {
        const targetDirectory = await resolveDirectory({ session, path: validated.targetDirectoryPath });
        getWritableNativeDirectory({ directory: targetDirectory });
        abortController.signal.throwIfAborted();
        let analysis: ParsedZipUpload;
        try {
          analysis = await parseZipUpload({
            blob: session.blobs.fromNative({ blob: validated.blob }),
            fileName: validated.fileName,
            signal: abortController.signal,
          });
        } catch (error) {
          // Cancellation or byte transport failure is not an invalid archive.
          abortController.signal.throwIfAborted();
          if (error instanceof BlobViewZipReadError) throw error;
          return fileExplorerAnalyzeZipUploadResponseSchema.parse({
            status: 'not_extractable', analysisId: validated.analysisId, reason: 'invalid_or_unsupported_archive',
          });
        }
        abortController.signal.throwIfAborted();
        zipUploadAnalyses.set(analysisKey, {
          targetDirectoryPath: validated.targetDirectoryPath,
          analysis,
          previewFingerprints: new Map(),
        });
        return fileExplorerAnalyzeZipUploadResponseSchema.parse({
          status: 'extractable', analysisId: validated.analysisId,
          entryCount: analysis.entries.length, totalUncompressedSize: analysis.totalUncompressedSize,
          singleRootDirectoryName: analysis.singleRootDirectoryName,
        });
      } finally {
        if (zipAnalysisJobs.get(analysisKey) === abortController) zipAnalysisJobs.delete(analysisKey);
        finish();
      }
    },

    async readZipUploadPreviewDirectory({ request }) {
      const validated = fileExplorerReadZipUploadPreviewDirectoryRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      const analysisState = zipUploadAnalyses.get(createZipUploadKey({
        sessionId: validated.sessionId,
        id: validated.analysisId,
      }));
      if (analysisState === undefined) {
        throw new Error(`Unknown ZIP upload analysis: ${validated.analysisId}`);
      }
      const targetDirectory = getWritableNativeDirectory({
        directory: await resolveDirectory({
          session,
          path: analysisState.targetDirectoryPath,
        }),
      });
      const inspection = await inspectZipUploadTarget({
        analysis: analysisState.analysis,
        placement: validated.placement,
        targetDirectory,
      });
      analysisState.previewFingerprints.set(
        createZipUploadPlacementKey({ placement: validated.placement }),
        inspection.fingerprint,
      );
      const existingEntries = await listZipUploadExistingEntries({
        targetDirectory,
        relativePath: validated.relativePath,
      });
      const preview = await buildZipUploadPreview({
        analysis: analysisState.analysis,
        placement: validated.placement,
        relativePath: validated.relativePath,
        existingEntries,
        blockedPaths: inspection.blockedPaths,
      });
      const pathSegments = validated.relativePath === ''
        ? []
        : validated.relativePath.split('/').map((name, index, segments) => ({
          name,
          relativePath: segments.slice(0, index + 1).join('/'),
        }));
      return fileExplorerReadZipUploadPreviewDirectoryResponseSchema.parse({
        relativePath: validated.relativePath,
        pathSegments,
        entries: preview.entries,
        summary: {
          ...preview.summary,
          blockedCount: inspection.blockedPaths.size,
        },
      });
    },

    async executeZipUpload({ request }) {
      const validated = fileExplorerExecuteZipUploadRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      const analysisState = zipUploadAnalyses.get(createZipUploadKey({
        sessionId: validated.sessionId,
        id: validated.analysisId,
      }));
      if (analysisState === undefined) {
        throw new Error(`Unknown ZIP upload analysis: ${validated.analysisId}`);
      }
      const jobKey = createZipUploadKey({ sessionId: validated.sessionId, id: validated.jobId });
      if (zipUploadJobs.has(jobKey)) {
        throw new Error(`ZIP upload job already exists: ${validated.jobId}`);
      }
      const abortController = new AbortController();
      zipUploadJobs.set(jobKey, abortController);
      const finish = trackZipTask({ session });
      try {
        const targetDirectory = getWritableNativeDirectory({
          directory: await resolveDirectory({
            session,
            path: analysisState.targetDirectoryPath,
          }),
        });
        const inspection = await inspectZipUploadTarget({
          analysis: analysisState.analysis,
          placement: validated.placement,
          targetDirectory,
        });
        abortController.signal.throwIfAborted();
        const previewFingerprint = analysisState.previewFingerprints.get(
          createZipUploadPlacementKey({ placement: validated.placement }),
        );
        if (
          previewFingerprint === undefined
          || previewFingerprint !== inspection.fingerprint
          || inspection.blockedPaths.size > 0
        ) {
          return fileExplorerExecuteZipUploadResponseSchema.parse({ status: 'preview_outdated' });
        }
        const result = await executeParsedZipUpload({
          copyFile: session.copyFile,
          analysis: analysisState.analysis,
          placement: validated.placement,
          targetDirectory,
          jobId: validated.jobId,
          expectedFingerprint: previewFingerprint,
          signal: abortController.signal,
        });
        switch (result) {
        case 'completed':
          return fileExplorerExecuteZipUploadResponseSchema.parse({ status: 'completed' });
        case 'preview-outdated':
          return fileExplorerExecuteZipUploadResponseSchema.parse({ status: 'preview_outdated' });
        default: {
          const _exhaustiveCheck: never = result;
          throw new Error(`Unhandled ZIP upload result: ${String(_exhaustiveCheck)}`);
        }
        }
      } catch (error) {
        if (abortController.signal.aborted && !(error instanceof ZipUploadRecoveryError)) {
          return fileExplorerExecuteZipUploadResponseSchema.parse({ status: 'cancelled' });
        }
        throw error;
      } finally {
        zipUploadJobs.delete(jobKey);
        finish();
      }
    },

    async cancelZipUpload({ request }) {
      const validated = fileExplorerCancelZipUploadRequestSchema.parse(request);
      zipUploadJobs.get(createZipUploadKey({
        sessionId: validated.sessionId,
        id: validated.jobId,
      }))?.abort(new DOMException('ZIP upload cancelled', 'AbortError'));
    },

    async disposeZipUploadAnalysis({ request }) {
      const validated = fileExplorerDisposeZipUploadAnalysisRequestSchema.parse(request);
      const key = createZipUploadKey({ sessionId: validated.sessionId, id: validated.analysisId });
      zipAnalysisJobs.get(key)?.abort(new DOMException('ZIP analysis disposed', 'AbortError'));
      zipAnalysisJobs.delete(key);
      zipUploadAnalyses.delete(key);
    },

    async uploadFiles({ request }) {
      const validated = fileExplorerUploadFilesRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      await session.writes.run({ operation: async ({ writer }) => {
        const targetDirectory = await resolveDirectory({ session, path: validated.targetDirectoryPath });
        const writableTargetDirectory = getWritableNativeDirectory({ directory: targetDirectory });
        for (const file of validated.files) {
          const source = session.blobs.fromNative({ blob: file.blob });
          await writer.writeFile({ source, targetDirectory: writableTargetDirectory, name: file.name });
        }
      } });
    },

    async disposeSession({ request }) {
      const validated = fileExplorerDisposeSessionRequestSchema.parse(request);
      const pendingDisposal = sessionDisposals.get(validated.sessionId);
      if (pendingDisposal !== undefined) return pendingDisposal;
      const session = sessions.get(validated.sessionId);
      sessions.delete(validated.sessionId);
      const disposal = (async () => {
        const writesStopped = session?.writes.dispose();
        try {
          session?.reads.abort(new DOMException('File explorer reads disposed', 'AbortError'));
          for (const jobs of [directoryArchiveJobs, zipUploadJobs, zipAnalysisJobs]) {
            for (const [jobKey, abortController] of jobs) {
              if (jobKey.startsWith(`${validated.sessionId}\0`)) {
                abortController.abort(new DOMException('File explorer session disposed', 'AbortError'));
              }
            }
          }
          for (const analysisKey of zipUploadAnalyses.keys()) {
            if (analysisKey.startsWith(`${validated.sessionId}\0`)) zipUploadAnalyses.delete(analysisKey);
          }
          // Cancel the operations, not their shared reader: ZIP rollback may
          // still need to read backup files after its operation was aborted.
          await Promise.all([writesStopped, ...session?.zipTasks ?? []]);
        } finally {
          try {
            session?.blobs.dispose();
          } finally {
            if (session?.naidanSysfsRemoteReader !== undefined) releaseWorkerProxyArgument({ value: session.naidanSysfsRemoteReader });
          }
        }
      })();
      sessionDisposals.set(validated.sessionId, disposal);
      try {
        await disposal;
      } finally {
        sessionDisposals.delete(validated.sessionId);
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
