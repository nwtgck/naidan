<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onUnmounted, provide, shallowRef, useId, useTemplateRef, watch } from 'vue';
import { FileArchiveIcon } from 'lucide-vue-next';
import FileExplorerToolbar from './FileExplorerToolbar.vue';
import FileExplorerListView from './FileExplorerListView.vue';
import FileExplorerIconView from './FileExplorerIconView.vue';
import FileExplorerColumnView from './FileExplorerColumnView.vue';
import FileExplorerPreviewPanel from './FileExplorerPreviewPanel.vue';
import FileExplorerStatusBar from './FileExplorerStatusBar.vue';
import FileExplorerContextMenu from './FileExplorerContextMenu.vue';
import FileExplorerDirectoryDownloadDialog from './FileExplorerDirectoryDownloadDialog.vue';
import FileExplorerZipUploadDialog from './FileExplorerZipUploadDialog.vue';
import FileExplorerNewFileDialog from './FileExplorerNewFileDialog.vue';
import { useFileExplorer, FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';
import { useFileExplorerKeyboard } from '@/features/file-explorer/composables/useFileExplorerKeyboard';
import { FILE_EXPLORER_FILE_VIEW_KEY } from '@/features/file-explorer/composables/file-explorer-file-view-context';
import type { FileExplorerEntry, ViewMode, PreviewVisibility } from '@/features/file-explorer/logic/types';
import { getFileViewKind, isFileViewPathWithin } from '@/features/file-explorer/logic/file-view';
import type { FileExplorerRemoteMount, FileExplorerRootDescriptor } from '@/features/file-explorer/worker/types';
import { lazyStrings } from '@/strings';

const props = defineProps<{
  root: FileExplorerRootDescriptor,
  remoteMounts?: readonly FileExplorerRemoteMount[],
  initialViewMode: ViewMode,
  initialPreviewVisibility: PreviewVisibility,
  initialPath: string[] | undefined,
  /** When true, the explorer starts in locked mode (write operations disabled). */
  initialLocked: boolean,
}>();

let unmounted = false;
let disposeResources: (() => void) | undefined;
let returnFocus: HTMLElement | undefined;
let lastContentFocus: HTMLElement | undefined;
let leaveFocus: HTMLElement | undefined;
let leaveRequest: ReturnType<typeof Promise.withResolvers<boolean>> | undefined;
const activeFile = shallowRef<FileExplorerEntry>();
const startEditingFile = shallowRef(false);
const forceTextFile = shallowRef(false);
const isFileView = shallowRef(false);
const showFileTree = shallowRef(true);
const revealTreeTemporarily = shallowRef(false);
const showFileInformation = shallowRef(false);
const focusEditor = shallowRef(false);
const fileTreeId = useId();
const fileInformationId = useId();
const viewInstance = shallowRef(0);
const directoryRevision = shallowRef(0);
const showLeaveDialog = shallowRef(false);
const savingToLeave = shallowRef(false);
const pendingTreeMutation = shallowRef<{ paths: readonly string[], mutating: boolean }>();
const pendingFolderReveal = shallowRef<string>();
const explorerRoot = useTemplateRef<HTMLElement>('explorerRoot');
const leaveDialog = useTemplateRef<HTMLElement>('leaveDialog');
const cancelLeaveButton = useTemplateRef<HTMLButtonElement>('cancelLeaveButton');
const fileView = useTemplateRef<{ revealDirectory({ path }: { path: string }): void }>('fileView');
const fileContent = useTemplateRef<{
  hasChanges(): boolean,
  isBusy(): boolean,
  saveChanges(): Promise<boolean>,
    }>('fileContent');
const FileExplorerFileView = defineAsyncComponent(() => import('./FileExplorerFileView.vue'));
const FileExplorerFileContent = defineAsyncComponent(() => import('./FileExplorerFileContent.vue'));

onUnmounted(() => {
  unmounted = true;
  leaveRequest?.resolve(false);
  disposeResources?.();
});

defineExpose({
  allowClose,
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});

const { context, client, initialPreferences, captureStorage, savePreferences, _preview } = await useFileExplorer({
  root: props.root,
  remoteMounts: props.remoteMounts,
  initialViewMode: props.initialViewMode,
  initialPreviewVisibility: props.initialPreviewVisibility,
  initialPath: props.initialPath,
  initialLocked: props.initialLocked,
});

disposeResources = () => {
  _preview.dispose();
  context.directoryDownload.dispose();
  context.upload.dispose();
  void client.dispose();
};
if (unmounted) {
  disposeResources();
}

isFileView.value = initialPreferences?.viewMode === 'tree';
showFileTree.value = initialPreferences?.treeVisibility !== 'hidden';
showFileInformation.value = initialPreferences?.fileInformationVisibility === 'visible';

// Provide context for child components
provide(FILE_EXPLORER_INJECTION_KEY, context);
const selectedFile = computed(() => {
  const entry = (() => {
    switch (context.viewMode) {
    case 'column': {
      const pane = context.columnPanes.at(-1);
      return pane?.entries.find(candidate => candidate.name === pane.selectedEntryName);
    }
    case 'icon':
    case 'list':
      return context.selectedEntries.length === 1 ? context.selectedEntries[0] : undefined;
    default: {
      const exhaustive: never = context.viewMode;
      throw new Error(`Unhandled File Explorer view mode: ${String(exhaustive)}`);
    }
    }
  })();
  const kind = entry?.kind;
  switch (kind) {
  case 'file': return entry;
  case 'directory':
  case undefined: return undefined;
  default: {
    const exhaustive: never = kind;
    throw new Error(`Unhandled File Explorer entry kind: ${String(exhaustive)}`);
  }
  }
});
watch(() => context.currentDirectoryPath, () => {
  context.applySelection({ action: { type: 'clear' } });
  context.clearPreview();
}, { flush: 'sync' });

watch(
  [selectedFile, () => context.viewMode, () => context.previewState.visibility, isFileView],
  ([entry, mode, visibility, inFileView], [previousEntry, previousMode]) => {
    if (inFileView) {
      return;
    }
    if (entry === undefined) {
      if (previousEntry !== undefined || mode !== previousMode) {
        context.clearPreview();
      }
      return;
    }
    switch (visibility) {
    case 'visible':
      void context.loadPreview({ entry });
      break;
    case 'hidden':
      if (previousEntry !== entry || context.previewState.loadingState === 'loading') {
        context.clearPreview();
      }
      break;
    default: {
      const exhaustive: never = visibility;
      throw new Error(`Unhandled quick preview visibility: ${String(exhaustive)}`);
    }
    }
  },
);

const canFocusEditor = computed(() => {
  const entry = activeFile.value;
  if (entry === undefined) {
    return false;
  }
  const kind = getFileViewKind({ entry });
  return kind === 'text' || kind === 'markdown' || kind === 'delimited' || kind === 'patch' || kind === 'model';
});
const editorFocused = computed(() => canFocusEditor.value && focusEditor.value);
const fileTreeVisible = computed(() => !editorFocused.value && (activeFile.value === undefined || showFileTree.value || revealTreeTemporarily.value));

const canWriteToRoot = computed(() => {
  switch (props.root.kind) {
  case 'archive-root': return false;
  case 'opfs-root': return true;
  case 'native-directory': return !props.root.readOnly;
  case 'wesh-mounts': return props.root.mounts.some(mount => !mount.readOnly);
  default: {
    const exhaustive: never = props.root;
    throw new Error(`Unhandled file explorer root: ${String(exhaustive)}`);
  }
  }
});
const canUnlockFiles = computed(() => canWriteToRoot.value
  || props.remoteMounts?.some(mount => mount.deletionOnly === true && !mount.readOnly) === true);
provide(FILE_EXPLORER_FILE_VIEW_KEY, {
  isActive: isFileView,
  activeFile,
  access: client.fileAccess,
  activate: activateFileView,
  revealFolder: revealFileFolder,
  showBrowser: returnToBrowser,
  open: openFileView,
  canUnlockFiles,
});

const activeFileHasPendingMutation = computed(() => affectsActiveFile({ paths: pendingTreeMutation.value?.paths ?? [] }));
const activeFileIsMutating = computed(() => pendingTreeMutation.value?.mutating === true && activeFileHasPendingMutation.value);

async function allowClose(): Promise<boolean> {
  if (activeFileHasPendingMutation.value) {
    return false;
  }
  return await confirmFileLeave() && !activeFileHasPendingMutation.value;
}

async function confirmFileLeave(): Promise<boolean> {
  if (leaveRequest !== undefined || fileContent.value?.isBusy()) {
    return false;
  }
  if (!fileContent.value?.hasChanges()) {
    return true;
  }
  const request = Promise.withResolvers<boolean>();
  leaveRequest = request;
  leaveFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  showLeaveDialog.value = true;
  await nextTick();
  cancelLeaveButton.value?.focus();
  return request.promise;
}

function resolveLeave({ leave }: { leave: boolean }): void {
  const target = leaveFocus;
  leaveFocus = undefined;
  showLeaveDialog.value = false;
  leaveRequest?.resolve(leave);
  leaveRequest = undefined;
  if (!leave) {
    void nextTick(() => {
      if (target?.isConnected) {
        target.focus({ preventScroll: true });
      } else {
        explorerRoot.value?.querySelector<HTMLElement>('[data-testid="file-explorer-file-view-back"]')?.focus();
      }
    });
  }
}

async function saveAndLeave(): Promise<void> {
  if (savingToLeave.value) {
    return;
  }
  savingToLeave.value = true;
  leaveDialog.value?.focus();
  let saved = false;
  try {
    saved = await fileContent.value?.saveChanges() === true;
  } catch (error) {
    console.error('Failed to save the file before leaving:', error);
  } finally {
    savingToLeave.value = false;
    resolveLeave({ leave: saved && fileContent.value?.hasChanges() !== true });
  }
}

function cancelLeave(): void {
  if (!savingToLeave.value) {
    resolveLeave({ leave: false });
  }
}

function trapLeaveFocus({ event }: { event: KeyboardEvent }): void {
  const dialog = leaveDialog.value;
  if (!dialog) {
    return;
  }
  const controls = [...dialog.querySelectorAll<HTMLButtonElement>('button:enabled')];
  const first = controls[0];
  const last = controls.at(-1);
  if (first === undefined) {
    event.preventDefault();
    dialog.focus();
  } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function openFileView({ entry, startEditing, forceText }: { entry: FileExplorerEntry, startEditing?: boolean, forceText?: boolean }): Promise<void> {
  if (entry.kind !== 'file' || entry.path === activeFile.value?.path
    || isPathAffected({ paths: pendingTreeMutation.value?.paths ?? [], path: entry.path })
    || !await allowClose()
    || isPathAffected({ paths: pendingTreeMutation.value?.paths ?? [], path: entry.path })) {
    return;
  }
  enterFileView();
  viewInstance.value += 1;
  revealTreeTemporarily.value = false;
  startEditingFile.value = startEditing === true;
  forceTextFile.value = forceText === true;
  activeFile.value = entry;
}

function enterFileView(): void {
  if (isFileView.value) {
    return;
  }
  if (document.activeElement instanceof HTMLElement) {
    returnFocus = document.activeElement;
  }
  isFileView.value = true;
  switch (context.previewState.loadingState) {
  case 'loading':
    context.clearPreview();
    break;
  case 'idle': case 'loaded': case 'error':
    break;
  default: {
    const exhaustive: never = context.previewState.loadingState;
    throw new Error(`Unhandled preview state: ${String(exhaustive)}`);
  }
  }
}

async function activateFileView(): Promise<void> {
  const isCurrent = captureStorage();
  if (!isFileView.value) {
    const entry = selectedFile.value;
    if (entry === undefined) {
      enterFileView();
    } else {
      await openFileView({ entry });
    }
  }
  if (isFileView.value && !unmounted) {
    void savePreferences({ patch: { viewMode: 'tree' }, isCurrent });
  }
}

async function revealFileFolder({ path }: { path: string }): Promise<void> {
  revealTreeTemporarily.value = true;
  focusEditor.value = false;
  pendingFolderReveal.value = path;
  await nextTick();
}

watch([fileView, pendingFolderReveal], ([view, path]) => {
  if (view !== null && path !== undefined) {
    pendingFolderReveal.value = undefined;
    view.revealDirectory({ path });
  }
}, { flush: 'post' });

function isPathAffected({ paths, path }: { paths: readonly string[], path: string }): boolean {
  return paths.some(directoryPath => isFileViewPathWithin({ path, directoryPath }));
}

function affectsActiveFile({ paths }: { paths: readonly string[] }): boolean {
  const activePath = activeFile.value?.path;
  return activePath !== undefined && isPathAffected({ paths, path: activePath });
}

async function runTreeMutation({ paths, mutate }: { paths: readonly string[], mutate: () => Promise<void> }): Promise<void> {
  if (!isFileView.value || pendingTreeMutation.value !== undefined || unmounted) {
    return;
  }
  pendingTreeMutation.value = { paths, mutating: false };
  try {
    if (activeFileHasPendingMutation.value && !await confirmFileLeave()) {
      return;
    }
    pendingTreeMutation.value = { paths, mutating: true };
    await nextTick();
    if (!unmounted) {
      await mutate();
    }
  } finally {
    pendingTreeMutation.value = undefined;
  }
}

function showTreeContextMenu({ event, entry, open, directoryPath, directoryReadOnly }: {
  event: MouseEvent,
  entry: FileExplorerEntry,
  open: () => void,
  directoryPath: string,
  directoryReadOnly: boolean,
}): void {
  context.showContextMenu({
    event,
    target: {
      kind: 'entry',
      entry,
      selectedEntries: [entry],
      tree: {
        directoryPath,
        directoryReadOnly,
        open,
        runMutation: runTreeMutation,
        onMutation: ({ paths }) => {
          directoryRevision.value += 1;
          if (affectsActiveFile({ paths })) {
            activeFile.value = undefined;
            focusEditor.value = false;
            revealTreeTemporarily.value = false;
          }
        },
      },
    },
  });
}

function rememberFileContentFocus({ event }: { event: FocusEvent }): void {
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('[data-testid="file-explorer-file-view-content"]')) {
    lastContentFocus = target;
  }
}

async function toggleEditorFocus(): Promise<void> {
  focusEditor.value = !editorFocused.value;
  await nextTick();
  if (lastContentFocus?.isConnected) {
    lastContentFocus.focus({ preventScroll: true });
  }
}

function toggleFileTree(): void {
  showFileTree.value = !fileTreeVisible.value;
  revealTreeTemporarily.value = false;
  void savePreferences({ patch: { treeVisibility: showFileTree.value ? 'visible' : 'hidden' }, isCurrent: captureStorage() });
}

function toggleFileInformation(): void {
  showFileInformation.value = !showFileInformation.value;
  void savePreferences({ patch: { fileInformationVisibility: showFileInformation.value ? 'visible' : 'hidden' }, isCurrent: captureStorage() });
}

async function returnToBrowser({ mode, restoreFocus, rememberMode }: { mode: ViewMode, restoreFocus: boolean, rememberMode: boolean }): Promise<void> {
  const isCurrent = captureStorage();
  if (isFileView.value && !await allowClose()) {
    return;
  }
  context.setViewMode({ mode });
  if (rememberMode && !unmounted) {
    void savePreferences({ patch: { viewMode: mode }, isCurrent });
  }
  if (!isFileView.value) {
    return;
  }
  context.hideContextMenu();
  isFileView.value = false;
  pendingFolderReveal.value = undefined;
  activeFile.value = undefined;
  revealTreeTemporarily.value = false;
  focusEditor.value = false;
  lastContentFocus = undefined;
  await nextTick();
  if (restoreFocus) {
    const target = returnFocus?.isConnected && !(returnFocus instanceof HTMLButtonElement && returnFocus.disabled)
      ? returnFocus
      : explorerRoot.value;
    target?.focus();
  }
  returnFocus = undefined;
}

async function refreshAfterSave({ entry }: { entry: FileExplorerEntry | undefined }): Promise<void> {
  if (entry !== undefined) {
    activeFile.value = entry;
  }
  await context.refresh();
  directoryRevision.value += 1;
}

const isInsideArchive = computed(() => context.pathSegments.some(segment => segment.kind === 'archive'));

// Keyboard handler
const { handleKeyDown } = useFileExplorerKeyboard({ ctx: context });

function handleBrowserKeyDown({ event }: { event: KeyboardEvent }): void {
  if (event.defaultPrevented || event.isComposing) {
    return;
  }
  if (isFileView.value) {
    if (event.key === 'Escape' && context.contextMenuState.visibility === 'visible') {
      event.preventDefault();
      event.stopPropagation();
      context.hideContextMenu();
    }
    return;
  }
  if (event.key === 'Enter'
    && event.target instanceof Element
    && event.target.closest('button, a[href], input, select, textarea, [contenteditable]:not([contenteditable="false"])')) {
    return;
  }
  void handleKeyDown({ event });
}

</script>

<template>
  <div
    ref="explorerRoot"
    tw-class="flex flex-col h-full bg-white dark:bg-gray-900 outline-none overflow-hidden"
    tabindex="0"
    data-testid="file-explorer"
    @keydown="handleBrowserKeyDown({ event: $event })"
  >
    <!-- Toolbar -->
    <FileExplorerToolbar
      :inert="showLeaveDialog || context.newFileDirectoryPath !== undefined"
      :file-tree-visible="fileTreeVisible"
      :file-tree-id="fileTreeId"
      :file-information-visible="showFileInformation && !editorFocused"
      :file-information-id="fileInformationId"
      :editor-focused="editorFocused"
      :can-focus-editor="canFocusEditor"
      @toggle-tree="toggleFileTree"
      @toggle-information="toggleFileInformation"
      @toggle-editor-focus="toggleEditorFocus"
    />

    <div
      v-if="isInsideArchive"
      v-show="!isFileView"
      data-testid="file-explorer-archive-location"
      tw-class="flex items-center gap-2 border-b border-gray-200/60 bg-gray-50/70 px-3 py-2 text-xs font-medium text-gray-500 dark:border-gray-700/50 dark:bg-gray-800/30 dark:text-gray-400"
    >
      <FileArchiveIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />
      <span>{{ lazyStrings.fileExplorer__zip_archive() }}</span>
      <span aria-hidden="true" tw-class="text-gray-300 dark:text-gray-600">·</span>
      <span>{{ lazyStrings.fileExplorer__read_only() }}</span>
    </div>

    <!-- Main content area -->
    <div
      v-show="!isFileView"
      :inert="isFileView || context.newFileDirectoryPath !== undefined"
      :aria-busy="context.isLoading"
      data-testid="file-explorer-browser"
      tw-class="flex flex-1 overflow-hidden"
    >

      <!-- Error banner -->
      <div
        v-if="context.loadError"
        tw-class="absolute top-0 left-0 right-0 px-4 py-2 bg-red-50 dark:bg-red-900/20 border-b border-red-100 dark:border-red-900/50 text-xs text-red-600 dark:text-red-400 z-20"
      >
        {{ context.loadError }}
      </div>

      <!-- Column view has its own layout (includes preview panel) -->
      <FileExplorerColumnView v-if="context.viewMode === 'column'" />

      <!-- List + Icon view with optional preview panel -->
      <template v-else>
        <FileExplorerListView v-if="context.viewMode === 'list'" />
        <FileExplorerIconView v-else-if="context.viewMode === 'icon'" />

        <!-- Preview panel -->
        <FileExplorerPreviewPanel
          v-if="context.previewState.visibility === 'visible'"
        />
      </template>
    </div>

    <FileExplorerFileView
      v-if="isFileView"
      ref="fileView"
      :entry="activeFile"
      :directory-path="context.currentDirectoryPath"
      :read-directory="client.readDirectory"
      :tree-visible="fileTreeVisible"
      :tree-id="fileTreeId"
      :information-visible="showFileInformation && !editorFocused"
      :information-id="fileInformationId"
      :directory-revision="directoryRevision"
      :inert="showLeaveDialog"
      @open="openFileView"
      @entry-contextmenu="showTreeContextMenu"
      @focusin="rememberFileContentFocus({ event: $event })"
    >
      <template v-if="activeFile !== undefined" #default>
        <FileExplorerFileContent
          :key="viewInstance"
          ref="fileContent"
          :entry="activeFile"
          :client="client"
          :start-editing="startEditingFile"
          :force-text="forceTextFile"
          :can-write-to-root="canWriteToRoot && !context.isDeletionOnly({ path: activeFile.path })"
          :locked="context.isLocked"
          :focused="editorFocused"
          :mutation-pending="activeFileIsMutating"
          @saved="refreshAfterSave"
          @download="context.downloadEntry"
        />
      </template>
    </FileExplorerFileView>

    <div
      v-if="showLeaveDialog"
      ref="leaveDialog"
      role="alertdialog"
      aria-modal="true"
      :aria-label="lazyStrings.fileExplorer__save_changes_before_leaving()"
      tabindex="-1"
      data-testid="file-view-leave-dialog"
      tw-class="fixed inset-0 z-[140] flex items-center justify-center bg-black/40 p-4 outline-none"
      @keydown.esc.stop.prevent="cancelLeave()"
      @keydown.tab.stop="trapLeaveFocus({ event: $event })"
    >
      <div tw-class="w-full max-w-md rounded-2xl border border-gray-200/90 bg-white p-5 shadow-2xl dark:border-gray-700/80 dark:bg-gray-900">
        <p tw-class="mb-4 text-sm font-medium text-gray-900 dark:text-gray-100">{{ lazyStrings.fileExplorer__save_changes_before_leaving() }}</p>
        <div tw-class="flex flex-wrap justify-end gap-2">
          <button ref="cancelLeaveButton" type="button" :disabled="savingToLeave" data-testid="file-view-leave-cancel" tw-class="rounded-lg px-3 py-2 text-sm hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-40 dark:hover:bg-gray-800" @click="cancelLeave()">
            {{ lazyStrings.SHARED__cancel() }}
          </button>
          <button type="button" :disabled="savingToLeave" data-testid="file-view-leave-discard" tw-class="rounded-lg px-3 py-2 text-sm text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 disabled:opacity-40 dark:text-red-300 dark:hover:bg-red-900/20" @click="resolveLeave({ leave: true })">
            {{ lazyStrings.fileExplorer__discard_changes() }}
          </button>
          <button type="button" data-testid="file-view-leave-save" tw-class="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-40" :disabled="savingToLeave || fileContent?.isBusy()" @click="saveAndLeave()">
            {{ lazyStrings.fileExplorer__save() }}
          </button>
        </div>
      </div>
    </div>

    <!-- Status bar -->
    <FileExplorerStatusBar v-show="!isFileView" />

    <!-- Context menu (teleported) -->
    <FileExplorerContextMenu />

    <FileExplorerDirectoryDownloadDialog />
    <FileExplorerZipUploadDialog />
    <FileExplorerNewFileDialog v-if="context.newFileDirectoryPath !== undefined" :directory-path="context.newFileDirectoryPath" />
  </div>
</template>
