<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, shallowRef, useTemplateRef, watch } from 'vue';
import { BinaryIcon, DownloadIcon, EyeIcon, FileArchiveIcon, FileCodeIcon, FileTextIcon, Loader2Icon, LockIcon, MicIcon } from 'lucide-vue-next';
import { ensureStrings, lazyStrings } from '@/strings';
import { usePrompt } from '@/composables/usePrompt';
import { useToast } from '@/composables/useToast';
import AllowedHtmlView from '@/components/common/AllowedHtmlView.vue';
import type { AllowedHtml } from '@/logic/security/allowedHtml';
import { createFileExplorerCodeHighlighter } from '@/features/file-explorer/composables/createFileExplorerCodeHighlighter';
import { useFileExplorerLineNumbers, useFileExplorerTextWrap } from '@/features/file-explorer/composables/useFileExplorerEditorPreferences';
import { MEDIA_PREVIEW_SIZE_LIMIT, TEXT_PREVIEW_SIZE_LIMIT } from '@/features/file-explorer/logic/constants';
import { BINARY_PREVIEW_BYTES, decodeFileViewText, formatFileViewText, getDelimitedFormat, getFileViewImageExtensions, getFileViewKind, getFileViewMediaType, getFileViewParentPath, getFileViewSaveTarget, inspectFileView, withFileViewExtension } from '@/features/file-explorer/logic/file-view';
import type { FileViewKind } from '@/features/file-explorer/logic/file-view';
import type { FileExplorerBinaryPreview as BinaryPreview, FileExplorerEntry } from '@/features/file-explorer/logic/types';
import { getFileExtension, getMimeCategory } from '@/features/file-explorer/logic/utils';
import type { FileExplorerFileAccess, FileExplorerReadFileForViewResponse, FileExplorerWorkerClient } from '@/features/file-explorer/worker/types';

import FileExplorerTextWrapButton from './FileExplorerTextWrapButton.vue';

const fileExplorerTextWrap = useFileExplorerTextWrap();
const fileExplorerLineNumbers = useFileExplorerLineNumbers();
const codeHighlighter = createFileExplorerCodeHighlighter();
const MAX_HIGHLIGHT_CODE_UNITS = 64 * 1024;

type Source = Extract<FileExplorerReadFileForViewResponse, { kind: 'file' }>;
type FileText = ReturnType<typeof decodeFileViewText>;
type EditorSnapshot = { text: string, dirty: boolean, checkpoint: number };
type ModelRewrite = { header: Uint8Array<ArrayBuffer>, bodyOffset: number };

const props = defineProps<{
  entry: FileExplorerEntry,
  client: Pick<FileExplorerWorkerClient, 'fileAccess'>,
  locked: boolean,
  canWriteToRoot: boolean,
  focused: boolean,
  startEditing?: boolean,
  forceText?: boolean,
  mutationPending?: boolean,
}>();
const emit = defineEmits<{
  saved: [value: { entry: FileExplorerEntry | undefined }],
  download: [value: { entry: FileExplorerEntry }],
  'open-archive': [value: { path: string }],
  'view-kind': [value: { kind: FileViewKind }],
}>();

const FileExplorerDelimitedView = defineAsyncComponent(() => import('./FileExplorerDelimitedView.vue'));
const FileExplorerModelView = defineAsyncComponent(() => import('./FileExplorerModelView.vue'));
const FileExplorerImageView = defineAsyncComponent(() => import('./FileExplorerImageView.vue'));
const FileExplorerPatchView = defineAsyncComponent(() => import('./FileExplorerPatchView.vue'));
const FileExplorerBinaryPreview = defineAsyncComponent(() => import('./FileExplorerBinaryPreview.vue'));
const FileExplorerTranscriptionDialog = defineAsyncComponent(() => import('./FileExplorerTranscriptionDialog.vue'));
const EditorV4 = defineAsyncComponent(() => import('@/features/editor-v4/components/EditorV4.vue'));
const BlockMarkdownRenderer = defineAsyncComponent(() => import('@/components/block-markdown/BlockMarkdownRenderer.vue'));

const { showPrompt } = usePrompt();
const { addToast } = useToast();
const editor = useTemplateRef<{
  focus(): void,
  getSnapshot(): EditorSnapshot,
  captureSavepoint(): EditorSnapshot,
  markSaved({ checkpoint }: { checkpoint: number }): void,
    }>('editor');
const table = useTemplateRef<{ getDraft(): string | undefined }>('table');
const model = useTemplateRef<{ requestSave(): Promise<ModelRewrite | undefined>, markSaved(): void }>('model');

const currentEntry = shallowRef(props.entry);
const forcedText = ref(false);
const kind = ref<FileViewKind>(getFileViewKind({ entry: props.entry }));
const source = shallowRef<Source>();
const fileText = shallowRef<FileText>();
const binaryPreview = shallowRef<BinaryPreview>();
const showBytes = shallowRef(false);
const detectedExtension = shallowRef<string>();
const markdown = ref('');
let markdownTimer: ReturnType<typeof setTimeout> | undefined;
const loading = ref(true);
const limitReached = ref(false);
const loadError = ref<string>();
const editTextError = ref<string>();
const loadingTextEditor = ref(false);
const saveError = ref<string>();
const saving = ref(false);
const showSaveProgress = ref(false);
const saveProgress = shallowRef<{ writtenBytes: number, totalBytes: number }>();
let saveProgressTimer: ReturnType<typeof setTimeout> | undefined;
const pendingImage = shallowRef<Blob>();
const objectUrl = ref<string>();
const detectedMimeType = ref<string>();
const transcriptFile = shallowRef<File>();
const showSource = ref(false);
const editorMounted = ref(false);
const editorDirty = ref(false);
const tableDirty = ref(false);
const modelDirty = ref(false);
const readController = new AbortController();
const writeController = shallowRef<AbortController>();

const canWrite = computed(() => !props.mutationPending && !props.locked && props.canWriteToRoot && props.client.fileAccess !== undefined);
const canOverwrite = computed(() => canWrite.value && currentEntry.value.canMutate && source.value?.revision !== undefined
  && (fileText.value === undefined || fileText.value.editable));
const canEditText = computed(() => canWrite.value && fileText.value !== undefined && (fileText.value.editable || forcedText.value));
const isEmptySource = computed(() => source.value?.blob.size === 0 && !source.value.partial);
const canEditBinaryAsText = computed(() => canWrite.value && currentEntry.value.canMutate && !currentEntry.value.readOnly
  && (isEmptySource.value || currentEntry.value.size === undefined || currentEntry.value.size <= TEXT_PREVIEW_SIZE_LIMIT));
const delimitedFormat = computed(() => getDelimitedFormat({ extension: currentEntry.value.extension }));
const isMarkdown = computed(() => kind.value === 'markdown');
const mediaType = computed(() => {
  if (kind.value !== 'image' && kind.value !== 'audio' && kind.value !== 'video') {
    return '';
  }
  return getFileViewMediaType({
    kind: kind.value,
    blobType: detectedMimeType.value ?? source.value?.blob.type ?? '',
    extension: currentEntry.value.extension,
  });
});
const textPreview = computed(() => fileText.value?.raw ?? '');
const highlightedText = shallowRef<AllowedHtml>();

watch(kind, value => emit('view-kind', { kind: value }), { immediate: true });

watch([textPreview, kind, () => currentEntry.value.extension], async ([text, displayKind, extension], _previous, onCleanup) => {
  highlightedText.value = undefined;
  if (displayKind !== 'text' || text.length === 0 || text.length > MAX_HIGHLIGHT_CODE_UNITS) {
    return;
  }
  let current = true;
  onCleanup(() => {
    current = false;
  });
  const html = await codeHighlighter.highlight({ extension, text });
  if (current) {
    highlightedText.value = html;
  }
});

watch(editor, instance => {
  if ((props.startEditing || forcedText.value) && showSource.value) {
    instance?.focus();
  }
}, { flush: 'post' });

function replaceObjectUrl({ blob }: { blob: Blob | undefined }): void {
  if (objectUrl.value !== undefined) {
    URL.revokeObjectURL(objectUrl.value);
  }
  objectUrl.value = blob === undefined ? undefined : URL.createObjectURL(blob);
}

async function readSource({ access, path, useSnapshot, maxBytes }: {
  access: FileExplorerFileAccess, path: string, useSnapshot: boolean, maxBytes: number,
}): Promise<FileExplorerReadFileForViewResponse> {
  const signal = readController.signal;
  if (useSnapshot) {
    const snapshot = await access.openSnapshot({ path, signal });
    switch (snapshot.kind) {
    case 'file': return snapshot;
    case 'too-large': case 'unsupported': break;
    default: {
      const exhaustive: never = snapshot;
      throw new Error(`Unhandled file snapshot: ${((exhaustive satisfies never) as { readonly kind: string }).kind}`);
    }
    }
  }
  return access.read({ path, mode: 'bounded', maxBytes, signal });
}

async function loadFile(): Promise<void> {
  const access = props.client.fileAccess;
  if (access === undefined) {
    loading.value = false;
    return;
  }
  loading.value = true;
  limitReached.value = false;
  loadError.value = undefined;
  try {
    const { path } = currentEntry.value;
    const signal = readController.signal;
    const sample = await inspectFileView({ access, path, signal });
    signal.throwIfAborted();
    if (sample !== undefined) {
      const { format, binary } = sample;
      binaryPreview.value = binary;
      detectedMimeType.value = format?.mimeType;
      detectedExtension.value = format?.extension;
      if (binary.bytes.length > 0 || binary.partial) {
        kind.value = getFileViewKind({ entry: currentEntry.value, format });
      } else {
        const initialKind = kind.value;
        switch (initialKind) {
        case 'binary': kind.value = 'text';
          break;
        case 'text': case 'image': case 'audio': case 'video': case 'model': case 'archive': case 'markdown': case 'delimited': case 'patch': break;
        default: {
          const exhaustive: never = initialKind;
          throw new Error(`Unexpected empty file view: ${String(exhaustive)}`);
        }
        }
      }
    }
    switch (kind.value) {
    case 'binary': case 'archive': return;
    case 'image': case 'audio': case 'video': case 'model': case 'text': case 'markdown': case 'patch': case 'delimited':
      break;
    default: {
      const exhaustive: never = kind.value;
      throw new Error(`Unhandled file view: ${exhaustive}`);
    }
    }
    const media = kind.value === 'image' || kind.value === 'audio' || kind.value === 'video';
    const result = await readSource({
      access,
      path,
      useSnapshot: kind.value === 'model' || kind.value === 'audio' || kind.value === 'video',
      maxBytes: media ? MEDIA_PREVIEW_SIZE_LIMIT : TEXT_PREVIEW_SIZE_LIMIT,
    });
    if (signal.aborted) {
      return;
    }
    switch (result.kind) {
    case 'file': break;
    case 'too-large': limitReached.value = true;
      return;
    case 'unsupported': return;
    default: {
      const exhaustive: never = result;
      throw new Error(`Unhandled file read: ${((exhaustive satisfies never) as { readonly kind: string }).kind}`);
    }
    }
    if (kind.value !== 'model' && !media) {
      const decoded = decodeFileViewText({ bytes: await result.blob.arrayBuffer() });
      if (signal.aborted) {
        return;
      }
      fileText.value = decoded;
      markdown.value = decoded.editorText;
      if ((props.startEditing || forcedText.value) && canEditText.value) {
        openEditor();
      }
    }
    source.value = result;
    if (media && result.blob.size > 0) {
      const { blob } = result;
      replaceObjectUrl({ blob: mediaType.value !== blob.type ? blob.slice(0, blob.size, mediaType.value) : blob });
    }
  } catch (error) {
    if (!readController.signal.aborted) {
      loadError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    loading.value = false;
  }
}

async function editBinaryAsText(): Promise<void> {
  const access = props.client.fileAccess;
  if (access === undefined || !canEditBinaryAsText.value || loading.value || loadingTextEditor.value) {
    return;
  }
  editTextError.value = undefined;
  loadingTextEditor.value = true;
  const signal = readController.signal;
  try {
    const emptySource = isEmptySource.value ? source.value : undefined;
    const result = emptySource ?? await access.read({
      path: currentEntry.value.path,
      mode: 'bounded',
      maxBytes: TEXT_PREVIEW_SIZE_LIMIT,
      signal,
    });
    if (signal.aborted) {
      return;
    }
    switch (result.kind) {
    case 'file': {
      const decoded = decodeFileViewText({ bytes: await result.blob.arrayBuffer() });
      if (signal.aborted || !canEditBinaryAsText.value) {
        return;
      }
      kind.value = 'text';
      forcedText.value = true;
      showBytes.value = false;
      source.value = result;
      fileText.value = decoded;
      replaceObjectUrl({ blob: undefined });
      loadError.value = undefined;
      limitReached.value = false;
      openEditor();
      return;
    }
    case 'too-large':
      editTextError.value = await ensureStrings.fileExplorer__file_is_too_large_to_preview();
      return;
    case 'unsupported':
      editTextError.value = await ensureStrings.fileExplorer__no_file_preview();
      return;
    default: {
      const exhaustive: never = result;
      throw new Error(`Unhandled text file read: ${((exhaustive satisfies never) as { readonly kind: string }).kind}`);
    }
    }
  } catch (error) {
    if (!signal.aborted) {
      editTextError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    loadingTextEditor.value = false;
  }
}

function openEditor(): void {
  if (tableDirty.value) {
    return;
  }
  showSource.value = true;
  showBytes.value = false;
  editorMounted.value = true;
}

function updateEditorPreview({ text, dirty }: { text: string, dirty: boolean }): void {
  editorDirty.value = dirty;
  if (!isMarkdown.value) {
    return;
  }
  clearTimeout(markdownTimer);
  markdownTimer = setTimeout(() => {
    markdown.value = text;
  }, 180);
}

async function chooseSaveTarget({ suggestedName, extensions }: { suggestedName: string, extensions: readonly string[] | undefined }) {
  const directory = getFileViewParentPath({ path: currentEntry.value.path });
  const answer = await showPrompt({
    title: await ensureStrings.fileExplorer__save_as(),
    message: await ensureStrings.fileExplorer__enter_the_file_path(),
    confirmButtonText: await ensureStrings.fileExplorer__save(),
    defaultValue: directory === '/' ? `/${suggestedName}` : `${directory}/${suggestedName}`,
  });
  if (answer === null) {
    return undefined;
  }
  const target = getFileViewSaveTarget({ path: answer });
  if (target === undefined) {
    saveError.value = await ensureStrings.fileExplorer__invalid_file_path();
    return undefined;
  }
  if (extensions !== undefined && !extensions.includes(getFileExtension({ name: target.name }))) {
    saveError.value = await ensureStrings.FileExplorerFileContent__use_one_of_these_file_extensions({ extensions: extensions.join(', ') });
    return undefined;
  }
  return target;
}

async function reopenSavedModel({ access, path }: { access: FileExplorerFileAccess, path: string }): Promise<void> {
  try {
    const reopened = await access.openSnapshot({ path, signal: readController.signal });
    switch (reopened.kind) {
    case 'file':
      source.value = reopened;
      break;
    case 'unsupported': case 'too-large':
      source.value = undefined;
      loadError.value = await ensureStrings.FileExplorerModelView__failed_to_read_model();
      break;
    default: {
      const exhaustive: never = reopened;
      throw new Error(`Unhandled saved model snapshot: ${((exhaustive satisfies never) as { readonly kind: string }).kind}`);
    }
    }
  } catch (error) {
    source.value = undefined;
    loadError.value = error instanceof Error ? error.message : String(error);
  }
}

function clearWriteStatus(): void {
  clearTimeout(saveProgressTimer);
  saveProgressTimer = undefined;
  showSaveProgress.value = false;
  writeController.value = undefined;
  saveProgress.value = undefined;
}

async function saveBlob({
  blob,
  saveAs,
  suggestedName,
  extensions,
  follow,
}: {
  blob: Blob,
  saveAs: boolean,
  suggestedName: string,
  extensions: readonly string[] | undefined,
  follow: boolean,
}): Promise<boolean> {
  const access = props.client.fileAccess;
  if (saving.value || !canWrite.value || access === undefined) {
    return false;
  }
  saving.value = true;
  saveError.value = undefined;
  try {
    const revision = source.value?.revision;
    const target = !saveAs && canOverwrite.value && revision !== undefined
      ? { kind: 'replace' as const, path: currentEntry.value.path, revision }
      : await chooseSaveTarget({ suggestedName, extensions });
    if (target === undefined || readController.signal.aborted || !canWrite.value) {
      return false;
    }
    const controller = new AbortController();
    writeController.value = controller;
    saveProgressTimer = setTimeout(() => {
      showSaveProgress.value = true;
    }, 200);
    const result = await access.save({
      target,
      blob,
      signal: controller.signal,
      onProgress: ({ writtenBytes, totalBytes }) => {
        saveProgress.value = { writtenBytes, totalBytes };
      },
    });
    clearWriteStatus();
    if (readController.signal.aborted) {
      return false;
    }
    const previousSource = source.value;
    if (!follow || previousSource === undefined) {
      emit('saved', { entry: undefined });
      return true;
    }
    const name = (() => {
      switch (target.kind) {
      case 'create': return target.name;
      case 'replace': return currentEntry.value.name;
      default: {
        const exhaustive: never = target;
        throw new Error(`Unhandled save target: ${((exhaustive satisfies never) as { readonly kind: string }).kind}`);
      }
      }
    })();
    const extension = getFileExtension({ name });
    currentEntry.value = {
      ...currentEntry.value,
      path: result.path,
      name,
      extension,
      mimeCategory: getMimeCategory({ extension }),
      size: blob.size,
      lastModified: undefined,
      readOnly: result.revision === undefined,
      canMutate: result.revision !== undefined,
    };
    switch (kind.value) {
    case 'model':
      await reopenSavedModel({ access, path: result.path });
      break;
    case 'image':
      detectedMimeType.value = blob.type;
      detectedExtension.value = extension.slice(1);
      replaceObjectUrl({ blob });
      source.value = { ...previousSource, blob, name, size: blob.size, lastModified: undefined, revision: result.revision };
      break;
    case 'audio': case 'video': case 'binary': case 'text': case 'markdown': case 'delimited': case 'patch': case 'archive':
      source.value = { ...previousSource, blob, name, size: blob.size, lastModified: undefined, revision: result.revision };
      break;
    default: {
      const exhaustive: never = kind.value;
      throw new Error(`Unhandled saved file view: ${exhaustive}`);
    }
    }
    if (binaryPreview.value !== undefined) {
      try {
        const bytes = new Uint8Array(await blob.slice(0, BINARY_PREVIEW_BYTES).arrayBuffer());
        binaryPreview.value = {
          bytes,
          size: blob.size,
          partial: bytes.length < blob.size,
          lastModified: source.value?.lastModified,
          rangeReadable: binaryPreview.value.rangeReadable,
        };
      } catch {
        showBytes.value = false;
        binaryPreview.value = undefined;
      }
    }
    emit('saved', { entry: currentEntry.value });
    return true;
  } catch (error) {
    if (!writeController.value?.signal.aborted && !readController.signal.aborted) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = await ensureStrings.fileExplorer__could_not_save_file();
      saveError.value = `${message} ${detail}`;
    }
    return false;
  } finally {
    clearWriteStatus();
    saving.value = false;
  }
}

async function saveEditor({ saveAs }: { saveAs: boolean }): Promise<boolean> {
  const snapshot = editor.value?.captureSavepoint();
  const format = fileText.value;
  if (snapshot === undefined || format === undefined || !canEditText.value) {
    return false;
  }
  const raw = formatFileViewText({ text: snapshot.text, bom: format.bom, usesCRLF: format.usesCRLF });
  const blob = new Blob([raw], { type: 'text/plain;charset=utf-8' });
  const converting = !format.editable;
  const name = currentEntry.value.name;
  const extensions = converting ? ['.txt'] : delimitedFormat.value === undefined ? undefined : [currentEntry.value.extension];
  const suggestedName = converting ? withFileViewExtension({ name, extension: '.txt' }) : name;
  if (!await saveBlob({ blob, saveAs: saveAs || converting, suggestedName, extensions, follow: true })) {
    return false;
  }
  fileText.value = { ...format, raw, editorText: snapshot.text, editable: true };
  const savedKind = getFileViewKind({ entry: currentEntry.value });
  switch (savedKind) {
  case 'markdown':
    markdown.value = editor.value?.captureSavepoint().text ?? snapshot.text;
    kind.value = savedKind;
    break;
  case 'delimited': case 'patch': case 'text':
    kind.value = savedKind;
    break;
  case 'model': case 'image': case 'audio': case 'video': case 'binary': case 'archive':
    kind.value = 'text';
    break;
  default: {
    const exhaustive: never = savedKind;
    throw new Error(`Unhandled saved editor file view: ${exhaustive}`);
  }
  }
  editor.value?.markSaved({ checkpoint: snapshot.checkpoint });
  return true;
}

async function saveTable({ text }: { text: string }): Promise<boolean> {
  if (!await saveBlob({
    blob: new Blob([text], { type: 'text/plain;charset=utf-8' }),
    saveAs: false,
    suggestedName: currentEntry.value.name,
    extensions: [currentEntry.value.extension],
    follow: true,
  })) {
    return false;
  }
  const bytes = new TextEncoder().encode(text).buffer;
  const decoded = decodeFileViewText({ bytes });
  if (fileText.value?.editorText !== decoded.editorText) {
    // A table edit changes the baseline of the hidden text editor.
    editorMounted.value = false;
    editorDirty.value = false;
  }
  fileText.value = decoded;
  tableDirty.value = false;
  return true;
}

async function saveModel({ rewrite, saveAs }: { rewrite: ModelRewrite, saveAs: boolean }): Promise<boolean> {
  const { header, bodyOffset } = rewrite;
  const blob = source.value?.blob;
  if (blob === undefined || !Number.isSafeInteger(bodyOffset) || bodyOffset > blob.size || bodyOffset < 0) {
    return false;
  }
  const rewritten = new Blob([header, blob.slice(bodyOffset)], { type: 'application/octet-stream' });
  if (!await saveBlob({
    blob: rewritten,
    saveAs,
    suggestedName: withFileViewExtension({ name: currentEntry.value.name, extension: '.gguf' }),
    extensions: ['.gguf'],
    follow: true,
  })) {
    return false;
  }
  model.value?.markSaved();
  modelDirty.value = false;
  return true;
}

async function saveModelAs(): Promise<void> {
  const rewrite = await model.value?.requestSave();
  if (rewrite !== undefined) {
    await saveModel({ rewrite, saveAs: true });
  }
}

async function saveImage({ blob, saveAs }: { blob: Blob, saveAs: boolean }): Promise<boolean> {
  if (props.mutationPending) {
    return false;
  }
  const extensions = getFileViewImageExtensions({ mimeType: blob.type });
  if (extensions === undefined) {
    saveError.value = await ensureStrings.fileExplorer__could_not_save_file();
    return false;
  }
  pendingImage.value = blob;
  const sameFormat = mediaType.value === blob.type && extensions.includes(currentEntry.value.extension);
  const name = sameFormat ? currentEntry.value.name : withFileViewExtension({ name: currentEntry.value.name, extension: extensions[0] });
  if (!await saveBlob({ blob, saveAs: saveAs || !sameFormat, suggestedName: name, extensions, follow: true })) {
    return false;
  }
  pendingImage.value = undefined;
  return true;
}

function openTranscription(): void {
  const blob = source.value?.blob;
  if (blob !== undefined) {
    transcriptFile.value = blob instanceof File && blob.type === mediaType.value
      ? blob
      : new File([blob], currentEntry.value.name, { type: mediaType.value });
  }
}

async function saveTranscript({ text }: { text: string }): Promise<void> {
  const saved = await saveBlob({
    blob: new Blob([text], { type: 'text/plain;charset=utf-8' }),
    saveAs: true,
    suggestedName: withFileViewExtension({ name: currentEntry.value.name, extension: '.txt' }),
    extensions: ['.txt'],
    follow: false,
  });
  if (!saved && saveError.value !== undefined) {
    throw new Error(saveError.value);
  }
  if (saved) {
    addToast({ message: await ensureStrings.fileExplorer__file_saved() });
  }
}

function hasChanges(): boolean {
  return editor.value?.getSnapshot().dirty === true || tableDirty.value || modelDirty.value || pendingImage.value !== undefined;
}

function isBusy(): boolean {
  return saving.value;
}

async function saveChanges(): Promise<boolean> {
  if (editor.value?.getSnapshot().dirty) {
    return saveEditor({ saveAs: false });
  }
  const text = table.value?.getDraft();
  if (text !== undefined) {
    return saveTable({ text });
  }
  if (modelDirty.value) {
    const rewrite = await model.value?.requestSave();
    return rewrite !== undefined && await saveModel({ rewrite, saveAs: false });
  }
  return pendingImage.value === undefined || await saveImage({ blob: pendingImage.value, saveAs: false });
}

onMounted(async () => {
  await loadFile();
  if (props.forceText && !showSource.value && !readController.signal.aborted && (kind.value === 'binary' || isEmptySource.value)) {
    await editBinaryAsText();
  }
});
onUnmounted(() => {
  readController.abort();
  codeHighlighter.dispose();
  writeController.value?.abort();
  clearWriteStatus();
  clearTimeout(markdownTimer);
  replaceObjectUrl({ blob: undefined });
});

defineExpose({
  hasChanges,
  isBusy,
  saveChanges,
  ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
});
</script>

<template>
  <div :aria-busy="mutationPending" tw-class="relative flex h-full min-h-0 min-w-0 flex-col bg-white dark:bg-gray-900" data-testid="file-view-content">
    <div tw-class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-gray-100 bg-gray-50 px-3 py-1.5 dark:border-gray-800 dark:bg-gray-900/50">
      <div tw-class="flex min-w-0 flex-wrap items-center gap-2">
        <div v-if="fileText" tw-class="flex items-center overflow-hidden rounded-lg border border-gray-100 bg-white dark:border-gray-700 dark:bg-gray-900">
          <button
            type="button"
            :title="lazyStrings.fileExplorer__preview()"
            :aria-label="lazyStrings.fileExplorer__preview()"
            :aria-pressed="!showSource"
            :disabled="editorDirty"
            :tw-class="['p-1.5 transition-colors disabled:opacity-40', !showSource
              ? 'bg-blue-500 text-white'
              : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800']"
            data-testid="file-view-show-preview"
            @click="showSource = false"
          >
            <EyeIcon aria-hidden="true" tw-class="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            :title="canEditText ? lazyStrings.fileExplorer__edit_source() : lazyStrings.fileExplorer__view_source()"
            :aria-label="canEditText ? lazyStrings.fileExplorer__edit_source() : lazyStrings.fileExplorer__view_source()"
            :aria-pressed="showSource"
            :disabled="tableDirty"
            :tw-class="['p-1.5 transition-colors disabled:opacity-40', showSource
              ? 'bg-blue-500 text-white'
              : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800']"
            data-testid="file-view-edit-source"
            @click="openEditor"
          >
            <FileCodeIcon aria-hidden="true" tw-class="w-3.5 h-3.5" />
          </button>
        </div>
        <button
          v-if="(kind === 'binary' || isEmptySource) && !fileText && canEditBinaryAsText && !loading"
          type="button"
          :aria-busy="loadingTextEditor"
          :disabled="loadingTextEditor"
          data-testid="file-view-edit-binary-as-text"
          tw-class="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800"
          @click="editBinaryAsText"
        >
          <FileCodeIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />
          {{ lazyStrings.fileExplorer__edit_as_text() }}
        </button>
        <span v-if="showSource && forcedText && fileText && !fileText.editable && canEditText" tw-class="text-xs text-gray-500 dark:text-gray-400">
          {{ lazyStrings.FileExplorerFileContent__save_as_utf8() }}
        </span>
        <span
          v-else-if="source && !locked && !canOverwrite"
          tw-class="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"
          data-testid="file-view-read-only"
        >
          <LockIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />
          {{ lazyStrings.fileExplorer__read_only() }}
        </span>
        <button
          v-if="source && !isEmptySource && (kind === 'audio' || kind === 'video')"
          type="button"
          tw-class="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-900/20"
          @click="openTranscription"
        >
          <MicIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />
          {{ lazyStrings.fileExplorer__open_in_transcription() }}
        </button>
      </div>
      <div tw-class="flex flex-wrap items-center gap-2">
        <button
          v-if="binaryPreview && binaryPreview.bytes.length > 0 && kind !== 'binary' && !loading"
          type="button"
          :title="lazyStrings.fileExplorer__view_bytes()"
          :aria-label="lazyStrings.fileExplorer__view_bytes()"
          :aria-pressed="showBytes"
          data-testid="file-view-bytes-toggle"
          :tw-class="['rounded-md p-1.5 transition-colors', showBytes ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800']"
          @click="showBytes = !showBytes"
        >
          <BinaryIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />
        </button>
        <FileExplorerTextWrapButton v-if="fileText && !showSource && (kind === 'text' || kind === 'patch')" data-testid="file-view-wrap-toggle" />
        <button v-if="showSource && canEditText" type="button" :disabled="saving || !canOverwrite" tw-class="rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40" data-testid="file-view-save" @click="saveEditor({ saveAs: false })">
          {{ lazyStrings.fileExplorer__save() }}
        </button>
        <button v-if="showSource && canEditText" type="button" :disabled="saving" tw-class="rounded-md px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800" data-testid="file-view-save-as" @click="saveEditor({ saveAs: true })">
          {{ lazyStrings.fileExplorer__save_as() }}
        </button>
        <button v-if="modelDirty && canWrite" type="button" :disabled="saving" tw-class="rounded-md px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800" @click="saveModelAs">
          {{ lazyStrings.fileExplorer__save_as() }}
        </button>
        <template v-if="pendingImage">
          <button type="button" :disabled="saving || !canWrite" tw-class="rounded-md px-2.5 py-1.5 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-40 dark:text-blue-300" data-testid="file-view-save-image" @click="saveImage({ blob: pendingImage, saveAs: false })">
            {{ lazyStrings.fileExplorer__save() }}
          </button>
          <button type="button" :disabled="saving || !canWrite" tw-class="rounded-md px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800" data-testid="file-view-save-image-as" @click="saveImage({ blob: pendingImage, saveAs: true })">
            {{ lazyStrings.fileExplorer__save_as() }}
          </button>
        </template>
        <button type="button" :title="lazyStrings.fileExplorer__download()" :aria-label="lazyStrings.fileExplorer__download()" tw-class="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800" @click="emit('download', { entry: currentEntry })">
          <DownloadIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>

    <p v-if="saveError || editTextError" role="alert" tw-class="mx-3 mt-2 break-words rounded-md bg-red-50 p-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">
      {{ saveError || editTextError }}
    </p>
    <div v-if="showSaveProgress && writeController" tw-class="absolute inset-x-3 top-10 z-10 flex items-center gap-2 rounded-lg border border-gray-100 bg-white px-3 py-2 shadow-sm sm:left-auto sm:w-64 dark:border-gray-800 dark:bg-gray-900">
      <progress :aria-label="lazyStrings.fileExplorer__save()" :value="saveProgress?.writtenBytes" :max="Math.max(1, saveProgress?.totalBytes ?? 1)" tw-class="min-w-0 flex-1" />
      <button type="button" data-testid="file-view-cancel-write" tw-class="rounded-md px-2 py-1 text-xs hover:bg-gray-100 dark:hover:bg-gray-800" @click="writeController?.abort()">
        {{ lazyStrings.SHARED__cancel() }}
      </button>
    </div>

    <FileExplorerBinaryPreview
      v-if="!loading && binaryPreview && (showBytes || kind === 'binary')"
      :preview="binaryPreview"
      :path="currentEntry.path"
      :access="client.fileAccess"
      allow-jump
    />
    <div v-show="!showBytes && (kind !== 'binary' || !binaryPreview || loading)" :inert="showBytes" tw-class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div v-if="loading" tw-class="flex flex-1 items-center justify-center" role="status">
        <Loader2Icon aria-hidden="true" tw-class="h-5 w-5 animate-spin text-gray-400" />
      </div>
      <p v-else-if="loadError" role="alert" tw-class="p-4 text-sm text-red-700 dark:text-red-300">{{ loadError }}</p>
      <p v-else-if="limitReached" tw-class="p-4 text-sm text-gray-500">{{ lazyStrings.fileExplorer__file_is_too_large_to_preview() }}</p>
      <p v-else-if="isEmptySource && !fileText" data-testid="file-view-empty-file" tw-class="flex flex-1 items-center justify-center p-4 text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.fileExplorer__file_is_empty() }}</p>
      <div v-else-if="kind === 'archive'" tw-class="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-gray-500 dark:text-gray-400">
        <FileArchiveIcon aria-hidden="true" tw-class="h-7 w-7" />
        <span tw-class="text-xs font-medium uppercase">{{ detectedExtension }}</span>
        <button type="button" data-testid="file-view-open-archive" tw-class="rounded-lg bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-300" @click="emit('open-archive', { path: currentEntry.path })">
          {{ lazyStrings.fileExplorer__browse_archive_contents() }}
        </button>
      </div>
      <FileExplorerModelView
        v-else-if="kind === 'model' && source && client.fileAccess"
        ref="model"
        :file="source.blob"
        :access="client.fileAccess"
        :can-save="canWrite"
        :saving="saving"
        @dirty-change="modelDirty = $event.dirty"
        @save="saveModel({ rewrite: $event, saveAs: false })"
      />
      <FileExplorerImageView v-else-if="kind === 'image' && objectUrl && source" :url="objectUrl" :file-name="currentEntry.name" :mime-type="mediaType" :can-save="canWrite && !saving" @save="saveImage({ blob: $event.blob, saveAs: false })" />
      <div v-else-if="kind === 'audio' && objectUrl" tw-class="flex flex-1 items-center justify-center p-5">
        <audio :src="objectUrl" controls preload="metadata" tw-class="w-full max-w-xl" />
      </div>
      <div v-else-if="kind === 'video' && objectUrl" tw-class="flex min-h-0 flex-1 items-center justify-center p-3">
        <video :src="objectUrl" controls preload="metadata" tw-class="max-h-full max-w-full rounded" />
      </div>

      <template v-else-if="fileText">
        <div v-show="showSource" :inert="!showSource" tw-class="flex min-h-0 flex-1 overflow-hidden">
          <EditorV4
            v-if="editorMounted"
            ref="editor"
            v-model:word-wrap="fileExplorerTextWrap"
            v-model:line-numbers="fileExplorerLineNumbers"
            :initial-text="fileText.editorText"
            :read-only="!canEditText"
            tw-class="min-w-0 flex-1"
            @change="updateEditorPreview"
            @request-save="saveEditor({ saveAs: false })"
          />
          <div v-if="kind === 'markdown' && showSource && !focused" tw-class="min-w-0 flex-1 overflow-auto border-l border-gray-100 p-4 dark:border-gray-800">
            <BlockMarkdownRenderer :content="markdown" />
          </div>
        </div>
        <div v-show="!showSource" :inert="showSource" tw-class="flex min-h-0 flex-1 flex-col overflow-auto">
          <p v-if="isEmptySource" data-testid="file-view-empty-file" tw-class="flex flex-1 items-center justify-center p-4 text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.fileExplorer__file_is_empty() }}</p>
          <FileExplorerDelimitedView
            v-else-if="delimitedFormat"
            ref="table"
            :text="textPreview"
            :format="delimitedFormat"
            mode="detail"
            :partial="false"
            :editable="canEditText"
            :saving="saving"
            @dirty-change="tableDirty = $event.dirty"
            @save="saveTable({ text: $event.text })"
          />
          <FileExplorerPatchView v-else-if="kind === 'patch'" :text="textPreview" />
          <template v-else-if="kind === 'markdown'">
            <div v-if="!showSource" tw-class="min-w-0 p-4">
              <BlockMarkdownRenderer :content="markdown" />
            </div>
          </template>
          <AllowedHtmlView
            v-else-if="highlightedText"
            as="pre"
            :html="highlightedText"
            :tw-class="['m-0 p-3 font-mono text-xs leading-relaxed text-gray-700 dark:text-gray-300', fileExplorerTextWrap
              ? 'whitespace-pre-wrap wrap-anywhere'
              : 'min-w-max whitespace-pre']"
            data-testid="file-view-text"
          />
          <pre
            v-else
            :tw-class="['m-0 p-3 font-mono text-xs leading-relaxed text-gray-700 dark:text-gray-300', fileExplorerTextWrap
              ? 'whitespace-pre-wrap wrap-anywhere'
              : 'min-w-max whitespace-pre']"
            data-testid="file-view-text"
          >{{ textPreview }}</pre>
        </div>
      </template>
      <div v-else tw-class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-sm text-gray-500">
        <FileTextIcon aria-hidden="true" tw-class="h-7 w-7 text-gray-400" />
        {{ lazyStrings.fileExplorer__no_file_preview() }}
      </div>
    </div>

    <FileExplorerTranscriptionDialog
      v-if="transcriptFile"
      :file="transcriptFile"
      :save-text="canWrite ? saveTranscript : undefined"
      @close="transcriptFile = undefined"
    />
  </div>
</template>
