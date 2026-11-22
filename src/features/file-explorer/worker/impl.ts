import { serveByteStream, byteStreamPortSchema } from '@/utils/byte-stream-port';

import { createValidatedMessagePort, workerTransfer, type WorkerServerApi } from '@/utils/worker-transport';
import { createRemoteDirectoryHandle, remoteDirectoryEntrySchema } from '@/utils/remote-directory-handle';
import type { ManagedVolumeRemoteAccess } from '@/features/wesh/worker/managed-volume-access';
import { getEffectiveWeshMounts } from '@/features/wesh/mount-policy';
import { WeshVFS } from '@/features/wesh/vfs';
import { openFileReadStream } from '@/features/wesh/utils/fs';
import { createWeshZipRandomAccessSource } from '@/features/wesh/zip-stream';
import { NaidanSysfsProvider } from '@/features/wesh/naidan-sysfs/provider';
import {
  createOpfsNaidanSysfsStorageReader,
  createRemoteNaidanSysfsStorageReader,
} from '@/features/wesh/naidan-sysfs/worker-storage-reader';
import { EXTENSION_LANGUAGE_MAP, MEDIA_PREVIEW_SIZE_LIMIT, TEXT_PREVIEW_SIZE_LIMIT } from '@/features/file-explorer/logic/constants';
import { getFileExtension, getMimeCategory } from '@/features/file-explorer/logic/utils';
import { FileExplorerNotDirectoryError } from '@/features/file-explorer/logic/errors';
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
import { ZipArchiveView } from './zip-archive-view';
import { inspectFileFormat } from './file-format';
import {
  findExistingFileHandle,
  matchesFileEditStamp,
  readBoundedFileStream,
  readFileEditStamp,
  withFileViewLock,
  withFileViewLocks,
  writeFileViewBlob,
  type FileEditFingerprint,
  type FileEditStamp,
} from './file-view-access';
import {
  copyFileSystemFileHandle,
  isFileSystemEntryLookupMiss,
  writeReadableStreamToFileHandle,
} from '@/utils/file-system-stream';
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
  fileExplorerReadFileForViewRequestSchema,
  fileExplorerReadFileForViewResponseSchema,
  fileExplorerSaveFileForViewRequestSchema,
  fileExplorerSaveFileForViewResponseSchema,
  fileExplorerFileViewCancelSchema,
  fileExplorerFileViewProgressSchema,
  fileExplorerInspectModelRequestSchema,
  MODEL_OVERVIEW_LABEL_LIMIT,
  fileExplorerReadModelValueRequestSchema,
  fileExplorerRewriteGgufRequestSchema,
  fileExplorerPrepareFileDownloadResponseSchema,
  fileExplorerReadPreviewRequestSchema,
  fileExplorerReadPreviewResponseSchema,
  fileExplorerRenameEntryRequestSchema,
  fileExplorerTransferEntriesRequestSchema,
  fileExplorerSuggestArchiveExclusionsRequestSchema,
  fileExplorerSuggestArchiveExclusionsResponseSchema,
  fileExplorerUploadFilesRequestSchema,
  type FileExplorerEntryRecord,
  type FileExplorerPathSegment,
  type FileExplorerReadFileForViewRequest,
  type FileExplorerReadFileForViewResponse,
  FILE_VIEW_PROBE_BYTES,
  type FileExplorerRootDescriptor,
  type FileExplorerSaveFileForViewResponse,
  type FileExplorerSaveFileTarget,
  type FileExplorerZipUploadPlacement,
  type IFileExplorerWorker,
} from './types';

interface CachedArchiveView {
  readonly sourceIdentity: string,
  readonly view: Promise<ZipArchiveView | undefined>,
}

interface FileExplorerSessionBase {
  readonly rootName: string,
  readonly archiveViews: Map<string, CachedArchiveView>,
  readonly editRevisions: Map<string, FileEditRevision>,
  readonly savingPaths: Set<string>,
}

type FileExplorerSession =
  | (FileExplorerSessionBase & {
    kind: 'native-directory',
    rootSource: 'opfs-root' | 'native-directory',
    rootHandle: FileSystemDirectoryHandle,
    readOnly: boolean,
  })
  | (FileExplorerSessionBase & {
    kind: 'wesh-mounts',
    vfs: WeshVFS,
    remoteDirectoryRoots: readonly FileSystemDirectoryHandle[],
  })
  | (FileExplorerSessionBase & {
    kind: 'archive-root',
    rootArchive: ZipArchiveView,
  });

type ResolvedDirectory =
  | {
    kind: 'native-directory',
    name: string,
    path: string,
    handle: FileSystemDirectoryHandle,
    readOnly: boolean,
    archiveBoundaryPaths: readonly string[],
  }
  | {
    kind: 'virtual-directory',
    name: string,
    path: string,
    readOnly: boolean,
    vfs: WeshVFS,
    archiveBoundaryPaths: readonly string[],
  }
  | {
    kind: 'zip-directory',
    name: string,
    path: string,
    readOnly: true,
    archive: ZipArchiveView,
    archiveRelativePath: string,
    archiveBoundaryPaths: readonly string[],
  };

type ResolvedFile =
  | {
    kind: 'native-file',
    name: string,
    path: string,
    handle: FileSystemFileHandle,
    readOnly: boolean,
  }
  | {
    kind: 'virtual-file',
    name: string,
    path: string,
    readOnly: boolean,
    vfs: WeshVFS,
  }
  | {
    kind: 'zip-file',
    name: string,
    path: string,
    readOnly: true,
    archive: ZipArchiveView,
    archiveRelativePath: string,
  };

interface FileEditRevision {
  id: string,
  handle: FileSystemFileHandle,
  stamp: FileEditStamp,
}

const sessions = new Map<string, FileExplorerSession>();
const directoryArchiveJobs = new Map<string, AbortController>();
const fileIoJobs = new Map<string, Set<AbortController>>();
const NESTED_ARCHIVE_MATERIALIZE_SIZE_LIMIT = 512 * 1024 * 1024;
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
  if (!path || path === '/') {
    return '/';
  }
  return `/${path.split('/').filter(segment => segment.length > 0).join('/')}`;
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
  managedVolumeRemoteAccess,
}: {
  root: FileExplorerRootDescriptor,
  naidanSysfsRemoteReader: NaidanSysfsRemoteReader | undefined,
  managedVolumeRemoteAccess: ManagedVolumeRemoteAccess | undefined,
}): Promise<FileExplorerSession> {
  const directoryHandleResolver = createFileSystemDirectoryHandleReferenceResolver();
  const archiveViews = new Map<string, CachedArchiveView>();
  const editRevisions = new Map<string, FileEditRevision>();
  const savingPaths = new Set<string>();
  switch (root.kind) {
  case 'opfs-root':
    return {
      kind: 'native-directory',
      rootSource: root.kind,
      rootName: root.rootName,
      rootHandle: await navigator.storage.getDirectory(),
      readOnly: false,
      archiveViews,
      editRevisions,
      savingPaths,
    };
  case 'native-directory':
    return {
      kind: 'native-directory',
      rootSource: root.kind,
      rootName: root.rootName,
      rootHandle: await directoryHandleResolver.resolve({ reference: root.handle }),
      readOnly: root.readOnly,
      archiveViews,
      editRevisions,
      savingPaths,
    };
  case 'wesh-mounts': {
    const vfs = new WeshVFS({ rootHandle: undefined });
    const remoteDirectoryRoots: FileSystemDirectoryHandle[] = [];
    for (const mount of getEffectiveWeshMounts({ mounts: root.mounts })) {
      switch (mount.type) {
      case 'directory':
        await vfs.mount({
          path: mount.path,
          handle: await directoryHandleResolver.resolve({ reference: mount.handle }),
          readOnly: mount.readOnly,
        });
        break;
      case 'managed_directory': {
        if (managedVolumeRemoteAccess === undefined) {
          throw new Error('Managed volume access is required for this directory');
        }
        const remoteAccess = managedVolumeRemoteAccess;
        const directoryRoot = remoteDirectoryEntrySchema.parse(await remoteAccess.getRoot({ path: mount.path }));
        const handle = createRemoteDirectoryHandle({
          root: directoryRoot,
          access: { request: ({ request }) => remoteAccess.request({ path: mount.path, request }) },
        });
        remoteDirectoryRoots.push(handle);
        await vfs.mount({
          path: mount.path,
          handle,
          readOnly: mount.readOnly,
        });
        break;
      }
      case 'naidan_sysfs': {
        const reader = await (() => {
          switch (mount.storageType) {
          case 'opfs':
            return createOpfsNaidanSysfsStorageReader();
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
    for (const mount of root.remoteMounts ?? []) {
      if (managedVolumeRemoteAccess === undefined) {
        throw new Error('Remote directory access is required for this mount');
      }
      const remoteAccess = managedVolumeRemoteAccess;
      const handle = createRemoteDirectoryHandle({
        root: mount.root,
        access: { request: ({ request }) => remoteAccess.request({ path: mount.path, request }) },
      });
      remoteDirectoryRoots.push(handle);
      await vfs.mount({
        path: mount.path,
        readOnly: mount.readOnly,
        handle,
      });
    }
    return {
      kind: 'wesh-mounts',
      rootName: root.rootName,
      vfs,
      remoteDirectoryRoots,
      archiveViews,
      editRevisions,
      savingPaths,
    };
  }
  case 'archive-root': {
    switch (root.archive.format) {
    case 'zip': {
      const source = root.archive.source;
      const rootArchive = await (() => {
        switch (source.kind) {
        case 'blob':
          return ZipArchiveView.open({ blob: source.blob });
        default: {
          const _exhaustiveCheck: never = source.kind;
          throw new Error(`Unhandled archive root source: ${String(_exhaustiveCheck)}`);
        }
        }
      })();
      archiveViews.set('/', { sourceIdentity: 'root', view: Promise.resolve(rootArchive) });
      return {
        kind: 'archive-root',
        rootName: root.rootName,
        rootArchive,
        archiveViews,
        editRevisions,
        savingPaths,
      };
    }
    default: {
      const _exhaustiveCheck: never = root.archive.format;
      throw new Error(`Unhandled archive root format: ${String(_exhaustiveCheck)}`);
    }
    }
  }
  default: {
    const _exhaustiveCheck: never = root;
    throw new Error(`Unhandled root descriptor: ${String(_exhaustiveCheck)}`);
  }
  }
}

async function resolveWeshDirectory({
  vfs,
  rootName,
  path,
  archiveBoundaryPaths,
}: {
  vfs: WeshVFS,
  rootName: string,
  path: string,
  archiveBoundaryPaths: readonly string[],
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
      archiveBoundaryPaths,
    };
  }

  return {
    kind: 'virtual-directory',
    name: getBaseNameFromPath({ path: normalizedPath, rootName }),
    path: normalizedPath,
    readOnly: true,
    vfs,
    archiveBoundaryPaths,
  };
}

async function getOrCreateArchiveView({
  session,
  path,
  sourceIdentity,
  createView,
}: {
  session: FileExplorerSession,
  path: string,
  sourceIdentity: string,
  createView: () => Promise<ZipArchiveView | undefined>,
}): Promise<ZipArchiveView | undefined> {
  const normalizedPath = normalizeExplorerPath({ path });
  const cached = session.archiveViews.get(normalizedPath);
  if (cached !== undefined && cached.sourceIdentity === sourceIdentity) {
    return cached.view;
  }
  if (cached !== undefined) {
    const descendantPrefix = normalizedPath === '/' ? '/' : `${normalizedPath}/`;
    for (const archivePath of session.archiveViews.keys()) {
      if (archivePath.startsWith(descendantPrefix)) {
        session.archiveViews.delete(archivePath);
      }
    }
  }
  const pending = createView();
  session.archiveViews.set(normalizedPath, { sourceIdentity, view: pending });
  void pending.catch(() => {
    const current = session.archiveViews.get(normalizedPath);
    if (current?.view === pending) {
      session.archiveViews.delete(normalizedPath);
    }
  });
  return pending;
}

async function openArchiveForBlob({
  session,
  path,
  blob,
  sourceIdentity,
}: {
  session: FileExplorerSession,
  path: string,
  blob: Blob,
  sourceIdentity: string,
}): Promise<ZipArchiveView | undefined> {
  return getOrCreateArchiveView({
    session,
    path,
    sourceIdentity,
    createView: () => ZipArchiveView.openIfZip({ blob }),
  });
}

async function openArchiveForVirtualFile({
  session,
  vfs,
  path,
  sourceStat,
}: {
  session: FileExplorerSession,
  vfs: WeshVFS,
  path: string,
  sourceStat: { readonly size: number, readonly mtime: number },
}): Promise<ZipArchiveView | undefined> {
  return getOrCreateArchiveView({
    session,
    path,
    sourceIdentity: `wesh:${sourceStat.size}:${sourceStat.mtime}`,
    createView: () => ZipArchiveView.openIfZipSource({
      createSource: async () => createWeshZipRandomAccessSource({
        handle: await vfs.open({
          path,
          flags: {
            access: 'read',
            creation: 'never',
            truncate: 'preserve',
            append: 'preserve',
          },
          mode: undefined,
        }),
        expectedStat: sourceStat,
      }),
    }),
  });
}

async function openNestedArchive({
  session,
  parentArchive,
  path,
  archiveRelativePath,
}: {
  session: FileExplorerSession,
  parentArchive: ZipArchiveView,
  path: string,
  archiveRelativePath: string,
}): Promise<ZipArchiveView | undefined> {
  const sourceIdentity = `nested:${parentArchive.cacheIdentity}:${archiveRelativePath}`;
  return getOrCreateArchiveView({
    session,
    path,
    sourceIdentity,
    createView: async () => {
      if (!await parentArchive.fileHasZipMagic({ relativePath: archiveRelativePath })) {
        return undefined;
      }
      const uncompressedSize = parentArchive.getFileSize({ relativePath: archiveRelativePath });
      if (uncompressedSize > NESTED_ARCHIVE_MATERIALIZE_SIZE_LIMIT) {
        throw new Error(`Nested ZIP is too large to browse safely: ${archiveRelativePath}`);
      }
      return ZipArchiveView.open({
        blob: await parentArchive.readFileBlob({ relativePath: archiveRelativePath }),
      });
    },
  });
}

async function resolveRootDirectory({
  session,
}: {
  session: FileExplorerSession,
}): Promise<ResolvedDirectory> {
  switch (session.kind) {
  case 'native-directory':
    return {
      kind: 'native-directory',
      name: session.rootName,
      path: '/',
      handle: session.rootHandle,
      readOnly: session.readOnly,
      archiveBoundaryPaths: [],
    };
  case 'wesh-mounts':
    return resolveWeshDirectory({
      vfs: session.vfs,
      rootName: session.rootName,
      path: '/',
      archiveBoundaryPaths: [],
    });
  case 'archive-root':
    return {
      kind: 'zip-directory',
      name: session.rootName,
      path: '/',
      readOnly: true,
      archive: session.rootArchive,
      archiveRelativePath: '',
      archiveBoundaryPaths: ['/'],
    };
  default: {
    const _exhaustiveCheck: never = session;
    throw new Error(`Unhandled file explorer session: ${String(_exhaustiveCheck)}`);
  }
  }
}

async function resolveWeshChildDirectory({
  session,
  directory,
  path,
}: {
  session: Extract<FileExplorerSession, { kind: 'wesh-mounts' }>,
  directory: ResolvedDirectory,
  path: string,
}): Promise<ResolvedDirectory> {
  const stat = await session.vfs.stat({ path }).catch(() => undefined);
  if (stat === undefined) {
    throw new Error(`Directory not found: ${path}`);
  }
  switch (stat.type) {
  case 'directory':
    return resolveWeshDirectory({
      vfs: session.vfs,
      rootName: session.rootName,
      path,
      archiveBoundaryPaths: directory.archiveBoundaryPaths,
    });
  case 'file': {
    const nativeHandle = await session.vfs.getNativeHandle({ path });
    let archive: ZipArchiveView | undefined;
    if (nativeHandle !== null && nativeHandle.kind === 'file') {
      const file = await (nativeHandle as FileSystemFileHandle).getFile();
      archive = await openArchiveForBlob({
        session,
        path,
        blob: file,
        sourceIdentity: `native:${file.size}:${file.lastModified}`,
      });
    } else {
      archive = await openArchiveForVirtualFile({
        session,
        vfs: session.vfs,
        path,
        sourceStat: { size: stat.size, mtime: stat.mtime },
      });
    }
    if (archive === undefined) {
      throw new FileExplorerNotDirectoryError({ path });
    }
    return {
      kind: 'zip-directory',
      name: getBaseNameFromPath({ path, rootName: session.rootName }),
      path,
      readOnly: true,
      archive,
      archiveRelativePath: '',
      archiveBoundaryPaths: [...directory.archiveBoundaryPaths, path],
    };
  }
  case 'symlink':
  case 'fifo':
  case 'chardev':
    throw new Error(`Directory not found: ${path}`);
  default: {
    const _exhaustiveCheck: never = stat.type;
    throw new Error(`Unhandled VFS entry type: ${String(_exhaustiveCheck)}`);
  }
  }
}

async function resolveChildDirectory({
  session,
  directory,
  name,
}: {
  session: FileExplorerSession,
  directory: ResolvedDirectory,
  name: string,
}): Promise<ResolvedDirectory> {
  const childPath = joinExplorerPath({ parentPath: directory.path, name });
  if (session.kind === 'wesh-mounts' && directory.kind !== 'zip-directory') {
    // Native-backed parents may contain more-specific mounts with different
    // handles or permissions, so keep resolving through the VFS until a ZIP.
    return resolveWeshChildDirectory({ session, directory, path: childPath });
  }
  switch (directory.kind) {
  case 'native-directory': {
    try {
      const handle = await directory.handle.getDirectoryHandle(name);
      return {
        kind: 'native-directory',
        name,
        path: childPath,
        handle,
        readOnly: directory.readOnly,
        archiveBoundaryPaths: directory.archiveBoundaryPaths,
      };
    } catch (error) {
      if (!isFileSystemEntryLookupMiss({ error })) {
        throw error;
      }
    }

    let fileHandle: FileSystemFileHandle;
    try {
      fileHandle = await directory.handle.getFileHandle(name);
    } catch (error) {
      if (isFileSystemEntryLookupMiss({ error })) {
        throw new Error(`Directory not found: ${childPath}`);
      }
      throw error;
    }
    const file = await fileHandle.getFile();
    const archive = await openArchiveForBlob({
      session,
      path: childPath,
      blob: file,
      sourceIdentity: `native:${file.size}:${file.lastModified}`,
    });
    if (archive === undefined) {
      throw new FileExplorerNotDirectoryError({ path: childPath });
    }
    return {
      kind: 'zip-directory',
      name,
      path: childPath,
      readOnly: true,
      archive,
      archiveRelativePath: '',
      archiveBoundaryPaths: [...directory.archiveBoundaryPaths, childPath],
    };
  }
  case 'virtual-directory':
    throw new Error(`Virtual directory outside a Wesh session: ${directory.path}`);
  case 'zip-directory': {
    const archiveRelativePath = directory.archiveRelativePath === ''
      ? name
      : `${directory.archiveRelativePath}/${name}`;
    if (directory.archive.hasDirectory({ relativePath: archiveRelativePath })) {
      return {
        kind: 'zip-directory',
        name,
        path: childPath,
        readOnly: true,
        archive: directory.archive,
        archiveRelativePath,
        archiveBoundaryPaths: directory.archiveBoundaryPaths,
      };
    }
    if (!directory.archive.hasFile({ relativePath: archiveRelativePath })) {
      throw new Error(`Directory not found: ${childPath}`);
    }
    const archive = await openNestedArchive({
      session,
      parentArchive: directory.archive,
      path: childPath,
      archiveRelativePath,
    });
    if (archive === undefined) {
      throw new FileExplorerNotDirectoryError({ path: childPath });
    }
    return {
      kind: 'zip-directory',
      name,
      path: childPath,
      readOnly: true,
      archive,
      archiveRelativePath: '',
      archiveBoundaryPaths: [...directory.archiveBoundaryPaths, childPath],
    };
  }
  default: {
    const _exhaustiveCheck: never = directory;
    throw new Error(`Unhandled resolved directory: ${String(_exhaustiveCheck)}`);
  }
  }
}

async function resolveDirectory({
  session,
  path,
}: {
  session: FileExplorerSession,
  path: string,
}): Promise<ResolvedDirectory> {
  const normalizedPath = normalizeExplorerPath({ path });
  let directory = await resolveRootDirectory({ session });
  for (const segment of splitExplorerPath({ path: normalizedPath })) {
    directory = await resolveChildDirectory({ session, directory, name: segment });
  }
  return directory;
}

async function resolveFile({
  session,
  path,
}: {
  session: FileExplorerSession,
  path: string,
}): Promise<ResolvedFile> {
  const normalizedPath = normalizeExplorerPath({ path });
  if (normalizedPath === '/') {
    throw new Error('Root is not a file');
  }
  const name = getBaseNameFromPath({ path: normalizedPath, rootName: session.rootName });
  const parentDirectory = await resolveDirectory({
    session,
    path: getParentPath({ path: normalizedPath }),
  });

  if (session.kind === 'wesh-mounts' && parentDirectory.kind !== 'zip-directory') {
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
    const stat = await session.vfs.stat({ path: normalizedPath }).catch(() => undefined);
    if (stat === undefined) {
      throw new Error(`File not found: ${normalizedPath}`);
    }
    switch (stat.type) {
    case 'file':
      return {
        kind: 'virtual-file',
        name,
        path: normalizedPath,
        readOnly: session.vfs.getReadOnlyForPath({ path: normalizedPath }),
        vfs: session.vfs,
      };
    case 'directory':
    case 'symlink':
    case 'fifo':
    case 'chardev':
      throw new Error(`File not found: ${normalizedPath}`);
    default: {
      const exhaustive: never = stat.type;
      throw new Error(`Unhandled VFS entry type: ${String(exhaustive)}`);
    }
    }
  }

  switch (parentDirectory.kind) {
  case 'native-directory': {
    const handle = await parentDirectory.handle.getFileHandle(name);
    return {
      kind: 'native-file',
      name,
      path: normalizedPath,
      handle,
      readOnly: parentDirectory.readOnly,
    };
  }
  case 'virtual-directory':
    throw new Error(`Virtual directory outside a Wesh session: ${parentDirectory.path}`);
  case 'zip-directory': {
    const archiveRelativePath = parentDirectory.archiveRelativePath === ''
      ? name
      : `${parentDirectory.archiveRelativePath}/${name}`;
    if (!parentDirectory.archive.hasFile({ relativePath: archiveRelativePath })) {
      throw new Error(`File not found: ${normalizedPath}`);
    }
    return {
      kind: 'zip-file',
      name,
      path: normalizedPath,
      readOnly: true,
      archive: parentDirectory.archive,
      archiveRelativePath,
    };
  }
  default: {
    const _exhaustiveCheck: never = parentDirectory;
    throw new Error(`Unhandled resolved directory: ${String(_exhaustiveCheck)}`);
  }
  }
}

async function readVirtualFileBytes({
  vfs,
  path,
  maximumBytes,
  signal,
}: {
  vfs: WeshVFS,
  path: string,
  maximumBytes: number | undefined,
  signal: AbortSignal | undefined,
}): Promise<Uint8Array> {
  signal?.throwIfAborted();
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
    let readBytes = 0;
    while (maximumBytes === undefined || readBytes < maximumBytes) {
      signal?.throwIfAborted();
      const buffer = new Uint8Array(Math.min(64 * 1024, maximumBytes === undefined ? Infinity : maximumBytes - readBytes));
      const { bytesRead } = await handle.read({ buffer });
      signal?.throwIfAborted();
      if (bytesRead === 0) {
        break;
      }
      chunks.push(buffer.subarray(0, bytesRead));
      readBytes += bytesRead;
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

function isResolvedFileLookupMiss({ error }: { error: unknown }): boolean {
  if (isFileSystemEntryLookupMiss({ error })) {
    return true;
  }
  return error instanceof Error && error.message.startsWith('File not found:');
}

async function readResolvedFileBlob({ file }: { file: ResolvedFile }): Promise<Blob> {
  switch (file.kind) {
  case 'native-file':
    return file.handle.getFile();
  case 'virtual-file':
    return new Blob([uint8ArrayToBlobPart({
      bytes: await readVirtualFileBytes({ vfs: file.vfs, path: file.path, maximumBytes: undefined, signal: undefined }),
    })]);
  case 'zip-file':
    return file.archive.readFileBlob({ relativePath: file.archiveRelativePath });
  default: {
    const _exhaustiveCheck: never = file;
    throw new Error(`Unhandled resolved file: ${String(_exhaustiveCheck)}`);
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
  case 'zip-directory':
    throw new DOMException('Read-only file system', 'NotAllowedError');
  default: {
    const _exhaustiveCheck: never = directory;
    throw new Error(`Unhandled resolved directory: ${String(_exhaustiveCheck)}`);
  }
  }
}

function validateFileViewPath({ path }: { path: string }): string {
  const segments = splitExplorerPath({ path });
  if (segments.some(segment => segment === '.' || segment === '..' || segment.includes('\0'))) {
    throw new TypeError('Invalid file view path');
  }
  return normalizeExplorerPath({ path });
}

function isProtectedFileEditTarget({ session, path }: {
  session: FileExplorerSession,
  path: string,
}): boolean {
  return session.kind === 'native-directory'
    && session.rootSource === 'opfs-root'
    && (path === '/naidan-storage/settings.json'
      || path === '/naidan-storage/hierarchy.json'
      || path === '/naidan-storage/migration-state.json');
}

async function isReadOnlyFileViewPath({ session, path }: {
  session: FileExplorerSession,
  path: string,
}): Promise<boolean> {
  switch (session.kind) {
  case 'native-directory':
  case 'archive-root':
    return false;
  case 'wesh-mounts': {
    const { fullPath } = await session.vfs.resolve({ path });
    // The named entry may be a symlink out of a writable mount.
    return session.vfs.getReadOnlyForPath({ path: fullPath });
  }
  default: {
    const exhaustive: never = session;
    throw new Error(String(exhaustive));
  }
  }
}

async function registerFileEditRevision({ session, path, handle, stamp, signal }: {
  session: FileExplorerSession,
  path: string,
  handle: FileSystemFileHandle,
  stamp: FileEditStamp,
  signal: AbortSignal,
}): Promise<string> {
  const registered = session.editRevisions.get(path);
  if (registered && matchesFileEditStamp({ current: stamp, expected: registered.stamp })
    && await handle.isSameEntry(registered.handle)) {
    return registered.id;
  }
  signal.throwIfAborted();
  const id = createSessionId();
  session.editRevisions.set(path, { id, handle, stamp });
  return id;
}

async function resolveFileForView({ session, request, signal }: {
  session: FileExplorerSession,
  request: Exclude<FileExplorerReadFileForViewRequest, { mode: 'inspect' }>,
  signal: AbortSignal,
}): Promise<FileExplorerReadFileForViewResponse> {
  const path = validateFileViewPath({ path: request.path });
  const file = await resolveFile({ session, path });
  const { name } = file;
  signal.throwIfAborted();
  switch (file.kind) {
  case 'native-file': {
    const { handle } = file;
    const editable = (request.mode === 'bounded' || request.mode === 'snapshot')
      && !file.readOnly
      && !isProtectedFileEditTarget({ session, path })
      && !await isReadOnlyFileViewPath({ session, path });
    async function readSnapshot(): Promise<FileExplorerReadFileForViewResponse> {
      const snapshot = await handle.getFile();
      const { size, lastModified } = snapshot;
      signal.throwIfAborted();
      switch (request.mode) {
      case 'range': {
        const offset = Math.min(size, request.offset);
        const length = Math.min(size - offset, request.maxBytes);
        return {
          kind: 'file',
          name,
          blob: snapshot.slice(offset, offset + length),
          size,
          lastModified,
          partial: offset + length < size,
          rangeReadable: true,
        };
      }
      case 'bounded': case 'prefix': case 'snapshot': break;
      default: {
        const exhaustive: never = request;
        throw new Error(`Unexpected file read: ${String(exhaustive)}`);
      }
      }
      if (request.mode === 'bounded' && size > request.maxBytes) {
        return { kind: 'too-large', name, size };
      }
      const partial = request.mode === 'prefix' && size > request.maxBytes;
      const revision = editable
        ? await registerFileEditRevision({
          session,
          path,
          handle,
          stamp: await readFileEditStamp({ file: snapshot, signal }),
          signal,
        })
        : undefined;
      const blob = partial ? snapshot.slice(0, request.maxBytes, snapshot.type) : snapshot;
      return { kind: 'file', name, blob, size, lastModified, partial, revision, rangeReadable: true };
    }
    // The read must take its editable snapshot under the same lock as the
    // commit. A late hash of the original file cannot replace the new revision.
    return editable ? withFileViewLock({ name: handle.name, signal, run: readSnapshot }) : readSnapshot();
  }
  case 'virtual-file': {
    switch (request.mode) {
    case 'snapshot': case 'range':
      return { kind: 'unsupported', name };
    case 'bounded':
    case 'prefix':
      break;
    default: {
      const exhaustive: never = request;
      throw new Error(String(exhaustive));
    }
    }
    // Read one extra byte to detect truncation without trusting a VFS stat.
    const bytes = await readVirtualFileBytes({ vfs: file.vfs, path, maximumBytes: request.maxBytes + 1, signal });
    const partial = bytes.byteLength > request.maxBytes;
    if (partial && request.mode === 'bounded') {
      return { kind: 'too-large', name };
    }
    const blob = new Blob([uint8ArrayToBlobPart({ bytes: bytes.subarray(0, request.maxBytes) })]);
    return { kind: 'file', name, blob, size: partial ? undefined : blob.size, partial };
  }
  case 'zip-file': {
    switch (request.mode) {
    case 'snapshot': case 'range':
      return { kind: 'unsupported', name };
    case 'bounded':
    case 'prefix':
      break;
    default: {
      const exhaustive: never = request;
      throw new Error(String(exhaustive));
    }
    }
    const size = file.archive.getFileSize({ relativePath: file.archiveRelativePath });
    if (request.mode === 'bounded' && size > request.maxBytes) {
      return { kind: 'too-large', name, size };
    }
    const stream = await file.archive.openFileStream({ relativePath: file.archiveRelativePath });
    const { blob, partial } = await readBoundedFileStream({ stream, maxBytes: request.maxBytes, signal });
    if (partial && request.mode === 'bounded') {
      return { kind: 'too-large', name };
    }
    const lastModified = file.archive.getFileModifiedAt({ relativePath: file.archiveRelativePath });
    return { kind: 'file', name, blob, size, lastModified, partial };
  }
  default: {
    const exhaustive: never = file;
    throw new Error(String(exhaustive));
  }
  }
}

async function assertFileEditRevision({ session, path, expected, signal }: {
  session: FileExplorerSession,
  path: string,
  expected: FileEditRevision,
  signal: AbortSignal,
}): Promise<FileSystemFileHandle> {
  signal.throwIfAborted();
  const changed = new DOMException('The file changed after it was opened', 'InvalidStateError');
  let file: ResolvedFile;
  try {
    file = await resolveFile({ session, path });
  } catch (error) {
    if (isResolvedFileLookupMiss({ error }) || (error instanceof Error && error.message.startsWith('Directory not found:'))) {
      throw changed;
    }
    throw error;
  }
  if (file.kind !== 'native-file' || file.readOnly || await isReadOnlyFileViewPath({ session, path })) {
    throw new DOMException('Read-only file system', 'NotAllowedError');
  }
  if (!await file.handle.isSameEntry(expected.handle)) {
    throw changed;
  }
  const current = await readFileEditStamp({ file: await file.handle.getFile(), signal });
  if (!matchesFileEditStamp({ current, expected: expected.stamp })) {
    throw changed;
  }
  return file.handle;
}

async function saveFileForView({ session, target, blob, signal, onProgress }: {
  session: FileExplorerSession,
  target: FileExplorerSaveFileTarget,
  blob: Blob,
  signal: AbortSignal,
  onProgress: ({ writtenBytes, totalBytes }: { writtenBytes: number, totalBytes: number }) => void,
}): Promise<FileExplorerSaveFileForViewResponse> {
  const { path, lockName, write } = (() => {
    switch (target.kind) {
    case 'replace': {
      const path = validateFileViewPath({ path: target.path });
      return {
        path,
        lockName: session.editRevisions.get(path)?.handle.name,
        write: () => replaceFileForView({ session, path, revision: target.revision, blob, signal, onProgress }),
      };
    }
    case 'create':
      return {
        path: joinExplorerPath({ parentPath: validateFileViewPath({ path: target.directoryPath }), name: target.name }),
        lockName: target.name,
        write: () => createFileForView({ session, directoryPath: target.directoryPath, name: target.name, blob, signal, onProgress }),
      };
    default: {
      const exhaustive: never = target;
      throw new Error(String(exhaustive));
    }
    }
  })();
  if (isProtectedFileEditTarget({ session, path })) {
    throw new DOMException('Naidan manages this file', 'NotAllowedError');
  }
  if (session.savingPaths.has(path)) {
    throw new DOMException('A save is already in progress for this file', 'InvalidStateError');
  }
  signal.throwIfAborted();
  session.savingPaths.add(path);

  try {
    if (lockName === undefined) {
      throw new DOMException('The file changed after it was opened', 'InvalidStateError');
    }
    return await withFileViewLocks({
      names: [lockName],
      mode: 'shared',
      signal,
      async run() {
        const { handle, fingerprint } = await write();
        session.editRevisions.delete(path);
        const revision = await registerCommittedFileViewRevision({ session, path, handle, fingerprint, signal });
        return { path, revision };
      },
    });
  } finally {
    session.savingPaths.delete(path);
  }
}

async function registerCommittedFileViewRevision({ session, path, handle, fingerprint, signal }: {
  session: FileExplorerSession,
  path: string,
  handle: FileSystemFileHandle,
  fingerprint: FileEditFingerprint,
  signal: AbortSignal,
}): Promise<string | undefined> {
  // Non-cooperating editors can still race the platform commit. If the current
  // target no longer matches our output, acknowledge the completed save but
  // withhold its revision. Huge files use bounded prefix/suffix fingerprints:
  // an intervening same-size edit outside both windows may be undetectable.
  try {
    const file = await resolveFile({ session, path });
    if (file.kind !== 'native-file' || file.readOnly || await isReadOnlyFileViewPath({ session, path })
      || !await file.handle.isSameEntry(handle)) {
      return undefined;
    }
    const stamp = await readFileEditStamp({ file: await file.handle.getFile(), signal });
    if (stamp.size !== fingerprint.size || stamp.digest !== fingerprint.digest) {
      return undefined;
    }
    return await registerFileEditRevision({ session, path, handle: file.handle, stamp, signal });
  } catch {
    return undefined;
  }
}

async function replaceFileForView({ session, path, revision, blob, signal, onProgress }: {
  session: FileExplorerSession,
  path: string,
  revision: string,
  blob: Blob,
  signal: AbortSignal,
  onProgress: ({ writtenBytes, totalBytes }: { writtenBytes: number, totalBytes: number }) => void,
}): Promise<{ handle: FileSystemFileHandle, fingerprint: FileEditFingerprint }> {
  const expected = session.editRevisions.get(path);
  if (!expected || expected.id !== revision) {
    throw new DOMException('The file changed after it was opened', 'InvalidStateError');
  }
  const handle = await assertFileEditRevision({ session, path, expected, signal });
  const fingerprint = await writeFileViewBlob({
    blob,
    handle,
    signal,
    onProgress,
    async beforeCommit() {
      await assertFileEditRevision({ session, path, expected, signal });
    },
  });
  return { handle, fingerprint };
}

async function createFileForView({ session, directoryPath, name, blob, signal, onProgress }: {
  session: FileExplorerSession,
  directoryPath: string,
  name: string,
  blob: Blob,
  signal: AbortSignal,
  onProgress: ({ writtenBytes, totalBytes }: { writtenBytes: number, totalBytes: number }) => void,
}): Promise<{ handle: FileSystemFileHandle, fingerprint: FileEditFingerprint }> {
  const parentPath = validateFileViewPath({ path: directoryPath });
  async function resolveTargetDirectory(): Promise<FileSystemDirectoryHandle> {
    const resolved = await resolveDirectory({ session, path: parentPath });
    if (await isReadOnlyFileViewPath({ session, path: parentPath })) {
      throw new DOMException('Read-only file system', 'NotAllowedError');
    }
    return getWritableNativeDirectory({ directory: resolved });
  }
  const directory = await resolveTargetDirectory();
  const exists = new DOMException('A file with that name already exists', 'InvalidModificationError');
  async function reserveName() {
    if (await findExistingFileHandle({ directory, name })) {
      throw exists;
    }
    signal.throwIfAborted();
    const handle = await directory.getFileHandle(name, { create: true });
    const baseline = await handle.getFile();
    if (baseline.size !== 0) {
      throw exists;
    }
    return { handle, baseline };
  }

  const { handle, baseline } = await reserveName();

  const isSameEmptyFile = async ({ directory: currentDirectory }: { directory: FileSystemDirectoryHandle }): Promise<boolean> => {
    const current = await findExistingFileHandle({ directory: currentDirectory, name });
    if (!current || !await current.isSameEntry(handle)) {
      return false;
    }
    const snapshot = await current.getFile();
    return snapshot.size === 0 && snapshot.lastModified === baseline.lastModified;
  };
  // The File System Access API cannot prove ownership of the empty entry.
  // Aborting the output must avoid deleting an entry created by another app.
  const fingerprint = await writeFileViewBlob({
    blob,
    handle,
    signal,
    onProgress,
    async beforeCommit() {
      const currentDirectory = await resolveTargetDirectory();
      if (!await isSameEmptyFile({ directory: currentDirectory })) {
        throw exists;
      }
    },
  });
  return { handle, fingerprint };
}

async function runFileViewOperation<TResult>({ sessionId, port, run }: {
  sessionId: string,
  port: MessagePort,
  run: ({ signal, onProgress }: {
    signal: AbortSignal,
    onProgress: ({ writtenBytes, totalBytes }: { writtenBytes: number, totalBytes: number }) => void,
  }) => Promise<TResult>,
}): Promise<TResult> {
  byteStreamPortSchema.parse(port);
  const controller = new AbortController();
  const channel = createValidatedMessagePort({
    port,
    incomingSchema: fileExplorerFileViewCancelSchema,
    outgoingSchema: fileExplorerFileViewProgressSchema,
    onMessage() {
      controller.abort(new DOMException('File operation cancelled', 'AbortError'));
    },
    onError({ reason }) {
      controller.abort(reason);
    },
  });
  const jobs = fileIoJobs.get(sessionId) ?? new Set<AbortController>();
  fileIoJobs.set(sessionId, jobs);
  jobs.add(controller);
  try {
    return await run({
      signal: controller.signal,
      onProgress: ({ writtenBytes, totalBytes }) => channel.send({ message: { writtenBytes, totalBytes }, transferables: [] }),
    });
  } finally {
    channel.close();
    jobs.delete(controller);
    if (jobs.size === 0) {
      fileIoJobs.delete(sessionId);
    }
  }
}

async function listDirectoryEntries({
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
    return listWeshVirtualDirectoryEntries({
      vfs: directory.vfs,
      directoryPath: directory.path,
    });
  case 'zip-directory':
    return listZipDirectoryEntries({ directory });
  default: {
    const _exhaustiveCheck: never = directory;
    throw new Error(`Unhandled resolved directory: ${String(_exhaustiveCheck)}`);
  }
  }
}

function listZipDirectoryEntries({
  directory,
}: {
  directory: Extract<ResolvedDirectory, { kind: 'zip-directory' }>,
}): FileExplorerEntryRecord[] {
  return directory.archive.listDirectory({ relativePath: directory.archiveRelativePath }).map(child => {
    const common = {
      path: joinExplorerPath({ parentPath: directory.path, name: child.name }),
      name: child.name,
      size: child.size,
      lastModified: child.lastModified,
      readOnly: true,
      canMutate: false,
    } as const;
    switch (child.kind) {
    case 'file': {
      const extension = getFileExtension({ name: child.name });
      return {
        ...common,
        kind: 'file',
        extension,
        mimeCategory: getMimeCategory({ extension }),
        canNavigate: false,
      };
    }
    case 'directory':
      return {
        ...common,
        kind: 'directory',
        extension: '',
        mimeCategory: 'binary',
        canNavigate: true,
      };
    default: {
      const _exhaustiveCheck: never = child.kind;
      throw new Error(`Unhandled ZIP entry kind: ${String(_exhaustiveCheck)}`);
    }
    }
  });
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
        case 'archive-root':
          throw new Error(`Virtual directory not supported for ${session.kind} session: ${directory.path}`);
        default: {
          const _ex: never = session;
          throw new Error(`Unhandled file explorer session: ${String(_ex)}`);
        }
        }
      case 'zip-directory':
        return directory.archive.listDirectory({ relativePath: directory.archiveRelativePath }).map(entry => ({
          name: entry.name,
          kind: entry.kind,
          modifiedAt: entry.lastModified === undefined ? undefined : new Date(entry.lastModified),
        }));
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
      case 'zip-file':
        return file.archive.openFileStream({ relativePath: file.archiveRelativePath });
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
    case 'archive-root':
      throw new Error(`Virtual directory not supported for ${session.kind} session: ${directory.path}`);
    default: {
      const _ex: never = session;
      throw new Error(`Unhandled file explorer session: ${String(_ex)}`);
    }
    }
  case 'zip-directory':
    return directory.archive.listDirectory({ relativePath: directory.archiveRelativePath }).map(entry => ({
      name: entry.name,
      kind: entry.kind,
      modifiedAt: entry.lastModified === undefined ? undefined : new Date(entry.lastModified),
    }));
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
  archiveBoundaryPaths,
}: {
  path: string,
  rootName: string,
  archiveBoundaryPaths: readonly string[],
}): FileExplorerPathSegment[] {
  const normalizedPath = normalizeExplorerPath({ path });
  const segments = splitExplorerPath({ path: normalizedPath });
  const archiveBoundaries = new Set(archiveBoundaryPaths);
  const pathSegments: FileExplorerPathSegment[] = [
    fileExplorerPathSegmentSchema.parse({
      name: rootName,
      path: '/',
      kind: archiveBoundaries.has('/') ? 'archive' : 'root',
    }),
  ];

  for (let i = 0; i < segments.length; i += 1) {
    const segmentPath = `/${segments.slice(0, i + 1).join('/')}`;
    pathSegments.push(fileExplorerPathSegmentSchema.parse({
      name: segments[i]!,
      path: segmentPath,
      kind: archiveBoundaries.has(segmentPath) ? 'archive' : 'directory',
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
  name,
}: {
  sourceHandle: FileSystemDirectoryHandle,
  targetDirectoryHandle: FileSystemDirectoryHandle,
  name: string,
}): Promise<void> {
  const nextDirectoryHandle = await targetDirectoryHandle.getDirectoryHandle(name, { create: true });
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
        name: childHandle.name,
      });
      break;
    default: {
      throw new Error(`Unhandled directory child kind: ${((childHandle satisfies never) as { readonly kind: string }).kind}`);
    }
    }
  }
}


async function copyZipFileToDirectory({
  archive,
  archiveRelativePath,
  name,
  targetDirectoryHandle,
}: {
  archive: ZipArchiveView,
  archiveRelativePath: string,
  name: string,
  targetDirectoryHandle: FileSystemDirectoryHandle,
}): Promise<void> {
  const targetFileHandle = await targetDirectoryHandle.getFileHandle(name, { create: true });
  await writeReadableStreamToFileHandle({
    source: await archive.openFileStream({ relativePath: archiveRelativePath }),
    targetHandle: targetFileHandle,
    signal: undefined,
  });
}

async function copyZipDirectoryToDirectory({
  archive,
  archiveRelativePath,
  name,
  targetDirectoryHandle,
}: {
  archive: ZipArchiveView,
  archiveRelativePath: string,
  name: string,
  targetDirectoryHandle: FileSystemDirectoryHandle,
}): Promise<void> {
  const nextDirectoryHandle = await targetDirectoryHandle.getDirectoryHandle(name, { create: true });
  for (const child of archive.listDirectory({ relativePath: archiveRelativePath })) {
    const childRelativePath = archiveRelativePath === ''
      ? child.name
      : `${archiveRelativePath}/${child.name}`;
    switch (child.kind) {
    case 'file':
      await copyZipFileToDirectory({
        archive,
        archiveRelativePath: childRelativePath,
        name: child.name,
        targetDirectoryHandle: nextDirectoryHandle,
      });
      break;
    case 'directory':
      await copyZipDirectoryToDirectory({
        archive,
        archiveRelativePath: childRelativePath,
        name: child.name,
        targetDirectoryHandle: nextDirectoryHandle,
      });
      break;
    default: {
      const _exhaustiveCheck: never = child.kind;
      throw new Error(`Unhandled ZIP child kind: ${String(_exhaustiveCheck)}`);
    }
    }
  }
}

type TransferSource = Exclude<ResolvedFile | ResolvedDirectory, { kind: 'virtual-file' | 'virtual-directory' }>;
type MoveSource = { parent: FileSystemDirectoryHandle, name: string, handle: FileSystemFileHandle | FileSystemDirectoryHandle };

async function resolveTransferSource({ session, path }: { session: FileExplorerSession, path: string }): Promise<TransferSource> {
  let source: ResolvedFile | ResolvedDirectory;
  try {
    source = await resolveFile({ session, path });
  } catch (error) {
    if (!isResolvedFileLookupMiss({ error })) {
      throw error;
    }
    source = await resolveDirectory({ session, path });
  }
  switch (source.kind) {
  case 'native-file': case 'native-directory': case 'zip-file': case 'zip-directory':
    return source;
  case 'virtual-file': case 'virtual-directory':
    throw new Error(`Cannot copy virtual entry: ${path}`);
  default: {
    const exhaustive: never = source;
    throw new Error(String(exhaustive));
  }
  }
}

async function findTransferEntry({ directory, name, kind }: {
  directory: FileSystemDirectoryHandle,
  name: string,
  kind: 'file' | 'directory',
}): Promise<FileSystemFileHandle | FileSystemDirectoryHandle | undefined> {
  try {
    switch (kind) {
    case 'file': return await directory.getFileHandle(name);
    case 'directory': return await directory.getDirectoryHandle(name);
    default: {
      const exhaustive: never = kind;
      throw new Error(String(exhaustive));
    }
    }
  } catch (error) {
    if ((error instanceof DOMException || error instanceof Error) && error.name === 'NotFoundError') {
      return undefined;
    }
    throw error;
  }
}

async function assertMoveSource({ source }: { source: MoveSource }): Promise<void> {
  const entry = await findTransferEntry({ directory: source.parent, name: source.name, kind: source.handle.kind });
  if (entry === undefined || !await entry.isSameEntry(source.handle)) {
    throw new DOMException('The source path no longer identifies the entry being moved', 'InvalidModificationError');
  }
}

async function copyFileForRemoval({ source, target, name, signal }: {
  source: FileSystemFileHandle,
  target: FileSystemDirectoryHandle,
  name: string,
  signal: AbortSignal,
}): Promise<FileEditStamp> {
  const snapshot = await source.getFile();
  const stamp = await readFileEditStamp({ file: snapshot, signal });
  const destination = await target.getFileHandle(name, { create: true });
  await writeReadableStreamToFileHandle({ source: snapshot.stream(), targetHandle: destination, signal });
  return stamp;
}

async function removeTransferredSource({ source, stamp, signal }: {
  source: MoveSource,
  stamp: FileEditStamp | undefined,
  signal: AbortSignal,
}): Promise<void> {
  await assertMoveSource({ source });
  switch (source.handle.kind) {
  case 'file': {
    if (stamp === undefined) {
      throw new Error('A transferred file must have a source revision');
    }
    const current = await readFileEditStamp({ file: await source.handle.getFile(), signal });
    if (!matchesFileEditStamp({ current, expected: stamp })) {
      throw new DOMException('The source file changed during transfer', 'InvalidModificationError');
    }
    break;
  }
  case 'directory':
    break;
  default: {
    const exhaustive: never = source.handle;
    throw new Error(String(exhaustive));
  }
  }
  await source.parent.removeEntry(source.name, { recursive: true });
}

async function getTransferRemoteRoot({ session, entry }: {
  session: FileExplorerSession,
  entry: FileSystemHandle,
}): Promise<FileSystemDirectoryHandle | undefined> {
  switch (session.kind) {
  case 'wesh-mounts':
    for (const root of session.remoteDirectoryRoots) {
      // A remote root returns null for handles issued by another grant.
      if (root === entry || await root.resolve(entry) !== null) {
        return root;
      }
    }
    return undefined;
  case 'native-directory': case 'archive-root':
    return undefined;
  default: {
    const exhaustive: never = session;
    throw new Error(String(exhaustive));
  }
  }
}

async function copyTransferSource({ source, target, name, move, signal }: {
  source: TransferSource,
  target: FileSystemDirectoryHandle,
  name: string,
  move: MoveSource | undefined,
  signal: AbortSignal,
}): Promise<FileEditStamp | undefined> {
  switch (source.kind) {
  case 'native-file': {
    if (move !== undefined) {
      return copyFileForRemoval({ source: source.handle, target, name, signal });
    }
    await copyFileHandleToDirectory({ sourceHandle: source.handle, targetDirectoryHandle: target });
    return undefined;
  }
  case 'native-directory':
    await copyDirectoryHandleToDirectory({ sourceHandle: source.handle, targetDirectoryHandle: target, name });
    return undefined;
  case 'zip-file':
    await copyZipFileToDirectory({ archive: source.archive, archiveRelativePath: source.archiveRelativePath, name, targetDirectoryHandle: target });
    return undefined;
  case 'zip-directory':
    await copyZipDirectoryToDirectory({ archive: source.archive, archiveRelativePath: source.archiveRelativePath, name, targetDirectoryHandle: target });
    return undefined;
  default: {
    const exhaustive: never = source;
    throw new Error(String(exhaustive));
  }
  }
}

async function transferEntries({ session, sourcePaths, targetDirectoryPath, operation }: {
  session: FileExplorerSession,
  sourcePaths: readonly string[],
  targetDirectoryPath: string,
  operation: 'copy' | 'move',
}): Promise<void> {
  const target = getWritableNativeDirectory({ directory: await resolveDirectory({ session, path: targetDirectoryPath }) });
  if (await isReadOnlyFileViewPath({ session, path: targetDirectoryPath })) {
    throw new DOMException('Read-only file system', 'NotAllowedError');
  }
  const targetRemoteRoot = await getTransferRemoteRoot({ session, entry: target });
  const transfers: { source: TransferSource, name: string, kind: 'file' | 'directory', removal: MoveSource | undefined }[] = [];
  const names = new Set<string>();
  // Resolve all selected entries and their destination conflicts before opening a writer.
  for (const path of new Set(sourcePaths.map(sourcePath => normalizeExplorerPath({ path: sourcePath })))) {
    const parent = await (async () => {
      switch (operation) {
      case 'copy': return undefined;
      case 'move': return getWritableNativeDirectory({ directory: await resolveDirectory({ session, path: getParentPath({ path }) }) });
      default: {
        const exhaustive: never = operation;
        throw new Error(String(exhaustive));
      }
      }
    })();
    const source = await resolveTransferSource({ session, path });
    const nativeHandle = 'handle' in source ? source.handle : undefined;
    const name = nativeHandle?.name ?? source.name;
    let removal: MoveSource | undefined;
    if (parent !== undefined) {
      if (nativeHandle === undefined || await isReadOnlyFileViewPath({ session, path })) {
        throw new DOMException('Read-only file system', 'NotAllowedError');
      }
      removal = { parent, name: source.name, handle: nativeHandle };
    }
    const sourceRemoteRoot = nativeHandle === undefined ? undefined : await getTransferRemoteRoot({ session, entry: nativeHandle });
    const kind = await (async () => {
      switch (source.kind) {
      case 'native-directory': {
        if (sourceRemoteRoot !== targetRemoteRoot) {
          throw new DOMException('Cannot verify directory ancestry across remote mounts', 'NotSupportedError');
        }
        if (await source.handle.isSameEntry(target) || ((await source.handle.resolve(target))?.length ?? 0) > 0) {
          throw new DOMException('Cannot transfer a directory into itself or a descendant', 'InvalidModificationError');
        }
        return 'directory';
      }
      case 'zip-directory': return 'directory';
      case 'native-file': case 'zip-file': return 'file';
      default: {
        const exhaustive: never = source;
        throw new Error(String(exhaustive));
      }
      }
    })();
    const destination = await findTransferEntry({ directory: target, name, kind });
    if (destination !== undefined) {
      if (nativeHandle !== undefined && sourceRemoteRoot === targetRemoteRoot && await destination.isSameEntry(nativeHandle)) {
        continue;
      }
      throw new DOMException('An entry with that name already exists in the destination', 'InvalidModificationError');
    }
    if (names.has(name)) {
      throw new DOMException('Multiple entries would be transferred to the same name', 'InvalidModificationError');
    }
    names.add(name);
    transfers.push({ source, name, kind, removal });
  }

  if (transfers.length === 0) {
    return;
  }
  const removesDirectory = transfers.some(({ kind, removal }) => kind === 'directory' && removal !== undefined);
  const signal = new AbortController().signal;
  await withFileViewLocks({
    names: transfers.flatMap(({ name, removal }) => removal === undefined ? [name] : [name, removal.name]),
    mode: removesDirectory ? 'exclusive' : 'shared',
    signal,
    async run() {
      for (const { name, kind, removal } of transfers) {
        if (await findTransferEntry({ directory: target, name, kind })) {
          throw new DOMException('An entry with that name already exists in the destination', 'InvalidModificationError');
        }
        if (removal !== undefined) {
          await assertMoveSource({ source: removal });
        }
      }

      const removals: { source: MoveSource, stamp: FileEditStamp | undefined }[] = [];
      for (const { source, name, kind, removal } of transfers) {
        // A preceding copy may have created a differently spelled equivalent name.
        if (await findTransferEntry({ directory: target, name, kind })) {
          throw new DOMException('An entry with that name already exists in the destination', 'InvalidModificationError');
        }
        const stamp = await copyTransferSource({ source, target, name, move: removal, signal });
        if (removal !== undefined) {
          removals.push({ source: removal, stamp });
        }
      }
      for (const { source, stamp } of removals) {
        await removeTransferredSource({ source, stamp, signal });
      }
    },
  });
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

export function createFileExplorerWorker(): WorkerServerApi<IFileExplorerWorker> {
  return {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy values must remain top-level arguments.
    async prepareSession({ request }, naidanSysfsRemoteReader, managedVolumeRemoteAccess) {
      const validated = fileExplorerPrepareSessionRequestSchema.parse(request);
      const sessionId = createSessionId();
      sessions.set(sessionId, await createSessionFromRoot({
        root: validated.root,
        naidanSysfsRemoteReader,
        managedVolumeRemoteAccess,
      }));
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
          archiveBoundaryPaths: directory.archiveBoundaryPaths,
        }),
        entries,
      });
    },

    async readPreview({ request }) {
      const validated = fileExplorerReadPreviewRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      const normalizedPath = normalizeExplorerPath({ path: validated.path });

      let resolvedFile: ResolvedFile;
      try {
        if (normalizedPath === '/') {
          return fileExplorerReadPreviewResponseSchema.parse({ kind: 'directory' });
        }
        resolvedFile = await resolveFile({ session, path: normalizedPath });
      } catch (error) {
        if (!isResolvedFileLookupMiss({ error })) {
          throw error;
        }
        await resolveDirectory({ session, path: normalizedPath });
        return fileExplorerReadPreviewResponseSchema.parse({ kind: 'directory' });
      }

      const extension = getFileExtension({ name: resolvedFile.name });
      const mimeCategory = validated.format?.kind ?? getMimeCategory({ extension });
      // Unsupported binary previews need no payload, especially for huge VFS files.
      let previewLimit: number;
      switch (mimeCategory) {
      case 'binary':
        return fileExplorerReadPreviewResponseSchema.parse({ kind: 'binary', oversized: false });
      case 'text': previewLimit = TEXT_PREVIEW_SIZE_LIMIT;
        break;
      case 'image':
      case 'video':
      case 'audio': previewLimit = MEDIA_PREVIEW_SIZE_LIMIT;
        break;
      default: {
        const exhaustive: never = mimeCategory;
        throw new Error(`Unhandled preview category: ${String(exhaustive)}`);
      }
      }
      const maximumBytes = (() => {
        const mode = validated.mode;
        switch (mode) {
        case 'bounded': return previewLimit + 1;
        case 'force': return undefined;
        default: {
          const exhaustive: never = mode;
          throw new Error(`Unhandled preview mode: ${String(exhaustive)}`);
        }
        }
      })();
      const nativeFile = await (() => {
        switch (resolvedFile.kind) {
        case 'native-file':
          return resolvedFile.handle.getFile();
        case 'virtual-file':
        case 'zip-file':
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
        case 'zip-file':
          return Promise.resolve(undefined);
        case 'virtual-file':
          return readVirtualFileBytes({
            vfs: resolvedFile.vfs,
            path: resolvedFile.path,
            // Read one byte beyond the limit to detect truncation, even if a
            // concurrently changing virtual file has an inaccurate stat size.
            maximumBytes,
            signal: undefined,
          });
        default: {
          const _exhaustiveCheck: never = resolvedFile;
          throw new Error(`Unhandled resolved file: ${String(_exhaustiveCheck)}`);
        }
        }
      })();
      const fileSize = (() => {
        switch (resolvedFile.kind) {
        case 'native-file':
          return nativeFile?.size ?? 0;
        case 'virtual-file':
          return virtualBytes?.byteLength ?? 0;
        case 'zip-file':
          return resolvedFile.archive.getFileSize({ relativePath: resolvedFile.archiveRelativePath });
        default: {
          const exhaustive: never = resolvedFile;
          throw new Error(`Unhandled preview file: ${String(exhaustive)}`);
        }
        }
      })();

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

        const rawText = virtualBytes !== undefined
          ? new TextDecoder().decode(virtualBytes)
          : await readBlobText({ blob: nativeFile ?? await readResolvedFileBlob({ file: resolvedFile }) });
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
      case 'audio': {
        if (validated.mode === 'bounded' && fileSize > MEDIA_PREVIEW_SIZE_LIMIT) {
          return fileExplorerReadPreviewResponseSchema.parse({
            kind: 'media',
            mediaKind: mimeCategory,
            blob: new Blob([]),
            mimeType: '',
            oversized: true,
          });
        }
        const mediaBlob = nativeFile ?? (virtualBytes === undefined
          ? await readResolvedFileBlob({ file: resolvedFile })
          : new Blob([uint8ArrayToBlobPart({ bytes: virtualBytes })]));
        return fileExplorerReadPreviewResponseSchema.parse({
          kind: 'media',
          mediaKind: mimeCategory,
          blob: mediaBlob,
          mimeType: validated.format?.mimeType ?? mediaBlob.type,
          oversized: false,
        });
      }
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
      return fileExplorerReadFileResponseSchema.parse({
        blob: await readResolvedFileBlob({ file: resolvedFile }),
      });
    },

    async readFileForView({ request, port }) {
      const validated = fileExplorerReadFileForViewRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      return runFileViewOperation({
        sessionId: validated.sessionId,
        port,
        async run({ signal }) {
          switch (validated.mode) {
          case 'inspect': {
            const request = { ...validated, mode: 'prefix' as const, maxBytes: FILE_VIEW_PROBE_BYTES };
            const result = await resolveFileForView({ session, request, signal });
            switch (result.kind) {
            case 'file': {
              const bytes = new Uint8Array(await result.blob.arrayBuffer());
              signal.throwIfAborted();
              const format = await inspectFileFormat({ bytes, size: result.size, partial: result.partial });
              signal.throwIfAborted();
              return fileExplorerReadFileForViewResponseSchema.parse({ ...result, format });
            }
            case 'unsupported': case 'too-large': return fileExplorerReadFileForViewResponseSchema.parse(result);
            default: {
              const exhaustive: never = result;
              throw new Error(`Unexpected file read: ${String(exhaustive)}`);
            }
            }
          }
          case 'bounded': case 'prefix': case 'snapshot': case 'range':
            return fileExplorerReadFileForViewResponseSchema.parse(await resolveFileForView({ session, request: validated, signal }));
          default: {
            const exhaustive: never = validated;
            throw new Error(`Unexpected file read: ${String(exhaustive)}`);
          }
          }
        },
      });
    },

    async saveFileForView({ request, port }) {
      const validated = fileExplorerSaveFileForViewRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      return runFileViewOperation({
        sessionId: validated.sessionId,
        port,
        async run({ signal, onProgress }) {
          const result = await saveFileForView({
            session,
            target: validated.target,
            blob: validated.blob,
            signal,
            onProgress,
          });
          return fileExplorerSaveFileForViewResponseSchema.parse(result);
        },
      });
    },

    async inspectModelOverviewForView({ request, port }) {
      const { sessionId, file } = fileExplorerInspectModelRequestSchema.parse(request);
      getSession({ sessionId });
      return runFileViewOperation({
        sessionId,
        port,
        async run({ signal }) {
          const { inspectModelFileDetails } = await import('@/logic/model-file-inspection/metadata');
          const result = await inspectModelFileDetails({ file, signal });
          switch (result.status) {
          case 'weights': break;
          case 'unknown': case 'invalid': case 'lfs-pointer':
            return { status: result.status, reason: result.reason.slice(0, MODEL_OVERVIEW_LABEL_LIMIT) };
          default: {
            const exhaustive: never = result;
            throw new Error(`Unhandled model inspection: ${String(exhaustive)}`);
          }
          }
          // Keep validating the bounded header, with only the overview crossing the worker boundary.
          const { format, version, split, metadata, tensors } = result.value;
          function overviewLabel({ key }: { key: string }) {
            const value = metadata.find(entry => entry.key === key)?.value;
            return typeof value === 'string' ? value.slice(0, MODEL_OVERVIEW_LABEL_LIMIT) : value;
          }
          return {
            status: 'weights',
            value: {
              format,
              version,
              split,
              name: overviewLabel({ key: 'general.name' }),
              architecture: overviewLabel({ key: 'general.architecture' }),
              metadataCount: metadata.length,
              tensorCount: tensors.length,
            },
          };
        },
      });
    },

    async inspectModelForView({ request, port }) {
      const { sessionId, file } = fileExplorerInspectModelRequestSchema.parse(request);
      getSession({ sessionId });
      return runFileViewOperation({
        sessionId,
        port,
        async run({ signal }) {
          const { inspectModelFileDetails } = await import('@/logic/model-file-inspection/metadata');
          return inspectModelFileDetails({ file, signal });
        },
      });
    },

    async readModelValueForView({ request, port }) {
      const { sessionId, file, entry, start, limit } = fileExplorerReadModelValueRequestSchema.parse(request);
      getSession({ sessionId });
      return runFileViewOperation({
        sessionId,
        port,
        async run({ signal }) {
          const { readModelMetadataValue } = await import('@/logic/model-file-inspection/metadata');
          return readModelMetadataValue({ file, entry, start, limit, signal });
        },
      });
    },

    async rewriteGgufForView({ request, port }) {
      const { sessionId, file, changes } = fileExplorerRewriteGgufRequestSchema.parse(request);
      getSession({ sessionId });
      return runFileViewOperation({
        sessionId,
        port,
        async run({ signal }) {
          const { prepareGgufMetadataRewrite } = await import('@/logic/model-file-inspection/metadata');
          const result = await prepareGgufMetadataRewrite({ file, changes, signal });
          return workerTransfer({ value: result, transferables: [result.header.buffer] });
        },
      });
    },

    async prepareFileDownload({ request }) {
      const validated = fileExplorerReadFileRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      const resolvedFile = await resolveFile({ session, path: validated.path });
      switch (resolvedFile.kind) {
      case 'native-file':
        // Obtain size and data from one File, never a listing plus a later reopen.
        // File is structured-cloned by the existing worker transport, not read
        // into an ArrayBuffer. This includes OPFS and native-backed Wesh mounts.
        return fileExplorerPrepareFileDownloadResponseSchema.parse({
          kind: 'file',
          blob: await resolvedFile.handle.getFile(),
        });
      case 'virtual-file':
      case 'zip-file':
        // No eager read or Blob materialization for computed/mutable VFS or ZIP files.
        return fileExplorerPrepareFileDownloadResponseSchema.parse({ kind: 'stream' });
      default: {
        const exhaustive: never = resolvedFile;
        throw new Error(`Unhandled download file: ${String(exhaustive)}`);
      }
      }
    },

    async streamFile({ request, port }) {
      byteStreamPortSchema.parse(port);
      const validated = fileExplorerReadFileRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      const abortController = new AbortController();
      const jobs = fileIoJobs.get(validated.sessionId) ?? new Set<AbortController>();
      fileIoJobs.set(validated.sessionId, jobs);
      jobs.add(abortController);
      const source = serveByteStream({
        port,
        openStream: () => createDirectoryArchiveAccess({ session }).openFileStream({ path: validated.path }),
        signal: abortController.signal,
      });
      try {
        await source.completed;
      } finally {
        jobs.delete(abortController);
        if (jobs.size === 0) {
          fileIoJobs.delete(validated.sessionId);
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

    async createDirectoryArchive({ request, port }) {
      byteStreamPortSchema.parse(port);
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
        const archive = await createFileExplorerDirectoryArchive({
          access: createDirectoryArchiveAccess({ session }),
          sourceRootPath: normalizedPath,
          archiveRootName,
          excludedRelativePaths: normalizeArchiveExcludedRelativePaths({
            paths: validated.excludedRelativePaths,
          }),
          signal: abortController.signal,
        });
        const source = serveByteStream({ port, openStream: async () => archive.stream, signal: abortController.signal });
        await source.completed;
        const result = await archive.completed;
        return fileExplorerCreateDirectoryArchiveResponseSchema.parse({
          status: 'completed',
          skippedEntryCount: result.skippedEntryCount,
        });
      } catch (error: unknown) {
        if (abortController.signal.aborted) {
          return fileExplorerCreateDirectoryArchiveResponseSchema.parse({ status: 'cancelled' });
        }
        throw error;
      } finally {
        abortController.abort(new DOMException('Directory archive finished', 'AbortError'));
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
      const source = await resolveTransferSource({ session, path: normalizedSourcePath });
      if (!('handle' in source) || await isReadOnlyFileViewPath({ session, path: normalizedSourcePath })) {
        throw new DOMException('Read-only file system', 'NotAllowedError');
      }
      const isDirectory = source.handle.kind === 'directory';
      const signal = new AbortController().signal;
      await withFileViewLocks({
        names: [sourceName, validated.newName],
        mode: isDirectory ? 'exclusive' : 'shared',
        signal,
        async run() {
          const parent = getWritableNativeDirectory({ directory: await resolveDirectory({ session, path: getParentPath({ path: normalizedSourcePath }) }) });
          const removal = { parent, name: sourceName, handle: source.handle };
          await assertMoveSource({ source: removal });
          const destination = await findTransferEntry({ directory: parent, name: validated.newName, kind: source.handle.kind });
          if (destination !== undefined) {
            if (await destination.isSameEntry(source.handle)) {
              return;
            }
            throw new DOMException('An entry with that name already exists in the destination', 'InvalidModificationError');
          }
          const stamp = await copyTransferSource({ source, target: parent, name: validated.newName, move: removal, signal });
          await removeTransferredSource({ source: removal, stamp, signal });
        },
      });
    },

    async copyEntries({ request }) {
      const validated = fileExplorerTransferEntriesRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      await transferEntries({
        session,
        sourcePaths: validated.sourcePaths,
        targetDirectoryPath: validated.targetDirectoryPath,
        operation: 'copy',
      });
    },

    async moveEntries({ request }) {
      const validated = fileExplorerTransferEntriesRequestSchema.parse(request);
      const session = getSession({ sessionId: validated.sessionId });
      await transferEntries({
        session,
        sourcePaths: validated.sourcePaths,
        targetDirectoryPath: validated.targetDirectoryPath,
        operation: 'move',
      });
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
      for (const controller of fileIoJobs.get(validated.sessionId) ?? []) {
        controller.abort(new DOMException('File explorer session disposed', 'AbortError'));
      }
      fileIoJobs.delete(validated.sessionId);
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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
