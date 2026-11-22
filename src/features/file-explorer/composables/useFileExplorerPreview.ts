import { ref } from 'vue';
import type { FileExplorerWorkerClient } from '@/features/file-explorer/worker/types';
import { acquireSharedHighlightWorkerClientLease } from '@/features/highlight/worker/client-shared';
import type { SharedHighlightWorkerClientLease } from '@/features/highlight/worker/client-shared';
import type { FileExplorerEntry, PreviewState } from '@/features/file-explorer/logic/types';
import { EXTENSION_LANGUAGE_MAP } from '@/features/file-explorer/logic/constants';
import { BINARY_PREVIEW_BYTES, DELIMITED_PREVIEW_BYTES, getDelimitedFormat, getFileViewKind } from '@/features/file-explorer/logic/file-view';
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
  let previewAbort: AbortController | undefined;
  let activeLoad: { entry: FileExplorerEntry, promise: Promise<void> } | undefined;
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
    if (disposed) {
      return;
    }
    const requestId = ++latestPreviewRequestId;
    previewAbort?.abort();
    const abort = new AbortController();
    previewAbort = abort;
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
      partial: false,
      modelFile: undefined,
      binaryPreview: undefined,
      loadingState: 'loading',
    };

    try {
      const kind = getFileViewKind({ entry });
      if (entry.kind === 'file' && kind === 'model' && client.fileAccess !== undefined) {
        const snapshot = await client.fileAccess.openSnapshot({ path: entry.path, signal: abort.signal });
        if (!isCurrentPreviewRequest({ requestId })) {
          return;
        }
        switch (snapshot.kind) {
        case 'file':
          previewState.value = snapshot.blob.size === 0
            ? { ...previewState.value, rawTextContent: '', loadingState: 'loaded' }
            : { ...previewState.value, modelFile: snapshot.blob, loadingState: 'loaded' };
          return;
        case 'unsupported': {
          const sample = await client.fileAccess.read({ path: entry.path, mode: 'prefix', maxBytes: 1, signal: abort.signal });
          if (!isCurrentPreviewRequest({ requestId })) {
            return;
          }
          if ('blob' in sample && sample.blob.size === 0 && !sample.partial) {
            previewState.value = { ...previewState.value, rawTextContent: '', loadingState: 'loaded' };
            return;
          }
          break;
        }
        case 'too-large':
          break;
        default: {
          const exhaustive: never = snapshot;
          throw new Error(`Unhandled model file snapshot: ${String(exhaustive)}`);
        }
        }
      }
      if (entry.kind === 'file' && kind === 'binary' && client.fileAccess !== undefined) {
        const prefix = await client.fileAccess.read({ path: entry.path, mode: 'prefix', maxBytes: BINARY_PREVIEW_BYTES, signal: abort.signal });
        if (!isCurrentPreviewRequest({ requestId })) {
          return;
        }
        switch (prefix.kind) {
        case 'file': {
          const bytes = new Uint8Array(await prefix.blob.arrayBuffer());
          if (isCurrentPreviewRequest({ requestId })) {
            previewState.value = { ...previewState.value, binaryPreview: { bytes, partial: prefix.partial }, loadingState: 'loaded' };
          }
          return;
        }
        case 'unsupported': case 'too-large': break;
        default: {
          const exhaustive: never = prefix;
          throw new Error(`Unhandled binary file preview: ${String(exhaustive)}`);
        }
        }
      }
      if (mode === 'bounded' && getDelimitedFormat({ extension: entry.extension }) !== undefined && client.fileAccess !== undefined) {
        const prefix = await client.fileAccess.read({
          path: entry.path,
          mode: 'prefix',
          maxBytes: DELIMITED_PREVIEW_BYTES,
          signal: abort.signal,
        });
        if (!isCurrentPreviewRequest({ requestId })) {
          return;
        }
        switch (prefix.kind) {
        case 'too-large':
          previewState.value = { ...previewState.value, loadingState: 'loaded', oversized: true };
          return;
        case 'file': {
          const bytes = await prefix.blob.arrayBuffer();
          const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes, { stream: prefix.partial });
          if (isCurrentPreviewRequest({ requestId })) {
            previewState.value = {
              ...previewState.value,
              rawTextContent: text,
              textContent: text,
              partial: prefix.partial,
              loadingState: 'loaded',
            };
          }
          return;
        }
        case 'unsupported':
          break;
        default: {
          const exhaustive: never = prefix;
          throw new Error(`Unhandled file prefix result: ${String(exhaustive)}`);
        }
        }
      }
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
        const highlightedHtml = kind === 'patch' || kind === 'markdown' || response.displayText.length === 0 ? undefined : await highlightText({
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
        if (response.blob.size === 0) {
          previewState.value = { ...previewState.value, rawTextContent: '', loadingState: 'loaded' };
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
    } finally {
      if (previewAbort === abort) {
        previewAbort = undefined;
      }
    }
  }

  function loadPreview({ entry }: { entry: FileExplorerEntry }): Promise<void> {
    if (activeLoad?.entry.path === entry.path
      && activeLoad.entry.size === entry.size
      && activeLoad.entry.lastModified === entry.lastModified
      && previewState.value.loadingState !== 'error') {
      return activeLoad.promise;
    }
    const promise = loadPreviewWithMode({ entry, mode: 'bounded' });
    activeLoad = { entry, promise };
    return promise;
  }

  function loadPreviewForced({ entry }: { entry: FileExplorerEntry }): Promise<void> {
    const promise = loadPreviewWithMode({ entry, mode: 'force' });
    activeLoad = { entry, promise };
    return promise;
  }

  function invalidatePreviewLoad(): void {
    activeLoad = undefined;
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
    invalidatePreviewLoad();
    previewAbort?.abort();
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
    invalidatePreviewLoad,
    togglePreviewVisibility,
    toggleJsonFormat,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      latestPreviewRequestId += 1;
      latestHighlightRequestId += 1;
      invalidatePreviewLoad();
      previewAbort?.abort();
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
export const TEST_ONLY = {
};
