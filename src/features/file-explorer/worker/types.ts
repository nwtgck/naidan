import { z } from 'zod';

import type { NaidanSysfsRemoteReader } from '@/features/wesh/naidan-sysfs/types';
import { weshWorkerMountSchema } from '@/features/wesh/worker/types';

const fileExplorerPathSchema = z.string().min(1);

export const fileExplorerRootDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('opfs-root'),
    rootName: z.string().min(1),
  }),
  z.object({
    kind: z.literal('native-directory'),
    rootName: z.string().min(1),
    handle: z.custom<FileSystemDirectoryHandle>(),
    readOnly: z.boolean(),
  }),
  z.object({
    kind: z.literal('wesh-mounts'),
    rootName: z.string().min(1),
    mounts: z.array(weshWorkerMountSchema),
    naidanSysfsRemoteReader: z.custom<NaidanSysfsRemoteReader>().optional(),
  }),
]);

export const fileExplorerEntryRecordSchema = z.object({
  path: fileExplorerPathSchema,
  name: z.string().min(1),
  kind: z.union([z.literal('file'), z.literal('directory')]),
  size: z.union([z.number().int().nonnegative(), z.undefined()]),
  lastModified: z.union([z.number().int().nonnegative(), z.undefined()]),
  extension: z.string(),
  mimeCategory: z.union([
    z.literal('text'),
    z.literal('image'),
    z.literal('video'),
    z.literal('audio'),
    z.literal('binary'),
  ]),
  readOnly: z.boolean(),
  canNavigate: z.boolean(),
  canMutate: z.boolean(),
});

export const fileExplorerPathSegmentSchema = z.object({
  name: z.string().min(1),
  path: fileExplorerPathSchema,
});

export const fileExplorerPrepareSessionRequestSchema = z.object({
  root: fileExplorerRootDescriptorSchema,
});

export const fileExplorerPrepareSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
});

export const fileExplorerReadDirectoryRequestSchema = z.object({
  sessionId: z.string().min(1),
  path: fileExplorerPathSchema,
});

export const fileExplorerReadDirectoryResponseSchema = z.object({
  directoryName: z.string().min(1),
  directoryPath: fileExplorerPathSchema,
  readOnly: z.boolean(),
  pathSegments: z.array(fileExplorerPathSegmentSchema),
  entries: z.array(fileExplorerEntryRecordSchema),
});

export const fileExplorerReadPreviewRequestSchema = z.object({
  sessionId: z.string().min(1),
  path: fileExplorerPathSchema,
  mode: z.union([z.literal('bounded'), z.literal('force')]),
});

export const fileExplorerPreviewDirectorySchema = z.object({
  kind: z.literal('directory'),
});

export const fileExplorerPreviewTextSchema = z.object({
  kind: z.literal('text'),
  rawText: z.string(),
  displayText: z.string(),
  languageHint: z.union([z.string().min(1), z.undefined()]),
  oversized: z.boolean(),
});

export const fileExplorerPreviewMediaSchema = z.object({
  kind: z.literal('media'),
  mediaKind: z.union([z.literal('image'), z.literal('video'), z.literal('audio')]),
  blob: z.custom<Blob>(),
  mimeType: z.string(),
  oversized: z.boolean(),
});

export const fileExplorerPreviewBinarySchema = z.object({
  kind: z.literal('binary'),
  oversized: z.boolean(),
});

export const fileExplorerReadPreviewResponseSchema = z.discriminatedUnion('kind', [
  fileExplorerPreviewDirectorySchema,
  fileExplorerPreviewTextSchema,
  fileExplorerPreviewMediaSchema,
  fileExplorerPreviewBinarySchema,
]);

export const fileExplorerReadFileRequestSchema = z.object({
  sessionId: z.string().min(1),
  path: fileExplorerPathSchema,
});

export const fileExplorerReadFileResponseSchema = z.object({
  blob: z.custom<Blob>(),
});


export const fileExplorerSuggestArchiveExclusionsRequestSchema = z.object({
  sessionId: z.string().min(1),
  directoryPath: fileExplorerPathSchema,
  query: z.string(),
  excludedRelativePaths: z.array(z.string().min(1)),
});

export const fileExplorerArchiveExclusionSuggestionSchema = z.object({
  relativePath: z.string().min(1),
  name: z.string().min(1),
  kind: z.union([z.literal('file'), z.literal('directory')]),
});

export const fileExplorerSuggestArchiveExclusionsResponseSchema = z.object({
  suggestions: z.array(fileExplorerArchiveExclusionSuggestionSchema),
  resultState: z.union([z.literal('complete'), z.literal('truncated')]),
});

export const fileExplorerCreateDirectoryArchiveRequestSchema = z.object({
  sessionId: z.string().min(1),
  jobId: z.string().min(1),
  directoryPath: fileExplorerPathSchema,
  excludedRelativePaths: z.array(z.string().min(1)),
});

export const fileExplorerCreateDirectoryArchiveResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('completed'),
    blob: z.custom<Blob>(),
    skippedEntryCount: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal('cancelled'),
  }),
]);

export const fileExplorerCancelDirectoryArchiveRequestSchema = z.object({
  sessionId: z.string().min(1),
  jobId: z.string().min(1),
});

export const fileExplorerCreateFileRequestSchema = z.object({
  sessionId: z.string().min(1),
  parentPath: fileExplorerPathSchema,
  name: z.string().min(1),
});

export const fileExplorerCreateFolderRequestSchema = z.object({
  sessionId: z.string().min(1),
  parentPath: fileExplorerPathSchema,
  name: z.string().min(1),
});

export const fileExplorerDeleteEntriesRequestSchema = z.object({
  sessionId: z.string().min(1),
  paths: z.array(fileExplorerPathSchema),
});

export const fileExplorerRenameEntryRequestSchema = z.object({
  sessionId: z.string().min(1),
  path: fileExplorerPathSchema,
  newName: z.string().min(1),
});

export const fileExplorerTransferEntriesRequestSchema = z.object({
  sessionId: z.string().min(1),
  sourcePaths: z.array(fileExplorerPathSchema),
  targetDirectoryPath: fileExplorerPathSchema,
});

export const fileExplorerUploadItemSchema = z.object({
  name: z.string().min(1),
  blob: z.custom<Blob>(),
});

export const fileExplorerUploadFilesRequestSchema = z.object({
  sessionId: z.string().min(1),
  targetDirectoryPath: fileExplorerPathSchema,
  files: z.array(fileExplorerUploadItemSchema),
});

export const fileExplorerDisposeSessionRequestSchema = z.object({
  sessionId: z.string().min(1),
});

export type FileExplorerRootDescriptor = z.infer<typeof fileExplorerRootDescriptorSchema>;
export type FileExplorerEntryRecord = z.infer<typeof fileExplorerEntryRecordSchema>;
export type FileExplorerPathSegment = z.infer<typeof fileExplorerPathSegmentSchema>;
export type FileExplorerPrepareSessionRequest = z.infer<typeof fileExplorerPrepareSessionRequestSchema>;
export type FileExplorerPrepareSessionResponse = z.infer<typeof fileExplorerPrepareSessionResponseSchema>;
export type FileExplorerReadDirectoryRequest = z.infer<typeof fileExplorerReadDirectoryRequestSchema>;
export type FileExplorerReadDirectoryResponse = z.infer<typeof fileExplorerReadDirectoryResponseSchema>;
export type FileExplorerReadPreviewRequest = z.infer<typeof fileExplorerReadPreviewRequestSchema>;
export type FileExplorerReadPreviewResponse = z.infer<typeof fileExplorerReadPreviewResponseSchema>;
export type FileExplorerReadFileRequest = z.infer<typeof fileExplorerReadFileRequestSchema>;
export type FileExplorerReadFileResponse = z.infer<typeof fileExplorerReadFileResponseSchema>;

export type FileExplorerSuggestArchiveExclusionsRequest = z.infer<typeof fileExplorerSuggestArchiveExclusionsRequestSchema>;
export type FileExplorerSuggestArchiveExclusionsResponse = z.infer<typeof fileExplorerSuggestArchiveExclusionsResponseSchema>;
export type FileExplorerCreateDirectoryArchiveRequest = z.infer<typeof fileExplorerCreateDirectoryArchiveRequestSchema>;
export type FileExplorerCreateDirectoryArchiveResponse = z.infer<typeof fileExplorerCreateDirectoryArchiveResponseSchema>;
export type FileExplorerCancelDirectoryArchiveRequest = z.infer<typeof fileExplorerCancelDirectoryArchiveRequestSchema>;
export type FileExplorerCreateFileRequest = z.infer<typeof fileExplorerCreateFileRequestSchema>;
export type FileExplorerCreateFolderRequest = z.infer<typeof fileExplorerCreateFolderRequestSchema>;
export type FileExplorerDeleteEntriesRequest = z.infer<typeof fileExplorerDeleteEntriesRequestSchema>;
export type FileExplorerRenameEntryRequest = z.infer<typeof fileExplorerRenameEntryRequestSchema>;
export type FileExplorerTransferEntriesRequest = z.infer<typeof fileExplorerTransferEntriesRequestSchema>;
export type FileExplorerUploadFilesRequest = z.infer<typeof fileExplorerUploadFilesRequestSchema>;
export type FileExplorerDisposeSessionRequest = z.infer<typeof fileExplorerDisposeSessionRequestSchema>;

export interface IFileExplorerWorker {
  prepareSession({ request }: { request: FileExplorerPrepareSessionRequest }): Promise<FileExplorerPrepareSessionResponse>,
  readDirectory({ request }: { request: FileExplorerReadDirectoryRequest }): Promise<FileExplorerReadDirectoryResponse>,
  readPreview({ request }: { request: FileExplorerReadPreviewRequest }): Promise<FileExplorerReadPreviewResponse>,
  readFile({ request }: { request: FileExplorerReadFileRequest }): Promise<FileExplorerReadFileResponse>,
  suggestArchiveExclusions({ request }: { request: FileExplorerSuggestArchiveExclusionsRequest }): Promise<FileExplorerSuggestArchiveExclusionsResponse>,
  createDirectoryArchive({ request }: { request: FileExplorerCreateDirectoryArchiveRequest }): Promise<FileExplorerCreateDirectoryArchiveResponse>,
  cancelDirectoryArchive({ request }: { request: FileExplorerCancelDirectoryArchiveRequest }): Promise<void>,
  createFile({ request }: { request: FileExplorerCreateFileRequest }): Promise<void>,
  createFolder({ request }: { request: FileExplorerCreateFolderRequest }): Promise<void>,
  deleteEntries({ request }: { request: FileExplorerDeleteEntriesRequest }): Promise<void>,
  renameEntry({ request }: { request: FileExplorerRenameEntryRequest }): Promise<void>,
  copyEntries({ request }: { request: FileExplorerTransferEntriesRequest }): Promise<void>,
  moveEntries({ request }: { request: FileExplorerTransferEntriesRequest }): Promise<void>,
  uploadFiles({ request }: { request: FileExplorerUploadFilesRequest }): Promise<void>,
  disposeSession({ request }: { request: FileExplorerDisposeSessionRequest }): Promise<void>,
}


export interface FileExplorerDirectoryArchiveJob {
  result: Promise<FileExplorerCreateDirectoryArchiveResponse>,
  cancel(): Promise<void>,
}

export interface FileExplorerWorkerClient {
  readDirectory({ path }: { path: string }): Promise<FileExplorerReadDirectoryResponse>,
  readPreview({ path, mode }: { path: string, mode: 'bounded' | 'force' }): Promise<FileExplorerReadPreviewResponse>,
  readFile({ path }: { path: string }): Promise<FileExplorerReadFileResponse>,
  suggestArchiveExclusions({ directoryPath, query, excludedRelativePaths }: { directoryPath: string, query: string, excludedRelativePaths: string[] }): Promise<FileExplorerSuggestArchiveExclusionsResponse>,
  startDirectoryArchive({ directoryPath, excludedRelativePaths }: { directoryPath: string, excludedRelativePaths: string[] }): FileExplorerDirectoryArchiveJob,
  createFile({ parentPath, name }: { parentPath: string, name: string }): Promise<void>,
  createFolder({ parentPath, name }: { parentPath: string, name: string }): Promise<void>,
  deleteEntries({ paths }: { paths: string[] }): Promise<void>,
  renameEntry({ path, newName }: { path: string, newName: string }): Promise<void>,
  copyEntries({ sourcePaths, targetDirectoryPath }: { sourcePaths: string[], targetDirectoryPath: string }): Promise<void>,
  moveEntries({ sourcePaths, targetDirectoryPath }: { sourcePaths: string[], targetDirectoryPath: string }): Promise<void>,
  uploadFiles({ targetDirectoryPath, files }: { targetDirectoryPath: string, files: Array<{ name: string, blob: Blob }> }): Promise<void>,
  dispose(): Promise<void>,
}
