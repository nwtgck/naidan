<script lang="ts">
import type { VolumeId } from '@/01-models/ids';
export type CreatedVolumeMount = { volumeId: VolumeId, mountPath: string, readOnly: boolean, operationContext?: string };
</script>
<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, inject, useId, nextTick, type Ref } from 'vue';
import { ensureStrings, lazyStrings } from '@/strings';
import { onClickOutside, useToggle } from '@vueuse/core';
import { storageService } from '@/00-storage/service';
import { checkOPFSSupport, checkFileSystemAccessSupport } from '@/utils/opfs-detection';
import { useToast } from '@/composables/useToast';
import { useAnchoredPopup } from '@/composables/useAnchoredPopup';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import {
  FolderDownIcon,
  FolderPlusIcon,
  FileDownIcon,
  LockIcon,
  PencilIcon,
  InfoIcon,
  ChevronDownIcon,
} from 'lucide-vue-next';

const props = defineProps<{
  /** Existing mount paths used to avoid conflicts when suggesting a default path. */
  existingMountPaths: string[],
  /** Prefix prepended when generating a suggested mount path (e.g. '/' or '/home/user/'). */
  mountPathPrefix: string,
  /** CSS selector for the drag-overlay Teleport target. Omit to disable drag-drop. */
  dragOverlayTarget?: string,
  /** Captured before opening a picker or starting a copy; never inferred at completion. */
  operationContext?: string,
  /** Optional completion callback retained across unmount. Replaces created emission. */
  completeCreation?: ({ volumeId, mountPath, readOnly, operationContext }: { volumeId: VolumeId, mountPath: string, readOnly: boolean, operationContext?: string }) => Promise<void>,
}>();

const emit = defineEmits<{
  /**
   * Fired after a volume is created. The parent is responsible for mounting it
   * (globally via storageService or as a chat group mount).
   */
  created: [CreatedVolumeMount],
  'operation-state': [{ operationContext: string | undefined, pending: boolean }],
}>();

const { addToast } = useToast();
let mounted = true;

const isCreating = ref(false);
const progress = ref<{ processed: number, total: number } | null>(null);
const progressLabelId = useId();
const progressDisplay = computed(() => {
  const current = progress.value;
  if (!current || !Number.isFinite(current.total) || current.total <= 0 || !Number.isFinite(current.processed)) {
    return undefined;
  }
  const processed = Math.min(current.total, Math.max(0, current.processed));
  return { processed, total: current.total, percentage: (processed / current.total) * 100 };
});
const copyAbortController = ref<AbortController | null>(null);
const copyingLabel = ref<string | undefined>(undefined);
const creationKind = ref<'copy' | 'host'>('copy');
const progressLabel = computed(() => {
  if (copyingLabel.value !== undefined) {
    return copyingLabel.value;
  }
  switch (creationKind.value) {
  case 'copy': return lazyStrings.volumes__copying_folder_to_browser();
  case 'host': return lazyStrings.volumes__add_folder();
  default: {
    const _ex: never = creationKind.value;
    throw new Error(`Unhandled creation kind: ${_ex}`);
  }
  }
});

const hasFileSystemAccess = ref(false);
const hasOPFS = ref(false);
const isDetecting = ref(true);
const isFullyUnsupported = computed(() => !isDetecting.value && !hasFileSystemAccess.value && !hasOPFS.value);

const [isAddFolderInfoOpen, toggleAddFolderInfo] = useToggle(false);
const [isAddFolderModeOpen, toggleAddFolderMode] = useToggle(false);
const addFolderInfoRef = ref<HTMLElement | null>(null);
const addFolderTriggerRef = ref<HTMLButtonElement | null>(null);
const addFolderModeRef = ref<HTMLElement | null>(null);
const addFolderModeId = useId();
const addFolderModeHeadingId = useId();
const addFolderPopup = useAnchoredPopup({ anchor: addFolderTriggerRef, preferredWidth: { unit: 'rem', value: 18 }, maxWidthPx: 360, preferredPlacement: { direction: 'top', minHeightPx: 224 } });
const addFolderInfoTriggerRef = ref<HTMLButtonElement | null>(null);
const addFolderInfoPanelRef = ref<HTMLElement | null>(null);
const addFolderInfoId = useId();
const addFolderInfoHeadingId = useId();
const addFolderInfoPopup = useAnchoredPopup({ anchor: addFolderInfoRef, preferredWidth: { unit: 'rem', value: 18 }, maxWidthPx: 360, preferredPlacement: { direction: 'top', minHeightPx: 144 } });
onClickOutside(addFolderInfoRef, () => {
  isAddFolderInfoOpen.value = false;
  toggleAddFolderMode(false);
}, { ignore: [addFolderModeRef, addFolderInfoPanelRef] });

function closeAddFolderMode({ restoreFocus }: { restoreFocus: boolean }) {
  toggleAddFolderMode(false);
  if (restoreFocus) {
    addFolderTriggerRef.value?.focus();
  }
}

function deactivateFolderPopup({ element }: { element: Element }) {
  element.setAttribute('inert', '');
  element.setAttribute('aria-hidden', 'true');
  if (element instanceof HTMLElement) {
    element.style.pointerEvents = 'none';
  }
  for (const button of element.querySelectorAll<HTMLButtonElement>('button')) {
    button.disabled = true;
  }
}

function toggleAddFolderModeFromUi() {
  if (isCreating.value || !hasFileSystemAccess.value || isDetecting.value) {
    return;
  }
  if (isAddFolderModeOpen.value) {
    closeAddFolderMode({ restoreFocus: false });
  } else {
    void createVolume({ type: 'host' });
  }
}

function chooseAddFolderMode({ mode }: { mode: 'read' | 'readwrite' }) {
  if (!isAddFolderModeOpen.value || isCreating.value || !hasFileSystemAccess.value || isDetecting.value || disclosureOpen?.value === false) {
    return;
  }
  void pickHostVolume({ mode });
}

function handleAddFolderModeKeydown({ event }: { event: KeyboardEvent }) {
  if (event.isComposing || event.keyCode === 229) {
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeAddFolderMode({ restoreFocus: true });
  } else if (event.key === 'Tab') {
    closeAddFolderMode({ restoreFocus: true });
  } else {
    const buttons = Array.from(addFolderModeRef.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    const index = buttons.findIndex(button => button === document.activeElement);
    const nextIndex = event.key === 'ArrowDown' ? (index + 1) % buttons.length
      : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : undefined;
    if (nextIndex !== undefined) {
      event.preventDefault();
      buttons[nextIndex]?.focus();
    }
  }
}

watch(isAddFolderModeOpen, async open => {
  if (open) {
    addFolderPopup.refresh();
    await nextTick();
    if (isAddFolderModeOpen.value) {
      addFolderPopup.refresh();
      addFolderModeRef.value?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    }
  }
});
watch([isCreating, hasFileSystemAccess, isDetecting], () => {
  if (isCreating.value || !hasFileSystemAccess.value || isDetecting.value) {
    closeAddFolderMode({ restoreFocus: false });
  }
}, { flush: 'sync' });
useEventTargetListener(document, 'focusin', event => {
  const target = event.target as Node;
  if (isAddFolderModeOpen.value && !addFolderInfoRef.value?.contains(target) && !addFolderModeRef.value?.contains(target)) {
    closeAddFolderMode({ restoreFocus: false });
  }
});

const [isCopyFolderInfoOpen, toggleCopyFolderInfo] = useToggle(false);
const copyFolderInfoRef = ref<HTMLElement | null>(null);
const copyFolderInfoTriggerRef = ref<HTMLButtonElement | null>(null);
const copyFolderInfoPanelRef = ref<HTMLElement | null>(null);
const copyFolderInfoId = useId();
const copyFolderInfoHeadingId = useId();
const copyFolderInfoPopup = useAnchoredPopup({ anchor: copyFolderInfoRef, preferredWidth: { unit: 'rem', value: 18 }, maxWidthPx: 360, preferredPlacement: { direction: 'top', minHeightPx: 224 } });
onClickOutside(copyFolderInfoRef, () => {
  isCopyFolderInfoOpen.value = false;
}, { ignore: [copyFolderInfoPanelRef] });
const disclosureOpen = inject<Readonly<Ref<boolean>> | undefined>('settings-disclosure-open', undefined);
const disclosureFocusReturn = inject<(() => HTMLElement | undefined) | undefined>('settings-disclosure-focus-return', undefined);

function closeFolderInfo({ kind, restoreFocus }: { kind: 'add' | 'copy', restoreFocus: boolean }) {
  switch (kind) {
  case 'add': toggleAddFolderInfo(false);
    if (restoreFocus) {
      addFolderInfoTriggerRef.value?.focus();
    }
    break;
  case 'copy': toggleCopyFolderInfo(false);
    if (restoreFocus) {
      copyFolderInfoTriggerRef.value?.focus();
    }
    break;
  default: {
    const _ex: never = kind;
    throw new Error(`Unhandled folder information: ${_ex}`);
  }
  }
}

function handleFolderInfoKeydown({ event, kind }: { event: KeyboardEvent, kind: 'add' | 'copy' }) {
  if (event.isComposing || event.keyCode === 229) {
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeFolderInfo({ kind, restoreFocus: true });
  } else if (event.key === 'Tab') {
    closeFolderInfo({ kind, restoreFocus: true });
  }
}

function copySingleFileFromUi() {
  if (isCopyFolderInfoOpen.value && !isCreating.value && hasOPFS.value && !isDetecting.value && disclosureOpen?.value !== false) {
    openFilePicker({ kind: 'file', context: captureContext() });
  }
}

watch(isAddFolderInfoOpen, async open => {
  if (open) {
    toggleAddFolderMode(false);
    toggleCopyFolderInfo(false);
    addFolderInfoPopup.refresh();
    await nextTick();
    if (isAddFolderInfoOpen.value) {
      addFolderInfoPopup.refresh();
      addFolderInfoPanelRef.value?.focus();
    }
  }
});
watch(isCopyFolderInfoOpen, async open => {
  if (open) {
    toggleAddFolderMode(false);
    toggleAddFolderInfo(false);
    copyFolderInfoPopup.refresh();
    await nextTick();
    if (isCopyFolderInfoOpen.value) {
      copyFolderInfoPopup.refresh();
      (copyFolderInfoPanelRef.value?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? copyFolderInfoPanelRef.value)?.focus();
    }
  }
});
useEventTargetListener(document, 'focusin', event => {
  const target = event.target as Node;
  if (isAddFolderInfoOpen.value && !addFolderInfoRef.value?.contains(target) && !addFolderInfoPanelRef.value?.contains(target)) {
    closeFolderInfo({ kind: 'add', restoreFocus: false });
  }
  if (isCopyFolderInfoOpen.value && !copyFolderInfoRef.value?.contains(target) && !copyFolderInfoPanelRef.value?.contains(target)) {
    closeFolderInfo({ kind: 'copy', restoreFocus: false });
  }
});
watch(() => disclosureOpen?.value, open => {
  if (open === false) {
    if (document.activeElement instanceof Node && [addFolderModeRef.value, addFolderInfoPanelRef.value, copyFolderInfoPanelRef.value].some(panel => panel?.contains(document.activeElement))) {
      disclosureFocusReturn?.()?.focus();
    }
    toggleAddFolderMode(false);
    toggleAddFolderInfo(false);
    toggleCopyFolderInfo(false);
  }
});

const fileInput = ref<HTMLInputElement | null>(null);
const fileInputSingle = ref<HTMLInputElement | null>(null);

// Drag-drop state (only used when dragOverlayTarget is set)
const dragCounter = ref(0);
const isDragOver = computed(() => dragCounter.value > 0);

type CreationContext = { owner: string | undefined, paths: string[], prefix: string, complete: typeof props.completeCreation };

function captureContext(): CreationContext {
  return { owner: props.operationContext, paths: [...props.existingMountPaths], prefix: props.mountPathPrefix, complete: props.completeCreation };
}

const filePickerContext = ref<CreationContext | undefined>(undefined);
const activeContext = ref<CreationContext | undefined>(undefined);
const showProgress = computed(() => isCreating.value && activeContext.value?.owner === props.operationContext);
watch(() => props.operationContext, () => {
  if (document.activeElement instanceof Node && addFolderModeRef.value?.contains(document.activeElement)) {
    addFolderTriggerRef.value?.focus();
  } else if (document.activeElement instanceof Node && addFolderInfoPanelRef.value?.contains(document.activeElement)) {
    addFolderInfoTriggerRef.value?.focus();
  } else if (document.activeElement instanceof Node && copyFolderInfoPanelRef.value?.contains(document.activeElement)) {
    copyFolderInfoTriggerRef.value?.focus();
  }
  toggleAddFolderMode(false);
  toggleAddFolderInfo(false);
  toggleCopyFolderInfo(false);
});

function showToast({ context, message }: { context: CreationContext, message: string }) {
  if (mounted && context.owner === props.operationContext) {
    addToast({ message });
  }
}

function beginCreation({ context }: { context: CreationContext }): boolean {
  if (isCreating.value) {
    return false;
  }
  activeContext.value = context;
  isCreating.value = true;
  copyingLabel.value = undefined;
  creationKind.value = 'copy';
  emit('operation-state', { operationContext: context.owner, pending: true });
  return true;
}

function finishCreation({ context }: { context: CreationContext }) {
  isCreating.value = false;
  progress.value = null;
  copyAbortController.value = null;
  activeContext.value = undefined;
  emit('operation-state', { operationContext: context.owner, pending: false });
}

function openFilePicker({ kind, context }: { kind: 'directory' | 'file', context: CreationContext }) {
  if (isCreating.value) {
    return;
  }
  filePickerContext.value = context;
  switch (kind) {
  case 'directory': fileInput.value?.click();
    break;
  case 'file': fileInputSingle.value?.click();
    toggleCopyFolderInfo(false);
    break;
  default: {
    const _ex: never = kind;
    throw new Error(`Unhandled file picker: ${_ex}`);
  }
  }
}

function generateSuggestedPath({ baseName, context }: { baseName: string, context: CreationContext }): string {
  const sanitized = baseName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  // Unscoped callers retain their live conflict checks; scoped operations must
  // never read the next owner's prefix or paths after a picker has yielded.
  const prefix = context.owner === undefined ? props.mountPathPrefix : context.prefix;
  const existingPaths = context.owner === undefined ? props.existingMountPaths : context.paths;
  let path = `${prefix}${sanitized}`;
  let suffix = 2;
  const basePath = path;
  while (existingPaths.includes(path)) {
    path = `${basePath}-${suffix}`;
    suffix++;
  }
  return path;
}

async function completeCreatedVolume({ volumeId, name, readOnly, context }: { volumeId: VolumeId, name: string, readOnly: boolean, context: CreationContext }) {
  const creation: CreatedVolumeMount = { volumeId, mountPath: generateSuggestedPath({ baseName: name, context }), readOnly, operationContext: context.owner };
  if (context.complete) {
    await context.complete(creation);
  } else {
    emit('created', creation);
  }
}

function fileListToEntries({ files }: { files: FileList }): Array<{ file: File, relativePath: string }> {
  const result: Array<{ file: File, relativePath: string }> = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) {
      continue;
    }
    const parts = file.webkitRelativePath.split('/');
    const relativePath = parts.length > 1 ? parts.slice(1).join('/') : file.name;
    result.push({ file, relativePath });
  }
  return result;
}

async function readDirectoryEntries({ entry, basePath }: { entry: FileSystemDirectoryEntry, basePath: string }): Promise<Array<{ file: File, relativePath: string }>> {
  const result: Array<{ file: File, relativePath: string }> = [];
  const reader = entry.createReader();

  await new Promise<void>((resolve, reject) => {
    function readBatch() {
      reader.readEntries(async (batch) => {
        try {
          if (batch.length === 0) {
            resolve();
            return;
          }
          for (const child of batch) {
            if (child.isFile) {
              const file = await new Promise<File>((res, rej) => (child as FileSystemFileEntry).file(res, rej));
              result.push({ file, relativePath: `${basePath}/${file.name}` });
            } else if (child.isDirectory) {
              const nested = await readDirectoryEntries({ entry: child as FileSystemDirectoryEntry, basePath: `${basePath}/${child.name}` });
              result.push(...nested);
            }
          }
          readBatch();
        } catch (cause: unknown) {
          reject(cause);
        }
      }, reject);
    }
    readBatch();
  });

  return result;
}

async function startCopyAndEmit({ name, entries, label, readOnly, context }: {
  name: string,
  entries: Array<{ file: File, relativePath: string }>,
  label: string,
  readOnly: boolean,
  context: CreationContext,
}) {
  const controller = new AbortController();
  copyAbortController.value = controller;
  copyingLabel.value = label;
  progress.value = null;
  const vol = await storageService.createVolumeFromFiles({
    name,
    entries,
    signal: controller.signal,
    onProgress: ({ processed, total }) => {
      progress.value = { processed, total };
    },
  });
  await completeCreatedVolume({ volumeId: vol.id, name, readOnly, context });
  return vol;
}

async function handleFileSelect({ event }: { event: Event }) {
  const context = filePickerContext.value ?? (props.operationContext === undefined ? captureContext() : undefined);
  if (!context) {
    return;
  }
  const target = event.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) {
    filePickerContext.value = undefined;
    return;
  }

  if (!beginCreation({ context })) {
    return;
  }
  try {
    const folderName = target.files[0]?.webkitRelativePath.split('/')[0] || await ensureStrings.volumes__imported_folder();
    const entries = fileListToEntries({ files: target.files });
    await startCopyAndEmit({ name: folderName, entries, label: await ensureStrings.volumes__copying_folder_to_browser(), readOnly: true, context });
    showToast({ context, message: await ensureStrings.volumes__folder_added_to_your_folders({ name: folderName }) });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      return;
    }
    console.error('Failed to import volume:', e);
    showToast({ context, message: await ensureStrings.volumes__failed_to_copy_folder({ errorMessage: (e as Error).message }) });
  } finally {
    finishCreation({ context });
    filePickerContext.value = undefined;
    if (fileInput.value) {
      fileInput.value.value = '';
    }
  }
}

async function handleSingleFileSelect({ event }: { event: Event }) {
  const context = filePickerContext.value ?? (props.operationContext === undefined ? captureContext() : undefined);
  if (!context) {
    return;
  }
  const target = event.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) {
    filePickerContext.value = undefined;
    return;
  }
  const file = target.files[0];
  if (!file) {
    return;
  }

  if (!beginCreation({ context })) {
    return;
  }
  const entries = [{ file, relativePath: file.name }];
  try {
    await startCopyAndEmit({ name: file.name, entries, label: await ensureStrings.volumes__copying_file_to_browser(), readOnly: true, context });
    showToast({ context, message: await ensureStrings.volumes__file_copied_to_your_folders({ name: file.name }) });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      return;
    }
    console.error('Failed to copy file:', e);
    showToast({ context, message: await ensureStrings.volumes__failed_to_copy_file({ errorMessage: (e as Error).message }) });
  } finally {
    finishCreation({ context });
    filePickerContext.value = undefined;
    if (fileInputSingle.value) {
      fileInputSingle.value.value = '';
    }
  }
}

async function handleDrop({ event }: { event: DragEvent }) {
  const context = captureContext();
  if (isCreating.value) {
    return;
  }
  event.preventDefault();

  const items = Array.from(event.dataTransfer?.items ?? []).filter(i => i.kind === 'file');
  if (items.length === 0) {
    return;
  }

  const fsEntries = items.map(i => i.webkitGetAsEntry()).filter(Boolean) as FileSystemEntry[];
  if (fsEntries.length === 0) {
    return;
  }

  if (!beginCreation({ context })) {
    return;
  }
  try {
    if (fsEntries.length === 1 && fsEntries[0]!.isDirectory) {
      const dirEntry = fsEntries[0] as FileSystemDirectoryEntry;
      const folderName = dirEntry.name;
      try {
        const entries = await readDirectoryEntries({ entry: dirEntry, basePath: '' });
        const normalized = entries.map(e => ({ file: e.file, relativePath: e.relativePath.replace(/^\//, '') }));
        await startCopyAndEmit({ name: folderName, entries: normalized, label: await ensureStrings.volumes__copying_folder_to_browser(), readOnly: true, context });
        showToast({ context, message: await ensureStrings.volumes__folder_added_to_your_folders({ name: folderName }) });
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          return;
        }
        showToast({ context, message: await ensureStrings.volumes__failed_to_copy_folder({ errorMessage: (e as Error).message }) });
      }
      return;
    }

    if (fsEntries.length === 1 && fsEntries[0]!.isFile) {
      const fileEntry = fsEntries[0] as FileSystemFileEntry;
      try {
        const file = await new Promise<File>((res, rej) => fileEntry.file(res, rej));
        await startCopyAndEmit({ name: file.name, entries: [{ file, relativePath: file.name }], label: await ensureStrings.volumes__copying_file_to_browser(), readOnly: true, context });
        showToast({ context, message: await ensureStrings.volumes__file_copied_to_your_folders({ name: file.name }) });
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          return;
        }
        showToast({ context, message: await ensureStrings.volumes__failed_to_copy_file({ errorMessage: (e as Error).message }) });
      }
      return;
    }

    const folderName = fsEntries[0]!.name;
    try {
      const allEntries: Array<{ file: File, relativePath: string }> = [];
      for (const entry of fsEntries) {
        if (entry.isFile) {
          const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
          allEntries.push({ file, relativePath: file.name });
        } else if (entry.isDirectory) {
          const nested = await readDirectoryEntries({ entry: entry as FileSystemDirectoryEntry, basePath: entry.name });
          allEntries.push(...nested.map(e => ({ file: e.file, relativePath: e.relativePath.replace(/^\//, '') })));
        }
      }
      await startCopyAndEmit({ name: folderName, entries: allEntries, label: await ensureStrings.volumes__copying_folder_to_browser(), readOnly: true, context });
      showToast({ context, message: await ensureStrings.volumes__folder_added_to_your_folders({ name: folderName }) });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        return;
      }
      showToast({ context, message: await ensureStrings.volumes__failed_to_copy({ errorMessage: (e as Error).message }) });
    }
  } finally {
    finishCreation({ context });
  }
}

async function pickHostVolume({ mode }: { mode: 'read' | 'readwrite' }) {
  const context = captureContext();
  if (!beginCreation({ context })) {
    return;
  }
  creationKind.value = 'host';
  toggleAddFolderMode(false);
  try {
    // @ts-expect-error: File System Access API
    const handle = await window.showDirectoryPicker({ mode }) as FileSystemDirectoryHandle;
    const name = handle.name;
    const vol = await storageService.createVolume({ name, type: 'host', sourceHandle: handle });
    await completeCreatedVolume({ volumeId: vol.id, name, readOnly: mode === 'read', context });
    showToast({ context, message: await ensureStrings.volumes__folder_added_to_your_folders({ name }) });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      return;
    }
    showToast({ context, message: await ensureStrings.volumes__failed_to_add_folder_with_error({ errorMessage: (e as Error).message }) });
  } finally {
    finishCreation({ context });
  }
}

async function createVolume({ type }: { type: 'opfs' | 'host' }) {
  if (isCreating.value) {
    return;
  }
  const context = captureContext();
  switch (type) {
  case 'host': {
    // @ts-expect-error: File System Access API
    if (!window.showDirectoryPicker) {
      showToast({ context, message: await ensureStrings.volumes__linking_external_folders_not_supported() });
      return;
    }
    toggleAddFolderMode(true);
    break;
  }
  case 'opfs': {
    if (!beginCreation({ context })) {
      return;
    }
    let useDirectoryInput = false;
    try {
      if (!await checkOPFSSupport()) {
        showToast({ context, message: await ensureStrings.volumes__opfs_not_supported() });
        return;
      }
      // @ts-expect-error: File System Access API
      if (window.showDirectoryPicker) {
        // @ts-expect-error: File System Access API
        const handle = await window.showDirectoryPicker({ mode: 'read' }) as FileSystemDirectoryHandle;
        const name = handle.name;
        copyingLabel.value = await ensureStrings.volumes__copying_folder_to_browser();
        const vol = await storageService.createVolume({ name, type: 'opfs', sourceHandle: handle });
        await completeCreatedVolume({ volumeId: vol.id, name, readOnly: true, context });
        showToast({ context, message: await ensureStrings.volumes__file_copied_to_your_folders({ name }) });
      } else {
        useDirectoryInput = true;
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        return;
      }
      showToast({ context, message: await ensureStrings.volumes__failed_to_copy_folder({ errorMessage: (e as Error).message }) });
    } finally {
      finishCreation({ context });
    }
    if (useDirectoryInput) {
      openFilePicker({ kind: 'directory', context });
    }
    break;
  }
  default: {
    const _exhaustive: never = type;
    throw new Error(`Unhandled volume type: ${_exhaustive}`);
  }
  }
}

function onDocDragEnter() {
  dragCounter.value++;
}

function onDocDragLeave() {
  dragCounter.value = Math.max(0, dragCounter.value - 1);
}

function onDocDragOver({ event }: { event: DragEvent }) {
  event.preventDefault();
}

function onDocDrop({ event }: { event: DragEvent }) {
  event.preventDefault();
  dragCounter.value = 0;
  handleDrop({ event });
}

const handleDocumentDragOver: EventListener = (event) => {
  onDocDragOver({ event: event as DragEvent });
};

const handleDocumentDrop: EventListener = (event) => {
  onDocDrop({ event: event as DragEvent });
};

onMounted(async () => {
  hasFileSystemAccess.value = checkFileSystemAccessSupport();
  hasOPFS.value = await checkOPFSSupport();
  if (!mounted) {
    return;
  }
  isDetecting.value = false;

  if (props.dragOverlayTarget) {
    document.addEventListener('dragenter', onDocDragEnter);
    document.addEventListener('dragleave', onDocDragLeave);
    document.addEventListener('dragover', handleDocumentDragOver);
    document.addEventListener('drop', handleDocumentDrop);
  }
});

onUnmounted(() => {
  mounted = false;
  if (props.dragOverlayTarget) {
    document.removeEventListener('dragenter', onDocDragEnter);
    document.removeEventListener('dragleave', onDocDragLeave);
    document.removeEventListener('dragover', handleDocumentDragOver);
    document.removeEventListener('drop', handleDocumentDrop);
  }
});


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="space-y-3">
    <!-- Drag-over overlay -->
    <Teleport v-if="dragOverlayTarget && isDragOver" :to="dragOverlayTarget ?? 'body'">
      <div
        data-testid="drag-overlay"
        tw-class="pointer-events-none absolute inset-0 z-[200] bg-blue-500/10 dark:bg-blue-400/10 backdrop-blur-[2px] flex items-center justify-center"
      >
        <div tw-class="flex flex-col items-center gap-4 border-2 border-dashed border-blue-400 dark:border-blue-400 rounded-3xl px-16 py-14 bg-white/80 dark:bg-gray-900/80 shadow-2xl text-blue-600 dark:text-blue-300">
          <FolderDownIcon tw-class="w-14 h-14" />
          <div tw-class="text-center">
            <p tw-class="text-xl font-bold">{{ lazyStrings.volumes__drop_to_copy_to_browser() }}</p>
            <p tw-class="text-sm font-medium text-blue-500/80 dark:text-blue-400/70 mt-1">{{ lazyStrings.volumes__folder_or_file() }}</p>
          </div>
        </div>
      </div>
    </Teleport>

    <input type="file" ref="fileInput" webkitdirectory directory multiple tw-class="hidden" data-testid="copy-directory-input" @cancel="filePickerContext = undefined" @change="handleFileSelect({ event: $event })" />
    <input type="file" ref="fileInputSingle" tw-class="hidden" data-testid="copy-file-input" @cancel="filePickerContext = undefined" @change="handleSingleFileSelect({ event: $event })" />

    <!-- Buttons row -->
    <div v-if="!isFullyUnsupported" data-testid="volume-creator-actions" tw-class="flex items-center gap-2 flex-wrap">
      <!-- Add Folder button -->
      <div tw-class="relative" ref="addFolderInfoRef">
        <button
          v-if="isDetecting || hasFileSystemAccess"
          ref="addFolderTriggerRef"
          type="button"
          data-testid="add-folder-btn"
          aria-haspopup="menu"
          :aria-expanded="isAddFolderModeOpen"
          :aria-controls="isAddFolderModeOpen ? addFolderModeId : undefined"
          @click="toggleAddFolderModeFromUi"
          @keydown.down.prevent="isAddFolderModeOpen || toggleAddFolderModeFromUi()"
          @keydown.up.prevent="isAddFolderModeOpen || toggleAddFolderModeFromUi()"
          :disabled="isCreating || !hasFileSystemAccess || isDetecting"
          :tw-class="['inline-flex h-9 items-center gap-2 px-3 text-xs font-medium rounded-lg border transition-colors disabled:cursor-not-allowed disabled:text-slate-400 dark:disabled:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40', isAddFolderModeOpen
            ? 'border-blue-400/60 bg-blue-50/60 text-slate-800 dark:border-blue-500/50 dark:bg-blue-500/10 dark:text-slate-100'
            : 'border-slate-200 bg-white text-slate-700 enabled:hover:bg-slate-50 dark:border-slate-700/70 dark:bg-slate-800/45 dark:text-slate-200 dark:enabled:hover:bg-slate-800']"
        >
          <FolderPlusIcon aria-hidden="true" :tw-class="['w-4 h-4 shrink-0', hasFileSystemAccess && !isDetecting ? 'text-blue-500 dark:text-blue-400' : 'text-slate-400 dark:text-slate-500']" />
          {{ lazyStrings.volumes__add_folder() }}
          <ChevronDownIcon aria-hidden="true" :tw-class="['ml-0.5 w-3.5 h-3.5 shrink-0 text-slate-400 transition-transform duration-200', isAddFolderModeOpen && 'rotate-180']" />
        </button>
        <div
          v-else
          tw-class="flex h-9 items-stretch overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-700/70 dark:bg-slate-800/45"
        >
          <button type="button" disabled tw-class="flex h-full items-center gap-2 px-3 text-xs font-medium text-slate-400 dark:text-slate-500 cursor-not-allowed">
            <FolderPlusIcon aria-hidden="true" tw-class="w-4 h-4 shrink-0" />
            {{ lazyStrings.volumes__add_folder() }}
          </button>
          <button
            ref="addFolderInfoTriggerRef"
            type="button"
            data-testid="add-folder-info-btn"
            aria-haspopup="dialog"
            :aria-expanded="isAddFolderInfoOpen"
            :aria-controls="isAddFolderInfoOpen ? addFolderInfoId : undefined"
            @click="toggleAddFolderInfo()"
            :tw-class="['flex w-8 items-center justify-center border-l border-slate-200 transition-colors hover:bg-slate-50 dark:border-slate-700/70 dark:hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40', isAddFolderInfoOpen ? 'text-blue-500 dark:text-blue-400' : 'text-slate-400 hover:text-blue-500 dark:hover:text-blue-400']"
            :title="lazyStrings.volumes__why_add_folder_disabled()"
          >
            <InfoIcon tw-class="w-3.5 h-3.5" />
          </button>
        </div>
        <!-- Mode selector popover -->
        <Teleport to="body">
          <Transition name="volume-mode-menu" @before-leave="element => deactivateFolderPopup({ element })">
            <div
              v-if="isAddFolderModeOpen"
              ref="addFolderModeRef"
              :id="addFolderModeId"
              data-testid="add-folder-mode-panel"
              role="menu"
              :aria-labelledby="addFolderModeHeadingId"
              :aria-hidden="!isAddFolderModeOpen"
              :inert="!isAddFolderModeOpen"
              :style="addFolderPopup.placement.value.style"
              :data-placement="addFolderPopup.placement.value.direction"
              tw-class="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-700/70 rounded-xl shadow-xl shadow-slate-950/15 overflow-y-auto overscroll-contain"
              @keydown="handleAddFolderModeKeydown({ event: $event })"
            >
              <p :id="addFolderModeHeadingId" tw-class="px-3.5 pt-3 pb-0.5 text-xs font-medium text-slate-600 dark:text-slate-300">{{ lazyStrings.volumes__choose_access_level() }}</p>
              <p tw-class="px-3.5 pb-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">{{ lazyStrings.volumes__change_access_later() }}</p>
              <button
                type="button"
                role="menuitem"
                :disabled="!isAddFolderModeOpen || isCreating"
                data-testid="add-folder-read-only-btn"
                @click="chooseAddFolderMode({ mode: 'read' })"
                tw-class="w-full flex items-start gap-3 px-3.5 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/60 transition-colors text-left"
              >
                <LockIcon aria-hidden="true" tw-class="w-4 h-4 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <div tw-class="min-w-0">
                  <p tw-class="text-xs font-medium text-slate-800 dark:text-slate-100">{{ lazyStrings.volumes__read_only() }}</p>
                  <p tw-class="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">{{ lazyStrings.volumes__ai_can_read_not_write() }}</p>
                </div>
              </button>
              <button
                type="button"
                role="menuitem"
                :disabled="!isAddFolderModeOpen || isCreating"
                data-testid="add-folder-readwrite-btn"
                @click="chooseAddFolderMode({ mode: 'readwrite' })"
                tw-class="w-full flex items-start gap-3 px-3.5 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/60 transition-colors text-left border-t border-slate-100 dark:border-slate-800"
              >
                <PencilIcon aria-hidden="true" tw-class="w-4 h-4 mt-0.5 shrink-0 text-blue-500 dark:text-blue-400" />
                <div tw-class="min-w-0">
                  <p tw-class="text-xs font-medium text-slate-800 dark:text-slate-100">{{ lazyStrings.volumes__read_write() }}</p>
                  <p tw-class="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">{{ lazyStrings.volumes__ai_can_read_and_modify_files() }}</p>
                </div>
              </button>
            </div>
          </Transition>
        </Teleport>
        <!-- Info popover (when unavailable) -->
        <Teleport to="body">
          <Transition name="volume-mode-menu" @before-leave="element => deactivateFolderPopup({ element })">
            <div
              v-if="isAddFolderInfoOpen"
              ref="addFolderInfoPanelRef"
              :id="addFolderInfoId"
              data-testid="add-folder-info-panel"
              role="dialog"
              tabindex="-1"
              :aria-labelledby="addFolderInfoHeadingId"
              :aria-hidden="!isAddFolderInfoOpen"
              :inert="!isAddFolderInfoOpen"
              :style="addFolderInfoPopup.placement.value.style"
              :data-placement="addFolderInfoPopup.placement.value.direction"
              @keydown="handleFolderInfoKeydown({ event: $event, kind: 'add' })"
              tw-class="overflow-y-auto overscroll-contain rounded-xl border border-slate-200/80 bg-white p-3.5 shadow-xl shadow-slate-950/15 space-y-2 outline-none dark:border-slate-700/70 dark:bg-slate-900"
            >
              <p :id="addFolderInfoHeadingId" tw-class="text-xs font-medium text-blue-600 dark:text-blue-300">{{ lazyStrings.volumes__add_folder_requires_chromium() }}</p>
              <p tw-class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                {{ lazyStrings.volumes__chromium_browser_over_https() }}
              </p>
            </div>
          </Transition>
        </Teleport>
      </div>

      <!-- Copy Folder button -->
      <div tw-class="relative" ref="copyFolderInfoRef">
        <div
          tw-class="flex h-9 items-stretch overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-700/70 dark:bg-slate-800/45"
        >
          <button
            type="button"
            data-testid="copy-folder-btn"
            @click="createVolume({ type: 'opfs' })"
            :disabled="isCreating || !hasOPFS || isDetecting"
            tw-class="flex h-full items-center gap-2 px-3 text-xs font-medium text-slate-700 dark:text-slate-200 enabled:hover:bg-slate-50 dark:enabled:hover:bg-slate-800 disabled:cursor-not-allowed disabled:text-slate-400 dark:disabled:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 transition-colors"
          >
            <FolderDownIcon aria-hidden="true" :tw-class="['w-4 h-4 shrink-0', hasOPFS && !isDetecting ? 'text-blue-500 dark:text-blue-400' : 'text-slate-400 dark:text-slate-500']" />
            {{ lazyStrings.volumes__copy_folder() }}
          </button>
          <button
            ref="copyFolderInfoTriggerRef"
            type="button"
            data-testid="copy-folder-info-btn"
            aria-haspopup="dialog"
            :aria-expanded="isCopyFolderInfoOpen"
            :aria-controls="isCopyFolderInfoOpen ? copyFolderInfoId : undefined"
            @click="toggleCopyFolderInfo()"
            :tw-class="['flex w-8 items-center justify-center border-l border-slate-200 transition-colors hover:bg-slate-50 dark:border-slate-700/70 dark:hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40', isCopyFolderInfoOpen ? 'text-blue-500 dark:text-blue-400' : 'text-slate-400 hover:text-blue-500 dark:hover:text-blue-400']"
            :title="lazyStrings.volumes__what_is_copy_folder()"
          >
            <InfoIcon tw-class="w-3.5 h-3.5" />
          </button>
        </div>
        <Teleport to="body">
          <Transition name="volume-mode-menu" @before-leave="element => deactivateFolderPopup({ element })">
            <div
              v-if="isCopyFolderInfoOpen"
              ref="copyFolderInfoPanelRef"
              :id="copyFolderInfoId"
              data-testid="copy-folder-info-panel"
              role="dialog"
              tabindex="-1"
              :aria-labelledby="copyFolderInfoHeadingId"
              :aria-hidden="!isCopyFolderInfoOpen"
              :inert="!isCopyFolderInfoOpen"
              :style="copyFolderInfoPopup.placement.value.style"
              :data-placement="copyFolderInfoPopup.placement.value.direction"
              @keydown="handleFolderInfoKeydown({ event: $event, kind: 'copy' })"
              tw-class="overflow-y-auto overscroll-contain rounded-xl border border-slate-200/80 bg-white p-3.5 shadow-xl shadow-slate-950/15 space-y-2 outline-none dark:border-slate-700/70 dark:bg-slate-900"
            >
              <p :id="copyFolderInfoHeadingId" tw-class="text-xs font-medium text-blue-600 dark:text-blue-300">{{ lazyStrings.volumes__original_folder_is_never_touched() }}</p>
              <p tw-class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                {{ lazyStrings.volumes__copy_does_not_change_disk_files() }}
              </p>
              <p tw-class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed pt-2 border-t border-slate-100 dark:border-slate-800">
                {{ lazyStrings.volumes__copy_is_stored_in_browser_opfs() }}
              </p>
              <div v-if="hasOPFS && !isDetecting" tw-class="pt-2 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  @click="copySingleFileFromUi"
                  :disabled="isCreating"
                  data-testid="copy-single-file-btn"
                  tw-class="flex min-h-8 items-center gap-1.5 rounded-md text-xs text-blue-600 dark:text-blue-300 hover:text-blue-700 dark:hover:text-blue-200 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FileDownIcon tw-class="w-3 h-3" />
                  {{ lazyStrings.volumes__copy_single_file_instead() }}
                </button>
              </div>
              <p v-if="!hasOPFS && !isDetecting" tw-class="text-[11px] text-amber-600 dark:text-amber-400 font-medium pt-1">
                {{ lazyStrings.volumes__not_supported_in_browser_or_context() }}
              </p>
            </div>
          </Transition>
        </Teleport>
      </div>
    </div>

    <!-- Creation progress -->
    <div v-if="showProgress" data-testid="copy-progress" tw-class="space-y-1.5 pt-1">
      <div tw-class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div tw-class="flex min-w-0 flex-1 basis-48 items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200">
          <FolderDownIcon aria-hidden="true" tw-class="w-4 h-4 shrink-0 text-blue-500 dark:text-blue-400" />
          <span :id="progressLabelId" role="status" tw-class="min-w-0 break-words">{{ progressLabel }}</span>
        </div>
        <div v-if="progressDisplay || copyAbortController" tw-class="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          <span v-if="progressDisplay" data-testid="copy-progress-count" tw-class="text-xs text-slate-600 dark:text-slate-300 tabular-nums">
            {{ lazyStrings.volumes__file_progress({ processed: progressDisplay.processed, total: progressDisplay.total }) }}
          </span>
          <button
            v-if="copyAbortController"
            type="button"
            data-testid="copy-cancel-btn"
            @click="copyAbortController?.abort()"
            tw-class="min-h-8 px-2 rounded-md text-xs font-medium text-slate-500 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-700/50 hover:text-slate-800 dark:hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 transition-colors"
          >
            {{ lazyStrings.volumes__cancel() }}
          </button>
        </div>
      </div>
      <div
        role="progressbar"
        data-testid="copy-progressbar"
        :aria-labelledby="progressLabelId"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="progressDisplay?.percentage"
        :aria-valuetext="progressDisplay ? lazyStrings.volumes__file_progress({ processed: progressDisplay.processed, total: progressDisplay.total }) : undefined"
        tw-class="h-1 w-full rounded-full overflow-hidden bg-slate-200 dark:bg-slate-700/70"
      >
        <div
          data-testid="copy-progress-fill"
          class="volume-copy-progress-fill"
          :class="{ 'volume-copy-progress-indeterminate': !progressDisplay }"
          tw-class="h-full rounded-full bg-blue-500 dark:bg-blue-400"
          :style="progressDisplay ? { width: `${progressDisplay.percentage}%` } : undefined"
        ></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.volume-mode-menu-enter-active,
.volume-mode-menu-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
}

.volume-mode-menu-leave-active {
  pointer-events: none;
}

.volume-mode-menu-enter-from,
.volume-mode-menu-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.volume-mode-menu-enter-from[data-placement='top'],
.volume-mode-menu-leave-to[data-placement='top'] {
  transform: translateY(4px);
}

.volume-copy-progress-fill {
  transition: width 200ms ease;
}

.volume-copy-progress-indeterminate {
  width: 36%;
  animation: volume-copy-progress 1.6s ease-in-out infinite;
}

@keyframes volume-copy-progress {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(280%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .volume-mode-menu-enter-active,
  .volume-mode-menu-leave-active {
    transition: none;
  }

  .volume-copy-progress-fill {
    transition: none;
  }

  .volume-copy-progress-indeterminate {
    animation: none;
    margin-inline: auto;
  }
}
</style>
