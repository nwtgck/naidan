
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
  inspectZipUploadTarget,
  parseZipUpload,
  type ParsedZipUpload,
} from './zip-upload';
import {
  copyFileSystemFileHandle,
  isFileSystemEntryLookupMiss,
  writeReadableStreamToFileHandle,
} from '@/utils/file-system-stream';
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

type FileExplorerSession =
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
  };

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
const directoryArchiveJobs = new Map<string, AbortController>();
const zipUploadJobs = new Map<string, AbortController>();
const zipUploadAnalyses = new Map<string, {
  readonly targetDirectoryPath: string,
  readonly analysis: ParsedZipUpload,
  readonly previewFingerprints: Map<string, string>,
}>();

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

async function createSessionFromRoot({ root }: { root: FileExplorerRootDescriptor }): Promise<FileExplorerSession> {
  switch (root.kind) {
  case 'opfs-root':
    return {
      kind: 'native-directory',
      rootName: root.rootName,
      rootHandle: await navigator.storage.getDirectory(),
      readOnly: false,
    };
  case 'native-directory':
    return {
      kind: 'native-directory',
      rootName: root.rootName,
      rootHandle: root.handle,
      readOnly: root.readOnly,
    };
  case 'wesh-mounts': {
    const vfs = new WeshVFS({ rootHandle: undefined });
    for (const mount of root.mounts) {
      switch (mount.type) {
      case 'directory':
        await vfs.mount({
          path: mount.path,
          handle: mount.handle,
          readOnly: mount.readOnly,
        });
        break;
      case 'naidan_sysfs': {
        const reader = await (() => {
          switch (mount.storageType) {
          case 'opfs':
            return createOpfsNaidanSysfsStorageReader();
          case 'local':
          case 'memory':
            if (root.naidanSysfsRemoteReader === undefined) {
              throw new Error(`Naidan sysfs remote reader is required for ${mount.storageType} storage`);
            }
            return createRemoteNaidanSysfsStorageReader({
              remoteReader: root.naidanSysfsRemoteReader,
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
  const stat = await vfs.stat({ path: normalizedPath }).catch(() => {
    if (normalizedPath === '/') {
      return { type: 'directory' as const };
    }
    return null;
  });
  if (stat === null || stat.type !== 'directory') {
    throw new Error(`Directory not found: ${normalizedPath}`);
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

    const stat = await session.vfs.stat({ path: normalizedPath }).catch(() => null);
    if (stat === null || stat.type !== 'file') {
      throw new Error(`File not found: ${normalizedPath}`);
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

async function readAllBytesFromVirtualFile({
  vfs,
  path,
}: {
  vfs: WeshVFS,
  path: string,
}): Promise<Uint8Array> {
  const handle = await vfs.open({
    path,
    flags: {
      access: 'read',
      creation: 'never',
      truncate: 'preserve',
      append: 'preserve',
    },
    mode: undefined,
  });

  try {
    const chunks: Uint8Array[] = [];
    while (true) {
      const buffer = new Uint8Array(64 * 1024);
      const { bytesRead } = await handle.read({ buffer });
      if (bytesRead === 0) {
        break;
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  } finally {
    await handle.close();
  }
}

async function readBlobText({ blob }: { blob: Blob }): Promise<string> {
  if (typeof blob.text === 'function') {
    return blob.text();
  }
  if (typeof blob.arrayBuffer !== 'function') {
    throw new Error('Blob text reading is not supported in this environment');
  }
  const buffer = await blob.arrayBuffer();
  return new TextDecoder().decode(buffer);
}

function uint8ArrayToBlobPart({ bytes }: { bytes: Uint8Array }): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
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
}: {
  session: FileExplorerSession,
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
        return (await file.handle.getFile()).stream() as ReadableStream<Uint8Array>;
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

async function copyFileHandleToDirectory({
  sourceHandle,
  targetDirectoryHandle,
}: {
  sourceHandle: FileSystemFileHandle,
  targetDirectoryHandle: FileSystemDirectoryHandle,
}): Promise<void> {
  const targetFileHandle = await targetDirectoryHandle.getFileHandle(sourceHandle.name, { create: true });
  await copyFileSystemFileHandle({
    sourceHandle,
    targetHandle: targetFileHandle,
    signal: undefined,
  });
}

async function copyDirectoryHandleToDirectory({
  sourceHandle,
  targetDirectoryHandle,
}: {
  sourceHandle: FileSystemDirectoryHandle,
  targetDirectoryHandle: FileSystemDirectoryHandle,
}): Promise<void> {
  const nextDirectoryHandle = await targetDirectoryHandle.getDirectoryHandle(sourceHandle.name, { create: true });
  for await (const childHandle of sourceHandle.values()) {
    switch (childHandle.kind) {
    case 'file':
      await copyFileHandleToDirectory({
        sourceHandle: childHandle as FileSystemFileHandle,
        targetDirectoryHandle: nextDirectoryHandle,
      });
      break;
    case 'directory':
      await copyDirectoryHandleToDirectory({
        sourceHandle: childHandle as FileSystemDirectoryHandle,
        targetDirectoryHandle: nextDirectoryHandle,
      });
      break;
    default: {
      throw new Error(`Unhandled directory child kind: ${((childHandle satisfies never) as { readonly kind: string }).kind}`);
    }
    }
  }
}

async function deleteEntryPath({
  session,
  path,
}: {
  session: FileExplorerSession,
  path: string,
}): Promise<void> {
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

export function createFileExplorerWorker(): IFileExplorerWorker {
  return {
    async prepareSession({ request }) {
      const validated = fileExplorerPrepareSessionRequestSchema.parse(request);
      const sessionId = createSessionId();
      sessions.set(sessionId, await createSessionFromRoot({ root: validated.root }));
      return fileExplorerPrepareSessionResponseSchema.parse({ sessionId });
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
      const normalizedPath = normalizeExplorerPath({ path: validated.path });

      try {
        await resolveDirectory({ session, path: normalizedPath });
        return fileExplorerReadPreviewResponseSchema.parse({
          kind: 'directory',
        });
      } catch {
        // The path is not a directory; continue as file.
      }

      const resolvedFile = await resolveFile({ session, path: normalizedPath });
      const nativeFile = await (() => {
        switch (resolvedFile.kind) {
        case 'native-file':
          return resolvedFile.handle.getFile();
        case 'virtual-file':
          return Promise.resolve(undefined);
        default: {
          const _exhaustiveCheck: never = resolvedFile;
          throw new Error(`Unhandled resolved file: ${String(_exhaustiveCheck)}`);
        }
        }
      })();
      const virtualBytes = await (() => {
        switch (resolvedFile.kind) {
        case 'native-file':
          return Promise.resolve(undefined);
        case 'virtual-file':
          return readAllBytesFromVirtualFile({
            vfs: resolvedFile.vfs,
            path: resolvedFile.path,
          });
        default: {
          const _exhaustiveCheck: never = resolvedFile;
          throw new Error(`Unhandled resolved file: ${String(_exhaustiveCheck)}`);
        }
        }
      })();
      const extension = getFileExtension({ name: resolvedFile.name });
      const mimeCategory = getMimeCategory({ extension });
      const fileSize = nativeFile?.size ?? virtualBytes?.byteLength ?? 0;

      switch (mimeCategory) {
      case 'text': {
        if (validated.mode === 'bounded' && fileSize > TEXT_PREVIEW_SIZE_LIMIT) {
          return fileExplorerReadPreviewResponseSchema.parse({
            kind: 'text',
            rawText: '',
            displayText: '',
            languageHint: EXTENSION_LANGUAGE_MAP[extension],
            oversized: true,
          });
        }

        const rawText = nativeFile !== undefined
          ? await readBlobText({ blob: nativeFile })
          : new TextDecoder().decode(virtualBytes ?? new Uint8Array());
        let displayText = rawText;
        if (extension === '.json' || extension === '.jsonl') {
          try {
            displayText = JSON.stringify(JSON.parse(rawText), null, 2);
          } catch {
            displayText = rawText;
          }
        }
        return fileExplorerReadPreviewResponseSchema.parse({
          kind: 'text',
          rawText,
          displayText,
          languageHint: EXTENSION_LANGUAGE_MAP[extension],
          oversized: false,
        });
      }
      case 'image':
      case 'video':
      case 'audio':
        if (validated.mode === 'bounded' && fileSize > MEDIA_PREVIEW_SIZE_LIMIT) {
          return fileExplorerReadPreviewResponseSchema.parse({
            kind: 'media',
            mediaKind: mimeCategory,
            blob: new Blob([]),
            mimeType: nativeFile?.type ?? '',
            oversized: true,
          });
        }
        return fileExplorerReadPreviewResponseSchema.parse({
          kind: 'media',
          mediaKind: mimeCategory,
          blob: nativeFile ?? new Blob(virtualBytes === undefined ? [] : [uint8ArrayToBlobPart({ bytes: virtualBytes })]),
          mimeType: nativeFile?.type ?? '',
          oversized: false,
        });
      case 'binary':
        return fileExplorerReadPreviewResponseSchema.parse({
          kind: 'binary',
          oversized: false,
        });
      default: {
        const _exhaustiveCheck: never = mimeCategory;
        throw new Error(`Unhandled mime category: ${String(_exhaustiveCheck)}`);
      }
      }
    },

    async readFile({ request }) {
      const validated = fileExplorerReadFileRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      const resolvedFile = await resolveFile({
        session,
        path: validated.path,
      });
      switch (resolvedFile.kind) {
      case 'native-file':
        return fileExplorerReadFileResponseSchema.parse({
          blob: await resolvedFile.handle.getFile(),
        });
      case 'virtual-file':
        return fileExplorerReadFileResponseSchema.parse({
          blob: new Blob([uint8ArrayToBlobPart({
            bytes: await readAllBytesFromVirtualFile({
              vfs: resolvedFile.vfs,
              path: resolvedFile.path,
            }),
          })]),
        });
      default: {
        const _exhaustiveCheck: never = resolvedFile;
        throw new Error(`Unhandled resolved file: ${String(_exhaustiveCheck)}`);
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
      try {
        const normalizedPath = normalizeExplorerPath({ path: validated.directoryPath });
        const archiveRootName = getBaseNameFromPath({
          path: normalizedPath,
          rootName: session.rootName,
        });
        const result = await createFileExplorerDirectoryArchive({
          access: createDirectoryArchiveAccess({ session }),
          sourceRootPath: normalizedPath,
          archiveRootName,
          excludedRelativePaths: normalizeArchiveExcludedRelativePaths({
            paths: validated.excludedRelativePaths,
          }),
          signal: abortController.signal,
        });
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
        await deleteEntryPath({ session, path });
      }
    },

    async renameEntry({ request }) {
      const validated = fileExplorerRenameEntryRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      const normalizedSourcePath = normalizeExplorerPath({ path: validated.path });
      const sourceName = getBaseNameFromPath({
        path: normalizedSourcePath,
        rootName: session.rootName,
      });
      const parentDirectory = await resolveDirectory({
        session,
        path: getParentPath({ path: normalizedSourcePath }),
      });
      const writableParentDirectory = getWritableNativeDirectory({ directory: parentDirectory });

      try {
        const sourceFile = await writableParentDirectory.getFileHandle(sourceName);
        const targetFile = await writableParentDirectory.getFileHandle(validated.newName, { create: true });
        await copyFileSystemFileHandle({
          sourceHandle: sourceFile,
          targetHandle: targetFile,
          signal: undefined,
        });
      } catch {
        const sourceDirectory = await writableParentDirectory.getDirectoryHandle(sourceName);
        const targetDirectoryHandle = await writableParentDirectory.getDirectoryHandle(validated.newName, { create: true });
        for await (const childHandle of sourceDirectory.values()) {
          switch (childHandle.kind) {
          case 'file':
            await copyFileHandleToDirectory({
              sourceHandle: childHandle as FileSystemFileHandle,
              targetDirectoryHandle,
            });
            break;
          case 'directory':
            await copyDirectoryHandleToDirectory({
              sourceHandle: childHandle as FileSystemDirectoryHandle,
              targetDirectoryHandle,
            });
            break;
          default: {
            throw new Error(`Unhandled directory child kind: ${((childHandle satisfies never) as { readonly kind: string }).kind}`);
          }
          }
        }
      }

      await writableParentDirectory.removeEntry(sourceName, { recursive: true });
    },

    async copyEntries({ request }) {
      const validated = fileExplorerTransferEntriesRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      const targetDirectory = await resolveDirectory({
        session,
        path: validated.targetDirectoryPath,
      });
      const writableTargetDirectory = getWritableNativeDirectory({ directory: targetDirectory });

      for (const sourcePath of validated.sourcePaths) {
        const normalizedSourcePath = normalizeExplorerPath({ path: sourcePath });
        try {
          const sourceFile = await resolveFile({ session, path: normalizedSourcePath });
          switch (sourceFile.kind) {
          case 'native-file':
            await copyFileHandleToDirectory({
              sourceHandle: sourceFile.handle,
              targetDirectoryHandle: writableTargetDirectory,
            });
            break;
          case 'virtual-file':
            throw new Error(`Cannot copy virtual file: ${normalizedSourcePath}`);
          default: {
            const _exhaustiveCheck: never = sourceFile;
            throw new Error(`Unhandled resolved file: ${String(_exhaustiveCheck)}`);
          }
          }
          continue;
        } catch {
          const sourceDirectory = await resolveDirectory({
            session,
            path: normalizedSourcePath,
          });
          switch (sourceDirectory.kind) {
          case 'native-directory':
            await copyDirectoryHandleToDirectory({
              sourceHandle: sourceDirectory.handle,
              targetDirectoryHandle: writableTargetDirectory,
            });
            break;
          case 'virtual-directory':
            throw new Error(`Cannot copy virtual directory: ${normalizedSourcePath}`);
          default: {
            const _exhaustiveCheck: never = sourceDirectory;
            throw new Error(`Unhandled resolved directory: ${String(_exhaustiveCheck)}`);
          }
          }
        }
      }
    },

    async moveEntries({ request }) {
      const validated = fileExplorerTransferEntriesRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      await this.copyEntries({
        request: {
          sessionId: validated.sessionId,
          sourcePaths: validated.sourcePaths,
          targetDirectoryPath: validated.targetDirectoryPath,
        },
      });
      for (const sourcePath of validated.sourcePaths) {
        await deleteEntryPath({ session, path: sourcePath });
      }
    },

    async analyzeZipUpload({ request }) {
      const validated = fileExplorerAnalyzeZipUploadRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      const targetDirectory = await resolveDirectory({
        session,
        path: validated.targetDirectoryPath,
      });
      getWritableNativeDirectory({ directory: targetDirectory });
      const analysisKey = createZipUploadKey({
        sessionId: validated.sessionId,
        id: validated.analysisId,
      });
      try {
        const analysis = await parseZipUpload({
          blob: validated.blob,
          fileName: validated.fileName,
        });
        zipUploadAnalyses.set(analysisKey, {
          targetDirectoryPath: validated.targetDirectoryPath,
          analysis,
          previewFingerprints: new Map(),
        });
        return fileExplorerAnalyzeZipUploadResponseSchema.parse({
          status: 'extractable',
          analysisId: validated.analysisId,
          entryCount: analysis.entries.length,
          totalUncompressedSize: analysis.totalUncompressedSize,
          singleRootDirectoryName: analysis.singleRootDirectoryName,
        });
      } catch {
        zipUploadAnalyses.delete(analysisKey);
        return fileExplorerAnalyzeZipUploadResponseSchema.parse({
          status: 'not_extractable',
          analysisId: validated.analysisId,
          reason: 'invalid_or_unsupported_archive',
        });
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
        if (abortController.signal.aborted) {
          return fileExplorerExecuteZipUploadResponseSchema.parse({ status: 'cancelled' });
        }
        throw error;
      } finally {
        zipUploadJobs.delete(jobKey);
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
      zipUploadAnalyses.delete(createZipUploadKey({
        sessionId: validated.sessionId,
        id: validated.analysisId,
      }));
    },

    async uploadFiles({ request }) {
      const validated = fileExplorerUploadFilesRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      const targetDirectory = await resolveDirectory({
        session,
        path: validated.targetDirectoryPath,
      });
      const writableTargetDirectory = getWritableNativeDirectory({ directory: targetDirectory });

      for (const file of validated.files) {
        const targetFileHandle = await writableTargetDirectory.getFileHandle(file.name, { create: true });
        await writeReadableStreamToFileHandle({
          source: file.blob.stream(),
          targetHandle: targetFileHandle,
          signal: undefined,
        });
      }
    },

    async disposeSession({ request }) {
      const validated = fileExplorerDisposeSessionRequestSchema.parse(request);
      sessions.delete(validated.sessionId);
      for (const [jobKey, abortController] of directoryArchiveJobs) {
        if (jobKey.startsWith(`${validated.sessionId}\0`)) {
          abortController.abort(new DOMException('File explorer session disposed', 'AbortError'));
          directoryArchiveJobs.delete(jobKey);
        }
      }
      for (const [jobKey, abortController] of zipUploadJobs) {
        if (jobKey.startsWith(`${validated.sessionId}\0`)) {
          abortController.abort(new DOMException('File explorer session disposed', 'AbortError'));
          zipUploadJobs.delete(jobKey);
        }
      }
      for (const analysisKey of zipUploadAnalyses.keys()) {
        if (analysisKey.startsWith(`${validated.sessionId}\0`)) {
          zipUploadAnalyses.delete(analysisKey);
        }
      }
    },
  };
}
