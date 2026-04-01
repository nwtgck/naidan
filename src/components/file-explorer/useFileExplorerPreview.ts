import { ref } from 'vue';
import type { FileExplorerEntry, PreviewState } from './types';
import { TEXT_PREVIEW_SIZE_LIMIT, MEDIA_PREVIEW_SIZE_LIMIT, EXTENSION_LANGUAGE_MAP } from './constants';

export function useFileExplorerPreview() {
  const previewState = ref<PreviewState>({
    visibility: 'visible',
    entry: undefined,
    textContent: undefined,
    highlightedHtml: undefined,
    objectUrl: undefined,
    jsonFormatMode: 'formatted',
    loadingState: 'idle',
    errorMessage: undefined,
    oversized: false,
  });

  function revokeObjectUrl(): void {
    if (previewState.value.objectUrl) {
      URL.revokeObjectURL(previewState.value.objectUrl);
    }
  }

  async function loadPreview({ entry }: { entry: FileExplorerEntry }): Promise<void> {
    switch (entry.kind) {
    case 'directory':
      previewState.value = {
        ...previewState.value,
        entry,
        loadingState: 'loaded',
        textContent: undefined,
        highlightedHtml: undefined,
        objectUrl: undefined,
        oversized: false,
        errorMessage: undefined,
      };
      return;
    case 'file':
      break;
    default: {
      const _ex: never = entry.kind;
      throw new Error(`Unhandled kind: ${_ex}`);
    }
    }

    revokeObjectUrl();
    previewState.value = {
      ...previewState.value,
      entry,
      textContent: undefined,
      highlightedHtml: undefined,
      objectUrl: undefined,
      errorMessage: undefined,
      oversized: false,
      loadingState: 'loading',
    };

    try {
      const file = await (entry.handle as FileSystemFileHandle).getFile();

      switch (entry.mimeCategory) {
      case 'text': {
        if (file.size > TEXT_PREVIEW_SIZE_LIMIT) {
          previewState.value = { ...previewState.value, loadingState: 'loaded', oversized: true };
          return;
        }
        await loadTextPreview({ file, entry });
        break;
      }
      case 'image':
      case 'video':
      case 'audio': {
        if (file.size > MEDIA_PREVIEW_SIZE_LIMIT) {
          previewState.value = { ...previewState.value, loadingState: 'loaded', oversized: true };
          return;
        }
        const url = URL.createObjectURL(file);
        previewState.value = { ...previewState.value, objectUrl: url, loadingState: 'loaded' };
        break;
      }
      case 'binary': {
        previewState.value = { ...previewState.value, loadingState: 'loaded' };
        break;
      }
      default: {
        const _ex: never = entry.mimeCategory;
        throw new Error(`Unhandled mimeCategory: ${_ex}`);
      }
      }
    } catch (e) {
      previewState.value = {
        ...previewState.value,
        loadingState: 'error',
        errorMessage: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async function loadPreviewForced({ entry }: { entry: FileExplorerEntry }): Promise<void> {
    switch (entry.kind) {
    case 'directory': return;
    case 'file': break;
    default: {
      const _ex: never = entry.kind;
      throw new Error(`Unhandled kind: ${_ex}`);
    }
    }
    revokeObjectUrl();
    previewState.value = {
      ...previewState.value,
      entry,
      textContent: undefined,
      highlightedHtml: undefined,
      objectUrl: undefined,
      errorMessage: undefined,
      oversized: false,
      loadingState: 'loading',
    };

    try {
      const file = await (entry.handle as FileSystemFileHandle).getFile();
      switch (entry.mimeCategory) {
      case 'text':
        await loadTextPreview({ file, entry });
        break;
      case 'image':
      case 'video':
      case 'audio': {
        const url = URL.createObjectURL(file);
        previewState.value = { ...previewState.value, objectUrl: url, loadingState: 'loaded' };
        break;
      }
      case 'binary':
        previewState.value = { ...previewState.value, loadingState: 'loaded' };
        break;
      default: {
        const _ex: never = entry.mimeCategory;
        throw new Error(`Unhandled mimeCategory: ${_ex}`);
      }
      }
    } catch (e) {
      previewState.value = {
        ...previewState.value,
        loadingState: 'error',
        errorMessage: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async function loadTextPreview({
    file,
    entry,
  }: {
    file: File;
    entry: FileExplorerEntry;
  }): Promise<void> {
    const text = await file.text();
    const rawText = text;
    let displayText = text;

    // JSON formatting
    if (entry.extension === '.json' || entry.extension === '.jsonl') {
      try {
        const parsed = JSON.parse(text);
        displayText = JSON.stringify(parsed, null, 2);
      } catch {
        // leave as-is
      }
    }

    // highlight.js syntax highlighting
    let highlightedHtml: string | undefined;
    try {
      const hljs = await import('highlight.js/lib/core');
      const lang = EXTENSION_LANGUAGE_MAP[entry.extension];
      if (lang) {
        try {
          const mod = await loadHighlightLanguage({ lang });
          hljs.default.registerLanguage(lang, mod.default);
          highlightedHtml = hljs.default.highlight(displayText, { language: lang }).value;
        } catch {
          highlightedHtml = hljs.default.highlightAuto(displayText).value;
        }
      } else {
        highlightedHtml = hljs.default.highlightAuto(displayText).value;
      }
    } catch {
      // hljs unavailable — show plain text
    }

    previewState.value = {
      ...previewState.value,
      textContent: rawText,
      highlightedHtml,
      loadingState: 'loaded',
      jsonFormatMode: 'formatted',
    };
  }

  async function loadHighlightLanguage({ lang }: { lang: string }): Promise<{ default: import('highlight.js').LanguageFn }> {
    // Dynamic import for highlight.js languages
    return await import(`highlight.js/lib/languages/${lang}`) as { default: import('highlight.js').LanguageFn };
  }

  function toggleJsonFormat(): void {
    const s = previewState.value;
    if (!s.entry || s.entry.extension !== '.json') return;
    if (!s.textContent) return;

    let newMode: 'formatted' | 'raw';
    let newText = s.textContent;

    switch (s.jsonFormatMode) {
    case 'formatted':
      newMode = 'raw';
      break;
    case 'raw':
      newMode = 'formatted';
      try {
        newText = JSON.stringify(JSON.parse(s.textContent), null, 2);
      } catch {
        // keep raw
      }
      break;
    default: {
      const _ex: never = s.jsonFormatMode;
      throw new Error(`Unhandled jsonFormatMode: ${_ex}`);
    }
    }

    previewState.value = {
      ...s,
      jsonFormatMode: newMode,
      textContent: newText,
      highlightedHtml: undefined,
    };
    // Re-highlight the new text
    if (s.entry) {
      const entry = s.entry;
      void (async () => {
        let hl: string | undefined;
        try {
          const hljs = await import('highlight.js/lib/core');
          hl = hljs.default.highlight(newText, { language: 'json' }).value;
        } catch {
          // no highlight
        }
        previewState.value = { ...previewState.value, highlightedHtml: hl, textContent: newText, entry };
      })();
    }
  }

  function clearPreview(): void {
    revokeObjectUrl();
    previewState.value = {
      visibility: previewState.value.visibility,
      entry: undefined,
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
    let newVisibility: 'visible' | 'hidden';
    switch (previewState.value.visibility) {
    case 'visible': newVisibility = 'hidden'; break;
    case 'hidden': newVisibility = 'visible'; break;
    default: {
      const _ex: never = previewState.value.visibility;
      throw new Error(`Unhandled visibility: ${_ex}`);
    }
    }
    previewState.value = { ...previewState.value, visibility: newVisibility };
  }

  return {
    previewState,
    loadPreview,
    loadPreviewForced,
    clearPreview,
    togglePreviewVisibility,
    toggleJsonFormat,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
