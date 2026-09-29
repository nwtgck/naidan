import { downloadReadableStream } from '@/utils/stream-download';
import { reactive } from 'vue';

import { useToast } from '@/composables/useToast';
import {
  addDirectoryDownloadExclusion,
  normalizeDirectoryDownloadRelativePath,
} from '@/features/file-explorer/logic/directory-download';
import type {
  DirectoryDownloadState,
  DirectoryDownloadSuggestion,
  FileExplorerDirectoryDownloadController,
} from '@/features/file-explorer/logic/types';
import type {
  FileExplorerDirectoryArchiveJob,
  FileExplorerWorkerClient,
} from '@/features/file-explorer/worker/types';
import { ensureStrings } from '@/strings';
import { sanitizeFilename } from '@/utils/string';

const SUGGESTION_DEBOUNCE_MS = 150;

export function useFileExplorerDirectoryDownload({
  client,
}: {
  client: FileExplorerWorkerClient,
}): FileExplorerDirectoryDownloadController {
  const { addToast } = useToast();
  const state = reactive<DirectoryDownloadState>({
    visibility: 'hidden',
    target: undefined,
    archiveName: '',
    exclusions: [],
    query: '',
    querySuggestion: undefined,
    suggestions: [],
    suggestionStatus: 'idle',
    suggestionResultState: 'complete',
    selectedSuggestionIndex: undefined,
    creationStatus: 'idle',
  });

  let suggestionTimer: ReturnType<typeof setTimeout> | undefined;
  let suggestionGeneration = 0;
  let archiveGeneration = 0;
  let activeDownloadAbort: AbortController | undefined;
  let activeArchiveJob: FileExplorerDirectoryArchiveJob | undefined;

  function invalidateSuggestions(): void {
    suggestionGeneration += 1;
    if (suggestionTimer !== undefined) {
      clearTimeout(suggestionTimer);
      suggestionTimer = undefined;
    }
  }

  function resetSuggestions(): void {
    invalidateSuggestions();
    state.suggestions = [];
    state.suggestionStatus = 'idle';
    state.suggestionResultState = 'complete';
    state.selectedSuggestionIndex = undefined;
  }

  async function loadSuggestions({ generation }: { generation: number }): Promise<void> {
    const target = state.target;
    if (target === undefined || state.visibility === 'hidden') {
      return;
    }

    state.suggestionStatus = 'loading';
    try {
      const response = await client.suggestArchiveExclusions({
        directoryPath: target.path,
        query: state.query,
        excludedRelativePaths: state.exclusions.map(exclusion => exclusion.relativePath),
      });
      if (generation !== suggestionGeneration || state.target !== target) {
        return;
      }
      state.suggestions = response.suggestions;
      state.suggestionStatus = 'ready';
      state.suggestionResultState = response.resultState;
      state.selectedSuggestionIndex = response.suggestions.length > 0 ? 0 : undefined;
      const normalizedQuery = normalizeDirectoryDownloadRelativePath({ path: state.query });
      state.querySuggestion = normalizedQuery === undefined
        ? undefined
        : response.suggestions.find(suggestion => suggestion.relativePath === normalizedQuery);
    } catch {
      if (generation !== suggestionGeneration || state.target !== target) {
        return;
      }
      state.suggestions = [];
      state.suggestionStatus = 'error';
      state.suggestionResultState = 'complete';
      state.selectedSuggestionIndex = undefined;
    }
  }

  function scheduleSuggestions(): void {
    invalidateSuggestions();
    if (state.target === undefined || state.visibility === 'hidden') {
      state.suggestions = [];
      state.suggestionStatus = 'idle';
      state.suggestionResultState = 'complete';
      state.selectedSuggestionIndex = undefined;
      return;
    }
    state.suggestions = [];
    state.suggestionStatus = 'loading';
    state.suggestionResultState = 'complete';
    state.selectedSuggestionIndex = undefined;
    const generation = suggestionGeneration;
    suggestionTimer = setTimeout(() => {
      suggestionTimer = undefined;
      void loadSuggestions({ generation });
    }, SUGGESTION_DEBOUNCE_MS);
  }

  function open({ target }: { target: { path: string, name: string } }): void {
    archiveGeneration += 1;
    activeDownloadAbort?.abort(new DOMException('Download replaced', 'AbortError'));
    activeDownloadAbort = undefined;
    const previousJob = activeArchiveJob;
    activeArchiveJob = undefined;
    if (previousJob !== undefined) {
      void previousJob.cancel().catch(() => undefined);
    }
    state.visibility = 'visible';
    state.target = target;
    state.archiveName = target.name;
    state.exclusions = [];
    state.query = '';
    state.querySuggestion = undefined;
    state.creationStatus = 'idle';
    resetSuggestions();
  }

  async function close(): Promise<void> {
    archiveGeneration += 1;
    invalidateSuggestions();
    activeDownloadAbort?.abort(new DOMException('Download cancelled', 'AbortError'));
    activeDownloadAbort = undefined;
    const job = activeArchiveJob;
    activeArchiveJob = undefined;
    state.visibility = 'hidden';
    state.creationStatus = 'idle';
    state.target = undefined;
    state.querySuggestion = undefined;
    state.suggestions = [];
    state.suggestionStatus = 'idle';
    state.suggestionResultState = 'complete';
    state.selectedSuggestionIndex = undefined;
    if (job !== undefined) {
      await job.cancel().catch(() => undefined);
    }
  }

  function setArchiveName({ value }: { value: string }): void {
    state.archiveName = value;
  }

  function setQuery({ value }: { value: string }): void {
    state.query = value;
    if (state.querySuggestion?.relativePath !== value) {
      state.querySuggestion = undefined;
    }
    scheduleSuggestions();
  }

  function openSuggestions(): void {
    scheduleSuggestions();
  }

  function closeSuggestions(): void {
    resetSuggestions();
  }

  function selectSuggestion({ index }: { index: number }): void {
    if (index < 0 || index >= state.suggestions.length) {
      return;
    }
    state.selectedSuggestionIndex = index;
  }

  function moveSuggestionSelection({ direction }: { direction: 'previous' | 'next' }): void {
    const count = state.suggestions.length;
    if (count === 0) {
      state.selectedSuggestionIndex = undefined;
      return;
    }
    const current = state.selectedSuggestionIndex ?? 0;
    switch (direction) {
    case 'previous':
      state.selectedSuggestionIndex = (current - 1 + count) % count;
      break;
    case 'next':
      state.selectedSuggestionIndex = (current + 1) % count;
      break;
    default: {
      const _ex: never = direction;
      throw new Error(`Unhandled suggestion direction: ${String(_ex)}`);
    }
    }
  }

  function selectedSuggestion(): DirectoryDownloadSuggestion | undefined {
    const index = state.selectedSuggestionIndex;
    return index === undefined ? undefined : state.suggestions[index];
  }

  function applySuggestion({ suggestion }: { suggestion: DirectoryDownloadSuggestion }): void {
    state.query = suggestion.relativePath;
    state.querySuggestion = suggestion;
    resetSuggestions();
  }

  function applySelectedSuggestion(): void {
    const suggestion = selectedSuggestion();
    if (suggestion === undefined) {
      return;
    }
    applySuggestion({ suggestion });
  }

  function addExclusion({ suggestion }: { suggestion: DirectoryDownloadSuggestion }): void {
    state.exclusions = addDirectoryDownloadExclusion({
      exclusions: state.exclusions,
      suggestion,
    });
    state.query = '';
    state.querySuggestion = undefined;
    resetSuggestions();
  }

  function addQueryExclusion(): void {
    const suggestion = state.querySuggestion;
    if (suggestion !== undefined) {
      addExclusion({ suggestion });
    }
  }

  function removeExclusion({ relativePath }: { relativePath: string }): void {
    state.exclusions = state.exclusions.filter(exclusion => exclusion.relativePath !== relativePath);
    resetSuggestions();
  }

  async function confirm(): Promise<void> {
    const target = state.target;
    if (target === undefined || state.creationStatus === 'creating') {
      return;
    }

    resetSuggestions();
    const generation = ++archiveGeneration;
    state.creationStatus = 'creating';
    const downloadAbort = new AbortController();
    activeDownloadAbort = downloadAbort;
    let job: FileExplorerDirectoryArchiveJob | undefined;

    try {
      job = client.startDirectoryArchive({
        directoryPath: target.path,
        excludedRelativePaths: state.exclusions.map(exclusion => exclusion.relativePath),
      });
      activeArchiveJob = job;
      const trimmedArchiveName = state.archiveName.trim();
      const archiveBase = trimmedArchiveName.toLowerCase().endsWith('.zip')
        ? trimmedArchiveName.slice(0, -4)
        : trimmedArchiveName;
      // Consume concurrently: waiting for ZIP completion before opening the sink
      // would deadlock as soon as the bounded output queue becomes full.
      await downloadReadableStream({
        stream: job.stream,
        filename: sanitizeFilename({ base: archiveBase, suffix: '.zip', fallback: target.name }),
        size: undefined,
        signal: downloadAbort.signal,
      });
      const response = await job.result;
      if (generation !== archiveGeneration) return;
      switch (response.status) {
      case 'cancelled':
        break;
      case 'completed': {
        activeArchiveJob = undefined;
        activeDownloadAbort = undefined;
        await close();
        if (response.skippedEntryCount > 0) {
          addToast({
            message: await ensureStrings.fileExplorer__unsupported_items_were_skipped({
              count: response.skippedEntryCount,
            }),
          });
        }
        break;
      }
      default: {
        const _ex: never = response;
        throw new Error(`Unhandled directory archive response: ${JSON.stringify(_ex)}`);
      }
      }
    } catch (error: unknown) {
      // Cancel only this invocation: an older failure must not cancel a newly
      // started download, and a dead worker must not block the error display.
      void job?.cancel().catch(() => undefined);
      if (generation !== archiveGeneration) {
        return;
      }
      addToast({
        message: await ensureStrings.fileExplorer__failed_to_download({
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      });
    } finally {
      if (generation === archiveGeneration) {
        activeArchiveJob = undefined;
        activeDownloadAbort = undefined;
        state.creationStatus = 'idle';
      }
    }
  }

  function dispose(): void {
    invalidateSuggestions();
    archiveGeneration += 1;
    activeDownloadAbort?.abort(new DOMException('Download cancelled', 'AbortError'));
    activeDownloadAbort = undefined;
    const job = activeArchiveJob;
    activeArchiveJob = undefined;
    if (job !== undefined) {
      void job.cancel().catch(() => undefined);
    }
  }

  return {
    state,
    open,
    close,
    setArchiveName,
    setQuery,
    openSuggestions,
    closeSuggestions,
    selectSuggestion,
    moveSuggestionSelection,
    applySelectedSuggestion,
    applySuggestion,
    addQueryExclusion,
    addExclusion,
    removeExclusion,
    confirm,
    dispose,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
