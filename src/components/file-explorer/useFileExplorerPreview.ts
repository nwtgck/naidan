import { ref } from 'vue';
import type { FileExplorerWorkerClient } from '@/services/file-explorer/worker/types';
import { acquireSharedHighlightWorkerClient, releaseSharedHighlightWorkerClient } from '@/services/highlight/worker/client-shared';
import type { FileExplorerEntry, PreviewState } from './types';
import { EXTENSION_LANGUAGE_MAP } from './constants';
import { sanitizeHighlightHtml } from '@/lib/security/allowedHtml';
import type { AllowedHtml } from '@/lib/security/allowedHtml';

export function useFileExplorerPreview({
  client,
}: {
  client: FileExplorerWorkerClient,
}) {
  const previewState = ref<PreviewState>({
    visibility: 'visible',
    entry: undefined,
    rawTextContent: undefined,
    textContent: undefined,
    highlightedHtml: undefined,
    objectUrl: undefined,
    jsonFormatMode: 'formatted',
    loadingState: 'idle',
    errorMessage: undefined,
    oversized: false,
  });
  let latestPreviewRequestId = 0;
  let latestHighlightRequestId = 0;
  const highlightWorkerClientPromise = acquireSharedHighlightWorkerClient();

  function revokeObjectUrl(): void {
    if (previewState.value.objectUrl) {
      URL.revokeObjectURL(previewState.value.objectUrl);
    }
  }

  async function highlightText({
    entry,
    displayText,
  }: {
    entry: FileExplorerEntry,
    displayText: string,
  }): Promise<AllowedHtml | undefined> {
    try {
      const language = EXTENSION_LANGUAGE_MAP[entry.extension];
      const client = await highlightWorkerClientPromise;
      const response = await client.highlight({
        request: {
          code: displayText,
          language,
          mode: language ? 'named-language' : 'auto-detect',
        },
      });
      return sanitizeHighlightHtml({ html: response.html });
    } catch {
      return undefined;
    }
  }

  async function loadPreviewWithMode({
    entry,
    mode,
  }: {
    entry: FileExplorerEntry,
    mode: 'bounded' | 'force',
  }): Promise<void> {
    const requestId = ++latestPreviewRequestId;
    revokeObjectUrl();
    previewState.value = {
      ...previewState.value,
      entry,
      rawTextContent: undefined,
      textContent: undefined,
      highlightedHtml: undefined,
      objectUrl: undefined,
      errorMessage: undefined,
      oversized: false,
      loadingState: 'loading',
    };

    try {
      const response = await client.readPreview({ path: entry.path, mode });
      switch (response.kind) {
      case 'directory':
        previewState.value = {
          ...previewState.value,
          loadingState: 'loaded',
          oversized: false,
        };
        return;
      case 'text': {
        if (response.oversized) {
          previewState.value = {
            ...previewState.value,
            loadingState: 'loaded',
            oversized: true,
          };
          return;
        }
        const highlightedHtml = await highlightText({
          entry,
          displayText: response.displayText,
        });
        if (requestId !== latestPreviewRequestId) {
          return;
        }
        previewState.value = {
          ...previewState.value,
          rawTextContent: response.rawText,
          textContent: response.displayText,
          highlightedHtml,
          jsonFormatMode: 'formatted',
          loadingState: 'loaded',
          oversized: false,
        };
        return;
      }
      case 'media':
        if (response.oversized) {
          previewState.value = {
            ...previewState.value,
            loadingState: 'loaded',
            oversized: true,
          };
          return;
        }
        previewState.value = {
          ...previewState.value,
          objectUrl: URL.createObjectURL(response.blob),
          loadingState: 'loaded',
          oversized: false,
        };
        return;
      case 'binary':
        previewState.value = {
          ...previewState.value,
          loadingState: 'loaded',
          oversized: response.oversized,
        };
        return;
      default: {
        const _exhaustiveCheck: never = response;
        throw new Error(`Unhandled preview response: ${String(_exhaustiveCheck)}`);
      }
      }
    } catch (error) {
      previewState.value = {
        ...previewState.value,
        loadingState: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function loadPreview({ entry }: { entry: FileExplorerEntry }): Promise<void> {
    await loadPreviewWithMode({ entry, mode: 'bounded' });
  }

  async function loadPreviewForced({ entry }: { entry: FileExplorerEntry }): Promise<void> {
    await loadPreviewWithMode({ entry, mode: 'force' });
  }

  function toggleJsonFormat(): void {
    const state = previewState.value;
    if (!state.entry || state.entry.extension !== '.json' || !state.rawTextContent) {
      return;
    }

    let nextMode: 'formatted' | 'raw';
    let nextText: string;

    switch (state.jsonFormatMode) {
    case 'formatted':
      nextMode = 'raw';
      nextText = state.rawTextContent;
      break;
    case 'raw':
      nextMode = 'formatted';
      try {
        nextText = JSON.stringify(JSON.parse(state.rawTextContent), null, 2);
      } catch {
        nextText = state.rawTextContent;
      }
      break;
    default: {
      const _exhaustiveCheck: never = state.jsonFormatMode;
      throw new Error(`Unhandled json format mode: ${_exhaustiveCheck}`);
    }
    }

    previewState.value = {
      ...state,
      jsonFormatMode: nextMode,
      textContent: nextText,
      highlightedHtml: undefined,
    };

    const requestId = ++latestHighlightRequestId;
    void highlightText({ entry: state.entry, displayText: nextText }).then(highlightedHtml => {
      if (requestId !== latestHighlightRequestId) {
        return;
      }
      previewState.value = {
        ...previewState.value,
        highlightedHtml,
      };
    });
  }

  function clearPreview(): void {
    latestPreviewRequestId += 1;
    latestHighlightRequestId += 1;
    revokeObjectUrl();
    previewState.value = {
      visibility: previewState.value.visibility,
      entry: undefined,
      rawTextContent: undefined,
      textContent: undefined,
      highlightedHtml: undefined,
      objectUrl: undefined,
      jsonFormatMode: 'formatted',
      loadingState: 'idle',
      errorMessage: undefined,
      oversized: false,
    };
  }

  function togglePreviewVisibility(): void {
    previewState.value = {
      ...previewState.value,
      visibility: (() => {
        switch (previewState.value.visibility) {
        case 'visible':
          return 'hidden';
        case 'hidden':
          return 'visible';
        default: {
          const _exhaustiveCheck: never = previewState.value.visibility;
          throw new Error(`Unhandled preview visibility: ${_exhaustiveCheck}`);
        }
        }
      })(),
    };
  }

  return {
    previewState,
    loadPreview,
    loadPreviewForced,
    clearPreview,
    togglePreviewVisibility,
    toggleJsonFormat,
    dispose() {
      void releaseSharedHighlightWorkerClient();
    },
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
