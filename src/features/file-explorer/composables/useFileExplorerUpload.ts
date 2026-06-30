import { ref } from 'vue';

import { ensureStrings } from '@/strings';
import { useToast } from '@/composables/useToast';
import type {
  FileExplorerEntry,
  FileExplorerUploadController,
  ZipUploadPhase,
  ZipUploadState,
} from '@/features/file-explorer/logic/types';
import { getFileExtension, getMimeCategory } from '@/features/file-explorer/logic/utils';
import type {
  FileExplorerAnalyzeZipUploadResponse,
  FileExplorerWorkerClient,
  FileExplorerZipUploadPlacement,
  FileExplorerZipUploadPreviewAction,
  FileExplorerZipUploadPreviewEntry,
  FileExplorerZipUploadPreviewSummary,
} from '@/features/file-explorer/worker/types';

interface ConfiguredZipUpload {
  readonly file: File,
  readonly analysisId: string | undefined,
  readonly singleRootDirectoryName: string | undefined,
  readonly placement: FileExplorerZipUploadPlacement,
}

function createAnalysisId(): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `file-explorer-zip-analysis-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isZipCandidate({ file }: { file: File }): boolean {
  return getFileExtension({ name: file.name }).toLocaleLowerCase('en-US') === '.zip'
    || file.type === 'application/zip'
    || file.type === 'application/x-zip-compressed';
}

function createEmptySummary(): FileExplorerZipUploadPreviewSummary {
  return {
    addedCount: 0,
    mergedCount: 0,
    replacedCount: 0,
    blockedCount: 0,
  };
}

function canNavigateEntry({ kind }: { kind: FileExplorerEntry['kind'] }): boolean {
  switch (kind) {
  case 'directory':
    return true;
  case 'file':
    return false;
  default: {
    const _exhaustiveCheck: never = kind;
    throw new Error(`Unhandled file explorer entry kind: ${String(_exhaustiveCheck)}`);
  }
  }
}

function getKeepArchiveAction({
  existing,
}: {
  existing: FileExplorerEntry | undefined,
}): FileExplorerZipUploadPreviewAction {
  if (existing === undefined) {
    return 'add';
  }
  switch (existing.kind) {
  case 'file':
    return 'replace';
  case 'directory':
    return 'blocked';
  default: {
    const _exhaustiveCheck: never = existing.kind;
    throw new Error(`Unhandled existing entry kind: ${String(_exhaustiveCheck)}`);
  }
  }
}

function comparePreviewEntryKinds({
  left,
  right,
}: {
  left: FileExplorerZipUploadPreviewEntry,
  right: FileExplorerZipUploadPreviewEntry,
}): number {
  if (left.kind === right.kind) {
    return 0;
  }
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

function createSummaryForAction({
  action,
}: {
  action: FileExplorerZipUploadPreviewAction,
}): FileExplorerZipUploadPreviewSummary {
  const summary = createEmptySummary();
  switch (action) {
  case 'add':
    summary.addedCount = 1;
    break;
  case 'merge':
    summary.mergedCount = 1;
    break;
  case 'replace':
    summary.replacedCount = 1;
    break;
  case 'blocked':
    summary.blockedCount = 1;
    break;
  case 'existing':
    break;
  default: {
    const _exhaustiveCheck: never = action;
    throw new Error(`Unhandled ZIP preview action: ${String(_exhaustiveCheck)}`);
  }
  }
  return summary;
}

function canNavigatePreview({ phase }: { phase: ZipUploadPhase }): boolean {
  switch (phase) {
  case 'configuring':
    return true;
  case 'idle':
  case 'analyzing':
  case 'uploading':
    return false;
  default: {
    const _exhaustiveCheck: never = phase;
    throw new Error(`Unhandled ZIP upload phase: ${String(_exhaustiveCheck)}`);
  }
  }
}

function canUseAnalyzedPreview({
  extractability,
}: {
  extractability: ZipUploadState['extractability'],
}): boolean {
  switch (extractability) {
  case 'extractable':
    return true;
  case 'not_extractable':
  case undefined:
    return false;
  default: {
    const _exhaustiveCheck: never = extractability;
    throw new Error(`Unhandled ZIP extractability: ${String(_exhaustiveCheck)}`);
  }
  }
}

function canConfirmUpload({
  phase,
  blockedCount,
}: {
  phase: ZipUploadPhase,
  blockedCount: number,
}): boolean {
  switch (phase) {
  case 'configuring':
    return blockedCount === 0;
  case 'idle':
  case 'analyzing':
  case 'uploading':
    return false;
  default: {
    const _exhaustiveCheck: never = phase;
    throw new Error(`Unhandled ZIP upload phase: ${String(_exhaustiveCheck)}`);
  }
  }
}

export function useFileExplorerUpload({
  client,
  currentDirectoryPath,
  currentEntries,
  refresh,
}: {
  client: FileExplorerWorkerClient,
  currentDirectoryPath: { readonly value: string },
  currentEntries: { readonly value: FileExplorerEntry[] },
  refresh: () => Promise<void>,
}): FileExplorerUploadController {
  const { addToast } = useToast();
  const state = ref<ZipUploadState>({
    visibility: 'hidden',
    phase: 'idle',
    currentFileName: undefined,
    currentFileSize: undefined,
    targetDirectoryPath: '',
    currentZipIndex: 0,
    totalZipCount: 0,
    extractability: undefined,
    singleRootDirectoryName: undefined,
    placement: { kind: 'keep_archive' },
    previewRelativePath: '',
    previewPathSegments: [],
    previewEntries: [],
    previewSummary: createEmptySummary(),
    errorMessage: undefined,
  });
  const regularFiles = ref<File[]>([]);
  const zipFiles = ref<File[]>([]);
  const configuredZipUploads = ref<ConfiguredZipUpload[]>([]);
  const currentAnalysisId = ref<string | undefined>(undefined);
  const currentJob = ref<ReturnType<FileExplorerWorkerClient['startZipUpload']> | undefined>(undefined);
  const completedAnalysisIds = new Set<string>();
  const uploadTargetDirectoryPath = ref<string | undefined>(undefined);
  const uploadTargetEntries = ref<FileExplorerEntry[]>([]);
  let analysisRequestVersion = 0;
  let previewRequestVersion = 0;

  function buildLocalKeepPreview({ file }: { file: File }): void {
    const entries: FileExplorerZipUploadPreviewEntry[] = uploadTargetEntries.value
      .filter(entry => entry.name !== file.name)
      .map(entry => ({
        path: entry.name,
        name: entry.name,
        kind: entry.kind,
        size: entry.size,
        lastModified: entry.lastModified,
        extension: entry.extension,
        mimeCategory: entry.mimeCategory,
        action: 'existing',
        canNavigate: canNavigateEntry({ kind: entry.kind }),
      }));
    const existing = uploadTargetEntries.value.find(entry => entry.name === file.name);
    const extension = getFileExtension({ name: file.name });
    const action = getKeepArchiveAction({ existing });
    entries.push({
      path: file.name,
      name: file.name,
      kind: 'file',
      size: file.size,
      lastModified: file.lastModified,
      extension,
      mimeCategory: getMimeCategory({ extension }),
      action,
      canNavigate: false,
    });
    entries.sort((left, right) => {
      const kindComparison = comparePreviewEntryKinds({ left, right });
      if (kindComparison !== 0) {
        return kindComparison;
      }
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    state.value = {
      ...state.value,
      previewRelativePath: '',
      previewPathSegments: [],
      previewEntries: entries,
      previewSummary: createSummaryForAction({ action }),
    };
  }

  async function fallbackToLocalKeepPreview({
    file,
    errorMessage,
  }: {
    file: File,
    errorMessage: string,
  }): Promise<void> {
    const analysisId = currentAnalysisId.value;
    if (analysisId !== undefined) {
      await client.disposeZipUploadAnalysis({ analysisId }).catch(() => undefined);
    }
    currentAnalysisId.value = undefined;
    state.value = {
      ...state.value,
      phase: 'configuring',
      extractability: 'not_extractable',
      singleRootDirectoryName: undefined,
      placement: { kind: 'keep_archive' },
      errorMessage,
    };
    buildLocalKeepPreview({ file });
  }

  async function loadPreview({ relativePath }: { relativePath: string }): Promise<void> {
    const file = zipFiles.value[state.value.currentZipIndex];
    if (file === undefined) {
      return;
    }
    const version = previewRequestVersion + 1;
    previewRequestVersion = version;
    const analysisId = currentAnalysisId.value;
    if (analysisId === undefined || !canUseAnalyzedPreview({ extractability: state.value.extractability })) {
      buildLocalKeepPreview({ file });
      return;
    }
    try {
      const response = await client.readZipUploadPreviewDirectory({
        analysisId,
        placement: state.value.placement,
        relativePath,
      });
      if (version !== previewRequestVersion) {
        return;
      }
      state.value = {
        ...state.value,
        previewRelativePath: response.relativePath,
        previewPathSegments: response.pathSegments,
        previewEntries: response.entries,
        previewSummary: response.summary,
        errorMessage: undefined,
      };
    } catch (error) {
      if (version !== previewRequestVersion) {
        return;
      }
      await fallbackToLocalKeepPreview({
        file,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function analyzeCurrentZip(): Promise<void> {
    const file = zipFiles.value[state.value.currentZipIndex];
    if (file === undefined) {
      return;
    }
    const requestVersion = analysisRequestVersion + 1;
    analysisRequestVersion = requestVersion;
    const previousAnalysisId = currentAnalysisId.value;
    if (previousAnalysisId !== undefined) {
      await client.disposeZipUploadAnalysis({ analysisId: previousAnalysisId }).catch(() => undefined);
    }
    if (requestVersion !== analysisRequestVersion) {
      return;
    }
    const analysisId = createAnalysisId();
    currentAnalysisId.value = analysisId;
    state.value = {
      ...state.value,
      visibility: 'visible',
      phase: 'analyzing',
      currentFileName: file.name,
      currentFileSize: file.size,
      extractability: undefined,
      singleRootDirectoryName: undefined,
      placement: { kind: 'keep_archive' },
      previewRelativePath: '',
      previewPathSegments: [],
      previewEntries: [],
      previewSummary: createEmptySummary(),
      errorMessage: undefined,
    };
    let response: FileExplorerAnalyzeZipUploadResponse;
    try {
      response = await client.analyzeZipUpload({
        analysisId,
        targetDirectoryPath: uploadTargetDirectoryPath.value ?? currentDirectoryPath.value,
        fileName: file.name,
        blob: file,
      });
    } catch (error) {
      if (requestVersion !== analysisRequestVersion) {
        return;
      }
      await fallbackToLocalKeepPreview({
        file,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (requestVersion !== analysisRequestVersion) {
      await client.disposeZipUploadAnalysis({ analysisId }).catch(() => undefined);
      return;
    }
    switch (response.status) {
    case 'extractable':
      state.value = {
        ...state.value,
        phase: 'configuring',
        extractability: 'extractable',
        singleRootDirectoryName: response.singleRootDirectoryName,
      };
      await loadPreview({ relativePath: '' });
      break;
    case 'not_extractable':
      currentAnalysisId.value = undefined;
      state.value = {
        ...state.value,
        phase: 'configuring',
        extractability: 'not_extractable',
      };
      buildLocalKeepPreview({ file });
      break;
    default: {
      const _exhaustiveCheck: never = response;
      throw new Error(`Unhandled ZIP analysis response: ${String(_exhaustiveCheck)}`);
    }
    }
  }

  async function begin({ files }: { files: FileList | File[] }): Promise<void> {
    const values = Array.from(files);
    if (values.length === 0) {
      return;
    }
    const zips = values.filter(file => isZipCandidate({ file }));
    if (zips.length === 0) {
      try {
        await client.uploadFiles({
          targetDirectoryPath: currentDirectoryPath.value,
          files: values.map(file => ({ name: file.name, blob: file })),
        });
        await refresh();
      } catch (error) {
        addToast({
          message: await ensureStrings.fileExplorer__failed_to_upload_files({
            errorMessage: error instanceof Error ? error.message : String(error),
          }),
        });
      }
      return;
    }
    const targetDirectoryPath = currentDirectoryPath.value;
    uploadTargetDirectoryPath.value = targetDirectoryPath;
    uploadTargetEntries.value = currentEntries.value.map(entry => ({ ...entry }));
    regularFiles.value = values.filter(file => !isZipCandidate({ file }));
    zipFiles.value = zips;
    configuredZipUploads.value = [];
    completedAnalysisIds.clear();
    state.value = {
      ...state.value,
      targetDirectoryPath,
      currentZipIndex: 0,
      totalZipCount: zips.length,
    };
    try {
      await analyzeCurrentZip();
    } catch (error) {
      state.value = {
        ...state.value,
        visibility: 'hidden',
        phase: 'idle',
      };
      addToast({
        message: await ensureStrings.fileExplorer__failed_to_upload_files({
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  }

  async function setPlacement({ placement }: { placement: FileExplorerZipUploadPlacement }): Promise<void> {
    switch (placement.kind) {
    case 'keep_archive':
      break;
    case 'extract':
      if (!canUseAnalyzedPreview({ extractability: state.value.extractability })) {
        return;
      }
      switch (placement.rootHandling) {
      case 'preserve':
      case 'not_applicable':
        break;
      case 'strip':
        if (state.value.singleRootDirectoryName === undefined) {
          return;
        }
        break;
      default: {
        const _exhaustiveCheck: never = placement.rootHandling;
        throw new Error(`Unhandled ZIP root handling: ${String(_exhaustiveCheck)}`);
      }
      }
      break;
    default: {
      const _exhaustiveCheck: never = placement;
      throw new Error(`Unhandled ZIP placement: ${String(_exhaustiveCheck)}`);
    }
    }
    state.value = {
      ...state.value,
      placement,
      previewRelativePath: '',
      previewPathSegments: [],
    };
    await loadPreview({ relativePath: '' });
  }

  async function navigatePreview({ relativePath }: { relativePath: string }): Promise<void> {
    if (!canNavigatePreview({ phase: state.value.phase })) {
      return;
    }
    await loadPreview({ relativePath });
  }

  async function restoreConfigurationAfterPreviewChanged({
    configured,
    configuredIndex,
    errorMessage,
  }: {
    configured: ConfiguredZipUpload,
    configuredIndex: number,
    errorMessage: string,
  }): Promise<void> {
    const discarded = configuredZipUploads.value.slice(configuredIndex + 1);
    await Promise.all(discarded.map(async discardedUpload => {
      if (discardedUpload.analysisId !== undefined) {
        await client.disposeZipUploadAnalysis({ analysisId: discardedUpload.analysisId }).catch(() => undefined);
      }
    }));
    configuredZipUploads.value = configuredZipUploads.value.slice(0, configuredIndex);
    currentAnalysisId.value = configured.analysisId;
    state.value = {
      ...state.value,
      phase: 'configuring',
      currentZipIndex: configuredIndex,
      currentFileName: configured.file.name,
      currentFileSize: configured.file.size,
      extractability: 'extractable',
      singleRootDirectoryName: configured.singleRootDirectoryName,
      placement: configured.placement,
      errorMessage: undefined,
    };
    await loadPreview({ relativePath: '' });
    state.value = {
      ...state.value,
      errorMessage,
    };
  }

  async function executeConfiguredUploads(): Promise<boolean> {
    state.value = { ...state.value, phase: 'uploading', errorMessage: undefined };
    const filesToUpload = [...regularFiles.value];

    async function executeAnalyzedZipUpload({
      configured,
      configuredIndex,
    }: {
      configured: ConfiguredZipUpload,
      configuredIndex: number,
    }): Promise<boolean> {
      if (configured.analysisId === undefined) {
        throw new Error('Missing ZIP analysis for configured upload');
      }
      if (completedAnalysisIds.has(configured.analysisId)) {
        return true;
      }
      const job = client.startZipUpload({
        analysisId: configured.analysisId,
        placement: configured.placement,
      });
      currentJob.value = job;
      const response = await job.result;
      currentJob.value = undefined;
      switch (response.status) {
      case 'completed':
        completedAnalysisIds.add(configured.analysisId);
        await client.disposeZipUploadAnalysis({ analysisId: configured.analysisId }).catch(() => undefined);
        return true;
      case 'cancelled':
        return false;
      case 'preview_outdated': {
        const errorMessage = await ensureStrings.fileExplorer__zip_upload_preview_outdated();
        await restoreConfigurationAfterPreviewChanged({
          configured,
          configuredIndex,
          errorMessage,
        });
        return false;
      }
      default: {
        const _exhaustiveCheck: never = response;
        throw new Error(`Unhandled ZIP upload response: ${String(_exhaustiveCheck)}`);
      }
      }
    }

    try {
      for (const [configuredIndex, configured] of configuredZipUploads.value.entries()) {
        switch (configured.placement.kind) {
        case 'keep_archive':
          if (configured.analysisId === undefined) {
            filesToUpload.push(configured.file);
          } else if (!await executeAnalyzedZipUpload({ configured, configuredIndex })) {
            return false;
          }
          break;
        case 'extract': {
          if (!await executeAnalyzedZipUpload({ configured, configuredIndex })) {
            return false;
          }
          break;
        }
        default: {
          const _exhaustiveCheck: never = configured.placement;
          throw new Error(`Unhandled ZIP upload placement: ${String(_exhaustiveCheck)}`);
        }
        }
      }
      if (filesToUpload.length > 0) {
        await client.uploadFiles({
          targetDirectoryPath: uploadTargetDirectoryPath.value ?? currentDirectoryPath.value,
          files: filesToUpload.map(file => ({ name: file.name, blob: file })),
        });
      }
      await refresh();
      return true;
    } catch (error) {
      currentJob.value = undefined;
      state.value = {
        ...state.value,
        phase: 'configuring',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      return false;
    }
  }

  async function confirm(): Promise<void> {
    if (!canConfirmUpload({
      phase: state.value.phase,
      blockedCount: state.value.previewSummary.blockedCount,
    })) {
      return;
    }
    const file = zipFiles.value[state.value.currentZipIndex];
    if (file === undefined) {
      return;
    }
    configuredZipUploads.value = configuredZipUploads.value.slice(0, state.value.currentZipIndex);
    configuredZipUploads.value.push({
      file,
      analysisId: currentAnalysisId.value,
      singleRootDirectoryName: state.value.singleRootDirectoryName,
      placement: state.value.placement,
    });
    const nextIndex = state.value.currentZipIndex + 1;
    if (nextIndex < zipFiles.value.length) {
      state.value = { ...state.value, currentZipIndex: nextIndex };
      currentAnalysisId.value = undefined;
      await analyzeCurrentZip();
      return;
    }
    const completed = await executeConfiguredUploads();
    if (completed) {
      await close();
    }
  }

  async function close(): Promise<void> {
    analysisRequestVersion += 1;
    previewRequestVersion += 1;
    const job = currentJob.value;
    if (job !== undefined) {
      await job.cancel().catch(() => undefined);
      currentJob.value = undefined;
    }
    const analysisIds = new Set<string>();
    if (currentAnalysisId.value !== undefined) {
      analysisIds.add(currentAnalysisId.value);
    }
    for (const configured of configuredZipUploads.value) {
      if (configured.analysisId !== undefined) {
        analysisIds.add(configured.analysisId);
      }
    }
    await Promise.all([...analysisIds].map(analysisId =>
      client.disposeZipUploadAnalysis({ analysisId }).catch(() => undefined),
    ));
    currentAnalysisId.value = undefined;
    uploadTargetDirectoryPath.value = undefined;
    uploadTargetEntries.value = [];
    regularFiles.value = [];
    zipFiles.value = [];
    configuredZipUploads.value = [];
    state.value = {
      ...state.value,
      visibility: 'hidden',
      phase: 'idle',
      currentFileName: undefined,
      currentFileSize: undefined,
      targetDirectoryPath: '',
      currentZipIndex: 0,
      totalZipCount: 0,
      extractability: undefined,
      singleRootDirectoryName: undefined,
      placement: { kind: 'keep_archive' },
      previewRelativePath: '',
      previewPathSegments: [],
      previewEntries: [],
      previewSummary: createEmptySummary(),
      errorMessage: undefined,
    };
  }

  function dispose(): void {
    void close();
  }

  return {
    get state() {
      return state.value;
    },
    begin,
    setPlacement,
    navigatePreview,
    confirm,
    close,
    dispose,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {},
    }) || {}),
  };
}
