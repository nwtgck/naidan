import { ref } from 'vue';
import type { FileExplorerWorkerClient } from '@/features/file-explorer/worker/types';
import { acquireSharedHighlightWorkerClientLease } from '@/features/highlight/worker/client-shared';
import type { SharedHighlightWorkerClientLease } from '@/features/highlight/worker/client-shared';
import type { FileExplorerEntry, PreviewState } from '@/features/file-explorer/logic/types';
import { EXTENSION_LANGUAGE_MAP } from '@/features/file-explorer/logic/constants';
import { sanitizeHighlightHtml } from '@/logic/security/allowedHtml';
import type { AllowedHtml } from '@/logic/security/allowedHtml';

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
  let highlightWorkerClientLeasePromise: Promise<SharedHighlightWorkerClientLease> | undefined;
  let disposed = false;

  function revokeObjectUrl(): void {
    if (previewState.value.objectUrl) {
      URL.revokeObjectURL(previewState.value.objectUrl);
    }
  }

  async function getHighlightWorkerClientLease(): Promise<SharedHighlightWorkerClientLease | undefined> {
    if (disposed) {
      return undefined;
    }

    const leasePromise = highlightWorkerClientLeasePromise
      ?? acquireSharedHighlightWorkerClientLease();
    highlightWorkerClientLeasePromise = leasePromise;

    try {
      const lease = await leasePromise;
      if (!disposed) {
        return lease;
      }

      return undefined;
    } catch {
      if (highlightWorkerClientLeasePromise === leasePromise) {
        highlightWorkerClientLeasePromise = undefined;
      }
      return undefined;
    }
  }

  async function highlightText({
    entry,
    displayText,
  }: {
    entry: FileExplorerEntry,
    displayText: string,
  }): Promise<AllowedHtml | undefined> {
    const lease = await getHighlightWorkerClientLease();
    if (!lease) {
      return undefined;
    }

    try {
      const language = EXTENSION_LANGUAGE_MAP[entry.extension];
      const response = await lease.client.highlight({
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

  function isCurrentPreviewRequest({ requestId }: { requestId: number }): boolean {
    return !disposed && requestId === latestPreviewRequestId;
  }

  async function loadPreviewWithMode({
    entry,
    mode,
  }: {
    entry: FileExplorerEntry,
    mode: 'bounded' | 'force',
  }): Promise<void> {
    const requestId = ++latestPreviewRequestId;
    latestHighlightRequestId += 1;
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
      if (!isCurrentPreviewRequest({ requestId })) {
        return;
      }

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
        if (!isCurrentPreviewRequest({ requestId })) {
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
      if (!isCurrentPreviewRequest({ requestId })) {
        return;
      }

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

    const entry = state.entry;
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
    (async () => {
      try {
        const highlightedHtml = await highlightText({ entry, displayText: nextText });
        if (requestId !== latestHighlightRequestId) {
          return;
        }
        previewState.value = {
          ...previewState.value,
          highlightedHtml,
        };
      } catch (error) {
        console.error('Failed to update the file preview highlight:', error);
      }
    })();
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
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      latestPreviewRequestId += 1;
      latestHighlightRequestId += 1;
      revokeObjectUrl();

      const leasePromise = highlightWorkerClientLeasePromise;
      highlightWorkerClientLeasePromise = undefined;
      if (!leasePromise) {
        return;
      }

      (async () => {
        try {
          const lease = await leasePromise;
          await lease.release();
        } catch (error) {
          console.error('Failed to release the file preview highlight worker:', error);
        }
      })();
    },
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
