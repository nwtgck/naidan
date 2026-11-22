import { FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION } from '@/utils/worker-transport-capabilities';
import { z } from 'zod';

import type { WorkerCapability, WorkerProxy, WorkerTransfer } from '@/utils/worker-transport';
import type { NaidanSysfsRemoteReader } from '@/features/wesh/naidan-sysfs/types';
import { fileSystemDirectoryHandleReferenceSchema } from '@/utils/file-system-handle-transport';
import { weshWorkerMountSchema } from '@/features/wesh/worker/types';
import type { ManagedVolumeRemoteAccess } from '@/features/wesh/worker/managed-volume-access';
import { remoteDirectoryEntrySchema, type RemoteDirectoryAccess } from '@/utils/remote-directory-handle';
import type { ModelFileDetailsInspection, ModelMetadataEntry, ModelMetadataValue } from '@/logic/model-file-inspection/metadata';

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

const fileExplorerPathSchema = z.string().min(1);
const fileExplorerRemoteMountSchema = z.object({
  path: fileExplorerPathSchema,
  root: remoteDirectoryEntrySchema,
  readOnly: z.boolean(),
  deletionOnly: z.boolean().optional(),
});
export type FileExplorerRemoteMount = z.infer<typeof fileExplorerRemoteMountSchema> & { access: RemoteDirectoryAccess };
const fileExplorerArchiveSourceDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('blob'),
    blob: z.custom<Blob>(isBlob),
  }),
]);
const fileExplorerArchiveDescriptorSchema = z.object({
  format: z.literal('zip'),
  source: fileExplorerArchiveSourceDescriptorSchema,
});
const fileExplorerZipPreviewRelativePathSchema = z.string().refine(value => {
  if (value === '') {
    return true;
  }
  if (value.startsWith('/') || value.includes('\\')) {
    return false;
  }
  const segments = value.split('/');
  return segments.length <= 256
    && segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}, 'Invalid ZIP preview relative path');

export const fileExplorerRootDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('opfs-root'),
    rootName: z.string().min(1),
  }),
  z.object({
    kind: z.literal('native-directory'),
    rootName: z.string().min(1),
    handle: fileSystemDirectoryHandleReferenceSchema,
    readOnly: z.boolean(),
  }),
  z.object({
    kind: z.literal('wesh-mounts'),
    rootName: z.string().min(1),
    mounts: z.array(weshWorkerMountSchema),
    remoteMounts: z.array(fileExplorerRemoteMountSchema).optional(),
  }),
  z.object({
    kind: z.literal('archive-root'),
    rootName: z.string().min(1),
    archive: fileExplorerArchiveDescriptorSchema,
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
  kind: z.union([
    z.literal('root'),
    z.literal('directory'),
    z.literal('archive'),
  ]),
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
  format: z.object({
    kind: z.enum(['text', 'image', 'audio', 'video']),
    mimeType: z.string().max(128).optional(),
  }).optional(),
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


// Keep the native object's prototype; do not parse it as a plain object. Like
// the existing handle references this also accepts conforming host/test objects.
const downloadBlobReferenceSchema = z.custom<Blob>(value => value !== null && typeof value === 'object'
  && 'size' in value && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0
  && 'stream' in value && typeof value.stream === 'function'
  && 'slice' in value && typeof value.slice === 'function');

const fileViewSizeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fileViewRevisionSchema = z.string().min(1);
const fileViewReadRequestBaseSchema = z.object({
  sessionId: z.string().min(1),
  path: fileExplorerPathSchema,
});
export const FILE_VIEW_PROBE_BYTES = 4100;
export const FILE_VIEW_MAX_DISPLAY_BYTES = 16 * 1024;
const fileViewFormatSchema = z.object({
  kind: z.enum(['text', 'binary', 'image', 'audio', 'video', 'archive', 'model']),
  extension: z.string().max(64).optional(),
  mimeType: z.string().max(128).optional(),
});
export type FileViewFormat = z.infer<typeof fileViewFormatSchema>;
export const fileExplorerReadFileForViewRequestSchema = z.discriminatedUnion('mode', [
  fileViewReadRequestBaseSchema.extend({
    mode: z.enum(['prefix', 'bounded']),
    maxBytes: fileViewSizeSchema.max(64 * 1024 * 1024),
  }),
  fileViewReadRequestBaseSchema.extend({ mode: z.literal('inspect') }),
  fileViewReadRequestBaseSchema.extend({
    mode: z.literal('range'),
    offset: fileViewSizeSchema,
    maxBytes: fileViewSizeSchema.min(1).max(FILE_VIEW_MAX_DISPLAY_BYTES),
  }),
  fileViewReadRequestBaseSchema.extend({ mode: z.literal('snapshot') }),
]);
export const fileExplorerFileForViewSchema = z.object({
  kind: z.literal('file'),
  name: z.string(),
  blob: downloadBlobReferenceSchema,
  size: fileViewSizeSchema.optional(),
  lastModified: z.number().optional(),
  partial: z.boolean(),
  revision: fileViewRevisionSchema.optional(),
  format: fileViewFormatSchema.optional(),
  rangeReadable: z.boolean().optional(),
});
export const fileExplorerReadFileForViewResponseSchema = z.discriminatedUnion('kind', [
  fileExplorerFileForViewSchema,
  z.object({ kind: z.literal('too-large'), name: z.string(), size: fileViewSizeSchema.optional() }),
  z.object({ kind: z.literal('unsupported'), name: z.string() }),
]);

const fileExplorerSaveFileTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('replace'), path: fileExplorerPathSchema, revision: fileViewRevisionSchema }),
  z.object({
    kind: z.literal('create'),
    directoryPath: fileExplorerPathSchema,
    name: z.string().min(1).refine(name => name !== '.' && name !== '..' && !/[\\/\0]/u.test(name)),
  }),
]);
export const fileExplorerSaveFileForViewRequestSchema = z.object({
  sessionId: z.string().min(1),
  target: fileExplorerSaveFileTargetSchema,
  blob: downloadBlobReferenceSchema,
});
export const fileExplorerSaveFileForViewResponseSchema = z.object({
  path: fileExplorerPathSchema,
  revision: fileViewRevisionSchema.optional(),
});
export const fileExplorerFileViewCancelSchema = z.object({ type: z.literal('cancel') });
export const fileExplorerFileViewProgressSchema = z.object({
  writtenBytes: fileViewSizeSchema,
  totalBytes: fileViewSizeSchema,
}).refine(({ writtenBytes, totalBytes }) => writtenBytes <= totalBytes);

const modelMetadataValueSchema = z.union([
  z.string(),
  z.custom<number>(value => typeof value === 'number'),
  z.boolean(),
]);
const modelMetadataEntrySchema = z.object({
  key: z.string(),
  type: z.string(),
  value: z.union([modelMetadataValueSchema, z.undefined()]),
  count: z.union([fileViewSizeSchema, z.undefined()]),
  elementType: z.union([z.string(), z.undefined()]),
  range: z.union([z.object({ offset: fileViewSizeSchema, length: fileViewSizeSchema }), z.undefined()]),
  stringOffsets: z.array(fileViewSizeSchema).optional(),
}).transform(({ stringOffsets, ...entry }): ModelMetadataEntry => (
  stringOffsets === undefined ? entry : { ...entry, stringOffsets }
));
const modelTensorDescriptorSchema = z.object({
  name: z.string(),
  shape: z.array(fileViewSizeSchema),
  originalShape: z.union([z.array(fileViewSizeSchema), z.undefined()]),
  dtype: z.string(),
  dtypeCode: z.union([fileViewSizeSchema, z.undefined()]),
  offset: fileViewSizeSchema,
  byteLength: z.union([fileViewSizeSchema, z.undefined()]),
});
const modelWeightDetailsSchema = z.object({
  format: z.enum(['gguf', 'safetensors']),
  version: z.union([fileViewSizeSchema, z.undefined()]),
  alignment: z.union([fileViewSizeSchema, z.undefined()]),
  dataOffset: fileViewSizeSchema,
  metadata: z.array(modelMetadataEntrySchema),
  tensors: z.array(modelTensorDescriptorSchema),
  split: z.union([
    z.object({ index: fileViewSizeSchema, count: fileViewSizeSchema, tensors: fileViewSizeSchema }),
    z.undefined(),
  ]),
});
export const fileExplorerInspectModelRequestSchema = z.object({
  sessionId: z.string().min(1),
  file: downloadBlobReferenceSchema,
});
export const fileExplorerInspectModelResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('weights'), value: modelWeightDetailsSchema }),
  z.object({ status: z.enum(['unknown', 'invalid', 'lfs-pointer']), reason: z.string() }),
]);
export const MODEL_OVERVIEW_LABEL_LIMIT = 4096;
const modelOverviewLabelSchema = modelMetadataValueSchema
  .refine(value => typeof value !== 'string' || value.length <= MODEL_OVERVIEW_LABEL_LIMIT)
  .optional();
const modelWeightOverviewSchema = modelWeightDetailsSchema.pick({ format: true, version: true, split: true }).extend({
  name: modelOverviewLabelSchema,
  architecture: modelOverviewLabelSchema,
  metadataCount: fileViewSizeSchema,
  tensorCount: fileViewSizeSchema,
});
export const fileExplorerInspectModelOverviewResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('weights'), value: modelWeightOverviewSchema }),
  z.object({ status: z.enum(['unknown', 'invalid', 'lfs-pointer']), reason: z.string().max(MODEL_OVERVIEW_LABEL_LIMIT) }),
]);
export type ModelWeightOverview = z.infer<typeof modelWeightOverviewSchema>;
export type ModelFileOverviewInspection = z.infer<typeof fileExplorerInspectModelOverviewResponseSchema>;
export const fileExplorerReadModelValueRequestSchema = fileExplorerInspectModelRequestSchema.extend({
  entry: modelMetadataEntrySchema,
  start: fileViewSizeSchema,
  limit: fileViewSizeSchema.min(1).max(128),
});
export const fileExplorerReadModelValueResponseSchema = z.object({
  values: z.array(modelMetadataValueSchema).max(128),
  next: z.union([fileViewSizeSchema, z.undefined()]),
});
export const fileExplorerRewriteGgufRequestSchema = fileExplorerInspectModelRequestSchema.extend({
  changes: z.record(z.string(), z.string().max(1024 * 1024)),
});
export const fileExplorerRewriteGgufResponseSchema = z.object({
  header: z.custom<Uint8Array<ArrayBuffer>>(value => ArrayBuffer.isView(value)
    && Object.prototype.toString.call(value) === '[object Uint8Array]'
    && Object.prototype.toString.call(value.buffer) === '[object ArrayBuffer]'
    && value.byteLength <= 16 * 1024 * 1024),
  bodyOffset: fileViewSizeSchema,
});

export type FileExplorerReadFileForViewRequest = z.infer<typeof fileExplorerReadFileForViewRequestSchema>;
export type FileExplorerFileForView = z.infer<typeof fileExplorerFileForViewSchema>;
export type FileExplorerReadFileForViewResponse = z.infer<typeof fileExplorerReadFileForViewResponseSchema>;
export type FileExplorerSaveFileTarget = z.infer<typeof fileExplorerSaveFileTargetSchema>;
export type FileExplorerSaveFileForViewRequest = z.infer<typeof fileExplorerSaveFileForViewRequestSchema>;
export type FileExplorerSaveFileForViewResponse = z.infer<typeof fileExplorerSaveFileForViewResponseSchema>;
export type FileExplorerFileViewProgress = z.infer<typeof fileExplorerFileViewProgressSchema>;
type FileExplorerInspectModelRequest = z.infer<typeof fileExplorerInspectModelRequestSchema>;
type FileExplorerReadModelValueRequest = z.infer<typeof fileExplorerReadModelValueRequestSchema>;
type FileExplorerRewriteGgufRequest = z.infer<typeof fileExplorerRewriteGgufRequestSchema>;

export const fileExplorerPrepareFileDownloadResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), blob: downloadBlobReferenceSchema }),
  // A virtual file has no stable Blob snapshot. Do not use its stat/listing size.
  z.object({ kind: z.literal('stream') }),
]);
export type FileExplorerPrepareFileDownloadResponse = z.infer<typeof fileExplorerPrepareFileDownloadResponseSchema>;


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


export const fileExplorerZipUploadPlacementSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('keep_archive'),
  }),
  z.object({
    kind: z.literal('extract'),
    rootHandling: z.union([
      z.literal('preserve'),
      z.literal('strip'),
      z.literal('not_applicable'),
    ]),
  }),
]);

export const fileExplorerAnalyzeZipUploadRequestSchema = z.object({
  sessionId: z.string().min(1),
  analysisId: z.string().min(1),
  targetDirectoryPath: fileExplorerPathSchema,
  fileName: z.string().min(1),
  blob: z.custom<Blob>(),
});

export const fileExplorerAnalyzeZipUploadResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('extractable'),
    analysisId: z.string().min(1),
    entryCount: z.number().int().nonnegative(),
    totalUncompressedSize: z.number().int().nonnegative(),
    singleRootDirectoryName: z.union([z.string().min(1), z.undefined()]),
  }),
  z.object({
    status: z.literal('not_extractable'),
    analysisId: z.string().min(1),
    reason: z.literal('invalid_or_unsupported_archive'),
  }),
]);

export const fileExplorerZipUploadPreviewActionSchema = z.union([
  z.literal('existing'),
  z.literal('add'),
  z.literal('merge'),
  z.literal('replace'),
  z.literal('blocked'),
]);

export const fileExplorerZipUploadPreviewEntrySchema = z.object({
  path: z.string(),
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
  action: fileExplorerZipUploadPreviewActionSchema,
  canNavigate: z.boolean(),
});

export const fileExplorerZipUploadPreviewSummarySchema = z.object({
  addedCount: z.number().int().nonnegative(),
  mergedCount: z.number().int().nonnegative(),
  replacedCount: z.number().int().nonnegative(),
  blockedCount: z.number().int().nonnegative(),
});

export const fileExplorerReadZipUploadPreviewDirectoryRequestSchema = z.object({
  sessionId: z.string().min(1),
  analysisId: z.string().min(1),
  placement: fileExplorerZipUploadPlacementSchema,
  relativePath: fileExplorerZipPreviewRelativePathSchema,
});

export const fileExplorerReadZipUploadPreviewDirectoryResponseSchema = z.object({
  relativePath: z.string(),
  pathSegments: z.array(z.object({
    name: z.string().min(1),
    relativePath: z.string(),
  })),
  entries: z.array(fileExplorerZipUploadPreviewEntrySchema),
  summary: fileExplorerZipUploadPreviewSummarySchema,
});

export const fileExplorerExecuteZipUploadRequestSchema = z.object({
  sessionId: z.string().min(1),
  analysisId: z.string().min(1),
  jobId: z.string().min(1),
  placement: fileExplorerZipUploadPlacementSchema,
});

export const fileExplorerExecuteZipUploadResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed') }),
  z.object({ status: z.literal('cancelled') }),
  z.object({ status: z.literal('preview_outdated') }),
]);

export const fileExplorerCancelZipUploadRequestSchema = z.object({
  sessionId: z.string().min(1),
  jobId: z.string().min(1),
});

export const fileExplorerDisposeZipUploadAnalysisRequestSchema = z.object({
  sessionId: z.string().min(1),
  analysisId: z.string().min(1),
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
export type FileExplorerZipUploadPlacement = z.infer<typeof fileExplorerZipUploadPlacementSchema>;

export function toPlainFileExplorerZipUploadPlacement({
  placement,
}: {
  placement: FileExplorerZipUploadPlacement,
}): FileExplorerZipUploadPlacement {
  return fileExplorerZipUploadPlacementSchema.parse(placement);
}

export type FileExplorerAnalyzeZipUploadRequest = z.infer<typeof fileExplorerAnalyzeZipUploadRequestSchema>;
export type FileExplorerAnalyzeZipUploadResponse = z.infer<typeof fileExplorerAnalyzeZipUploadResponseSchema>;
export type FileExplorerZipUploadPreviewAction = z.infer<typeof fileExplorerZipUploadPreviewActionSchema>;
export type FileExplorerZipUploadPreviewEntry = z.infer<typeof fileExplorerZipUploadPreviewEntrySchema>;
export type FileExplorerZipUploadPreviewSummary = z.infer<typeof fileExplorerZipUploadPreviewSummarySchema>;
export type FileExplorerReadZipUploadPreviewDirectoryRequest = z.infer<typeof fileExplorerReadZipUploadPreviewDirectoryRequestSchema>;
export type FileExplorerReadZipUploadPreviewDirectoryResponse = z.infer<typeof fileExplorerReadZipUploadPreviewDirectoryResponseSchema>;
export type FileExplorerExecuteZipUploadRequest = z.infer<typeof fileExplorerExecuteZipUploadRequestSchema>;
export type FileExplorerExecuteZipUploadResponse = z.infer<typeof fileExplorerExecuteZipUploadResponseSchema>;
export type FileExplorerCancelZipUploadRequest = z.infer<typeof fileExplorerCancelZipUploadRequestSchema>;
export type FileExplorerDisposeZipUploadAnalysisRequest = z.infer<typeof fileExplorerDisposeZipUploadAnalysisRequestSchema>;
export type FileExplorerUploadFilesRequest = z.infer<typeof fileExplorerUploadFilesRequestSchema>;
export type FileExplorerDisposeSessionRequest = z.infer<typeof fileExplorerDisposeSessionRequestSchema>;

export interface IFileExplorerWorker {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy values must remain top-level arguments.
  prepareSession(
    options: WorkerCapability<
      { request: FileExplorerPrepareSessionRequest },
      typeof FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION
    >,
    naidanSysfsRemoteReader?: WorkerProxy<NaidanSysfsRemoteReader>,
    managedVolumeRemoteAccess?: WorkerProxy<ManagedVolumeRemoteAccess>,
  ): Promise<FileExplorerPrepareSessionResponse>,
  readDirectory({ request }: { request: FileExplorerReadDirectoryRequest }): Promise<FileExplorerReadDirectoryResponse>,
  readPreview({ request }: { request: FileExplorerReadPreviewRequest }): Promise<FileExplorerReadPreviewResponse>,
  readFile({ request }: { request: FileExplorerReadFileRequest }): Promise<FileExplorerReadFileResponse>,
  readFileForView({ request, port }: WorkerTransfer<{ request: FileExplorerReadFileForViewRequest, port: MessagePort }>): Promise<FileExplorerReadFileForViewResponse>,
  saveFileForView({ request, port }: WorkerTransfer<{ request: FileExplorerSaveFileForViewRequest, port: MessagePort }>): Promise<FileExplorerSaveFileForViewResponse>,
  inspectModelOverviewForView({ request, port }: WorkerTransfer<{ request: FileExplorerInspectModelRequest, port: MessagePort }>): Promise<ModelFileOverviewInspection>,
  inspectModelForView({ request, port }: WorkerTransfer<{ request: FileExplorerInspectModelRequest, port: MessagePort }>): Promise<ModelFileDetailsInspection>,
  readModelValueForView({ request, port }: WorkerTransfer<{ request: FileExplorerReadModelValueRequest, port: MessagePort }>): Promise<{ values: ModelMetadataValue[], next: number | undefined }>,
  rewriteGgufForView({ request, port }: WorkerTransfer<{ request: FileExplorerRewriteGgufRequest, port: MessagePort }>): Promise<{ header: Uint8Array<ArrayBuffer>, bodyOffset: number }>,
  prepareFileDownload({ request }: { request: FileExplorerReadFileRequest }): Promise<FileExplorerPrepareFileDownloadResponse>,
  streamFile({ request, port }: WorkerTransfer<{ request: FileExplorerReadFileRequest, port: MessagePort }>): Promise<void>,
  suggestArchiveExclusions({ request }: { request: FileExplorerSuggestArchiveExclusionsRequest }): Promise<FileExplorerSuggestArchiveExclusionsResponse>,
  createDirectoryArchive({ request, port }: WorkerTransfer<{ request: FileExplorerCreateDirectoryArchiveRequest, port: MessagePort }>): Promise<FileExplorerCreateDirectoryArchiveResponse>,
  cancelDirectoryArchive({ request }: { request: FileExplorerCancelDirectoryArchiveRequest }): Promise<void>,
  createFile({ request }: { request: FileExplorerCreateFileRequest }): Promise<void>,
  createFolder({ request }: { request: FileExplorerCreateFolderRequest }): Promise<void>,
  deleteEntries({ request }: { request: FileExplorerDeleteEntriesRequest }): Promise<void>,
  renameEntry({ request }: { request: FileExplorerRenameEntryRequest }): Promise<void>,
  copyEntries({ request }: { request: FileExplorerTransferEntriesRequest }): Promise<void>,
  moveEntries({ request }: { request: FileExplorerTransferEntriesRequest }): Promise<void>,
  analyzeZipUpload({ request }: { request: FileExplorerAnalyzeZipUploadRequest }): Promise<FileExplorerAnalyzeZipUploadResponse>,
  readZipUploadPreviewDirectory({ request }: { request: FileExplorerReadZipUploadPreviewDirectoryRequest }): Promise<FileExplorerReadZipUploadPreviewDirectoryResponse>,
  executeZipUpload({ request }: { request: FileExplorerExecuteZipUploadRequest }): Promise<FileExplorerExecuteZipUploadResponse>,
  cancelZipUpload({ request }: { request: FileExplorerCancelZipUploadRequest }): Promise<void>,
  disposeZipUploadAnalysis({ request }: { request: FileExplorerDisposeZipUploadAnalysisRequest }): Promise<void>,
  uploadFiles({ request }: { request: FileExplorerUploadFilesRequest }): Promise<void>,
  disposeSession({ request }: { request: FileExplorerDisposeSessionRequest }): Promise<void>,
}


export interface FileExplorerDirectoryArchiveJob {
  stream: ReadableStream<Uint8Array>,
  result: Promise<FileExplorerCreateDirectoryArchiveResponse>,
  cancel(): Promise<void>,
}


export interface FileExplorerZipUploadJob {
  result: Promise<FileExplorerExecuteZipUploadResponse>,
  cancel(): Promise<void>,
}

export interface FileExplorerModelAccess {
  inspectModelOverview({ file, signal }: { file: Blob, signal?: AbortSignal }): Promise<ModelFileOverviewInspection>,
  inspectModel({ file, signal }: { file: Blob, signal?: AbortSignal }): Promise<ModelFileDetailsInspection>,
  readModelMetadataValue({ file, entry, start, limit, signal }: { file: Blob, entry: ModelMetadataEntry, start: number, limit: number, signal?: AbortSignal }): Promise<{ values: ModelMetadataValue[], next: number | undefined }>,
  prepareGgufMetadataRewrite({ file, changes, signal }: { file: Blob, changes: Readonly<Record<string, string>>, signal?: AbortSignal }): Promise<{ header: Uint8Array<ArrayBuffer>, bodyOffset: number }>,
}

export interface FileExplorerFileAccess extends FileExplorerModelAccess {
  read({ path, mode, signal }: { path: string, signal?: AbortSignal } & (
    { mode: 'prefix' | 'bounded', maxBytes: number }
    | { mode: 'inspect' }
    | { mode: 'range', offset: number, maxBytes: number }
  )): Promise<FileExplorerReadFileForViewResponse>,
  openSnapshot({ path, signal }: { path: string, signal?: AbortSignal }): Promise<FileExplorerReadFileForViewResponse>,
  save({ target, blob, signal, onProgress }: { target: FileExplorerSaveFileTarget, blob: Blob, signal?: AbortSignal, onProgress?: ({ writtenBytes, totalBytes }: { writtenBytes: number, totalBytes: number }) => void }): Promise<FileExplorerSaveFileForViewResponse>,
}

export interface FileExplorerWorkerClient {
  readDirectory({ path }: { path: string }): Promise<FileExplorerReadDirectoryResponse>,
  readPreview({ path, mode, format }: { path: string, mode: 'bounded' | 'force', format?: FileExplorerReadPreviewRequest['format'] }): Promise<FileExplorerReadPreviewResponse>,
  readFile({ path }: { path: string }): Promise<FileExplorerReadFileResponse>,
  fileAccess?: FileExplorerFileAccess,
  prepareFileDownload({ path }: { path: string }): Promise<FileExplorerPrepareFileDownloadResponse>,
  openFileStream({ path }: { path: string }): Promise<ReadableStream<Uint8Array>>,
  suggestArchiveExclusions({ directoryPath, query, excludedRelativePaths }: { directoryPath: string, query: string, excludedRelativePaths: string[] }): Promise<FileExplorerSuggestArchiveExclusionsResponse>,
  startDirectoryArchive({ directoryPath, excludedRelativePaths }: { directoryPath: string, excludedRelativePaths: string[] }): FileExplorerDirectoryArchiveJob,
  createFile({ parentPath, name }: { parentPath: string, name: string }): Promise<void>,
  createFolder({ parentPath, name }: { parentPath: string, name: string }): Promise<void>,
  deleteEntries({ paths }: { paths: string[] }): Promise<void>,
  renameEntry({ path, newName }: { path: string, newName: string }): Promise<void>,
  copyEntries({ sourcePaths, targetDirectoryPath }: { sourcePaths: string[], targetDirectoryPath: string }): Promise<void>,
  moveEntries({ sourcePaths, targetDirectoryPath }: { sourcePaths: string[], targetDirectoryPath: string }): Promise<void>,
  analyzeZipUpload({ analysisId, targetDirectoryPath, fileName, blob }: { analysisId: string, targetDirectoryPath: string, fileName: string, blob: Blob }): Promise<FileExplorerAnalyzeZipUploadResponse>,
  readZipUploadPreviewDirectory({ analysisId, placement, relativePath }: { analysisId: string, placement: FileExplorerZipUploadPlacement, relativePath: string }): Promise<FileExplorerReadZipUploadPreviewDirectoryResponse>,
  startZipUpload({ analysisId, placement }: { analysisId: string, placement: FileExplorerZipUploadPlacement }): FileExplorerZipUploadJob,
  disposeZipUploadAnalysis({ analysisId }: { analysisId: string }): Promise<void>,
  uploadFiles({ targetDirectoryPath, files }: { targetDirectoryPath: string, files: Array<{ name: string, blob: Blob }> }): Promise<void>,
  dispose(): Promise<void>,
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
