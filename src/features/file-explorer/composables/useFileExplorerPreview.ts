import { ref } from 'vue';
import type { FileExplorerWorkerClient } from '@/features/file-explorer/worker/types';
import type { FileExplorerEntry, PreviewState } from '@/features/file-explorer/logic/types';
import { TEXT_PREVIEW_SIZE_LIMIT } from '@/features/file-explorer/logic/constants';
import { DELIMITED_PREVIEW_BYTES, getFileViewKind, inspectFileView } from '@/features/file-explorer/logic/file-view';
import { createFileExplorerCodeHighlighter } from './createFileExplorerCodeHighlighter';

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
  const codeHighlighter = createFileExplorerCodeHighlighter();
  let disposed = false;

  function revokeObjectUrl(): void {
    if (previewState.value.objectUrl) {
      URL.revokeObjectURL(previewState.value.objectUrl);
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
      kind: undefined,
      format: undefined,
      loadingState: 'loading',
    };

    try {
      const sample = entry.kind === 'file' && client.fileAccess !== undefined
        ? await inspectFileView({ access: client.fileAccess, path: entry.path, signal: abort.signal })
        : undefined;
      if (!isCurrentPreviewRequest({ requestId })) {
        return;
      }
      const format = sample?.format;
      const kind = getFileViewKind({ entry, format });
      if (sample !== undefined) {
        const empty = sample.binary.bytes.length === 0 && !sample.binary.partial;
        previewState.value = { ...previewState.value, kind, format, binaryPreview: sample.binary };
        if (empty || kind === 'binary' || kind === 'archive') {
          previewState.value = { ...previewState.value, loadingState: 'loaded' };
          return;
        }
      }
      if (entry.kind === 'file' && kind === 'model' && client.fileAccess !== undefined) {
        let snapshot = await client.fileAccess.openSnapshot({ path: entry.path, signal: abort.signal });
        if (snapshot.kind === 'unsupported' && sample !== undefined && isCurrentPreviewRequest({ requestId })) {
          snapshot = await client.fileAccess.read({ path: entry.path, mode: 'bounded', maxBytes: TEXT_PREVIEW_SIZE_LIMIT, signal: abort.signal });
        }
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
          if (sample !== undefined) {
            previewState.value = { ...previewState.value, kind: 'binary', loadingState: 'loaded' };
            return;
          }
          const prefix = await client.fileAccess.read({ path: entry.path, mode: 'prefix', maxBytes: 1, signal: abort.signal });
          if (!isCurrentPreviewRequest({ requestId })) {
            return;
          }
          if ('blob' in prefix && prefix.blob.size === 0 && !prefix.partial) {
            previewState.value = { ...previewState.value, rawTextContent: '', loadingState: 'loaded' };
            return;
          }
          break;
        }
        case 'too-large':
          if (sample !== undefined) {
            previewState.value = { ...previewState.value, kind: 'binary', loadingState: 'loaded' };
            return;
          }
          break;
        default: {
          const exhaustive: never = snapshot;
          throw new Error(`Unhandled model file snapshot: ${String(exhaustive)}`);
        }
        }
      }
      if (mode === 'bounded' && kind === 'delimited' && client.fileAccess !== undefined) {
        if (sample !== undefined && !sample.binary.partial) {
          const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(sample.binary.bytes);
          previewState.value = { ...previewState.value, rawTextContent: text, textContent: text, loadingState: 'loaded' };
          return;
        }
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
      const interpretedFormat = (() => {
        const detected = format?.kind;
        switch (detected) {
        case 'text': case 'image': case 'audio': case 'video':
          return { kind: detected, mimeType: format?.mimeType };
        case 'model': case 'archive': case 'binary': case undefined:
          return undefined;
        default: {
          const exhaustive: never = detected;
          throw new Error(`Unhandled file content: ${String(exhaustive)}`);
        }
        }
      })();
      const response = await client.readPreview({ path: entry.path, mode, ...(interpretedFormat && { format: interpretedFormat }) });
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
        const highlightedHtml = kind === 'patch' || kind === 'markdown' || response.displayText.length === 0 ? undefined : await codeHighlighter.highlight({
          extension: entry.extension,
          text: response.displayText,
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
      case 'media': {
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
        const { blob, mimeType } = response;
        previewState.value = {
          ...previewState.value,
          objectUrl: URL.createObjectURL(mimeType && mimeType !== blob.type ? blob.slice(0, blob.size, mimeType) : blob),
          loadingState: 'loaded',
          oversized: false,
        };
        return;
      }
      case 'binary':
        previewState.value = {
          ...previewState.value,
          kind: 'binary',
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
        const highlightedHtml = await codeHighlighter.highlight({ extension: entry.extension, text: nextText });
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

      codeHighlighter.dispose();
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
