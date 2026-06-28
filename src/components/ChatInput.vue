<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed, toRaw, onUnmounted } from 'vue';
import { useLayout } from '@/composables/useLayout';
import { generateId, generateOpaqueId } from '@/utils/id';
import { naturalSort } from '@/utils/string';
import ModelSelector from './ModelSelector.vue';
import ChatToolsMenu from './ChatToolsMenu.vue';
import ChatAttachMenu from './ChatAttachMenu.vue';
import { useChatTools } from '@/composables/useChatTools';
import { useChatWeshPreferences } from '@/composables/useChatWeshPreferences';
import { useChatConversation } from '@/composables/chat/useChatConversation';
import { useChatDraft } from '@/composables/useChatDraft';
import { useChatImageGeneration } from '@/composables/chat/useChatImageGeneration';
import { useChatModels } from '@/composables/chat/useChatModels';
import { useChatMounts } from '@/composables/chat/useChatMounts';
import { useChatMetadata } from '@/composables/chat/useChatMetadata';
import { buildWorkerMountsForChat } from '@/composables/useChatWeshTerminalSessions';
import { storageService } from '@/services/storage';
import { startVolumeExtensionScan } from '@/services/tools/wesh/volume-extension-cache';
import { checkFileSystemAccessSupport } from '@/services/storage/opfs-detection';
import { useToast } from '@/composables/useToast';
import { useConfirm } from '@/composables/useConfirm';
import { useFileExplorerModal } from '@/composables/useFileExplorerModal';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import { formatSettingsSourceLabel, type SettingsSource } from '@/utils/settings-labels';
import { lazyStrings, ensureStrings } from '@/strings';

import { defineAsyncComponentAndLoadOnMounted } from '@/utils/vue';
const ImageEditor = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./ImageEditor.vue') });
const AdvancedTextEditor = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./AdvancedTextEditorV3.vue') });

import {
  SquareIcon, Minimize2Icon, Maximize2Icon, SendIcon,
  XIcon, ImageIcon,
  ChevronDownIcon, ChevronUpIcon, Edit2Icon, FileEditIcon,
  Loader2Icon,
} from 'lucide-vue-next';
import MountBadgeList from './MountBadgeList.vue';
import type { Attachment, Chat, ChatGroup, LmParameters } from '@/models/types';
import { idToRaw, toAttachmentId, toBinaryObjectId } from '@/models/ids';
import type { AttachmentId, BinaryObjectId, ChatId, VolumeId } from '@/models/ids';

const { setToolEnabled } = useChatTools();
const { getNaidanSysfsAccessScope } = useChatWeshPreferences();
const { addToast } = useToast();
const { openFileExplorer } = useFileExplorerModal();
const { showConfirm } = useConfirm();

const { setActiveFocusArea, activeFocusArea, preferredEditorMode, setPreferredEditorMode } = useLayout();

const props = defineProps<{
  chatId: ChatId,
  chat: Chat,
  chatGroup: ChatGroup | null,
  resolvedLmParameters: LmParameters | undefined,
  inheritedModelId: string | undefined,
  inheritedModelSource: SettingsSource | undefined,
  autoSendPrompt?: string,
  visibility: 'submerged' | 'peeking' | 'active',
  aboveInputVisibility: 'visible' | 'hidden',
  isStreaming: boolean,
  canGenerateImage: boolean,
  hasImageModel: boolean,
  availableImageModels: string[],
  isAnimatingHeight: boolean,
}>();

const emit = defineEmits<{
  (e: 'auto-sent'): void,
  (e: 'sent'): void,
  (e: 'update:visibility', value: 'submerged' | 'peeking' | 'active'): void,
  (e: 'update:isAnimatingHeight', value: boolean): void,
  (e: 'scroll-to-bottom', force?: boolean): void,
}>();

const isFocused = ref(false);
const isHovered = ref(false);

const isChatStreaming = computed(() => props.isStreaming);
const chatId = computed(() => props.chatId);
const chatConversation = useChatConversation();
const chatDraft = useChatDraft();
const chatMedia = useChatImageGeneration({
  chatId,
});
const chatModels = useChatModels();
const chatMounts = useChatMounts();
const chatMetadata = useChatMetadata();
const chat = computed(() => props.chat);
const chatGroup = computed(() => props.chatGroup);
const fetchingModels = chatModels.fetchingModels;
const canGenerateImage = computed(() => props.canGenerateImage);
const hasImageModel = computed(() => props.hasImageModel);
const availableImageModels = computed(() => props.availableImageModels);

const isAnimatingHeight = computed({
  get: () => props.isAnimatingHeight,
  set: (val) => emit('update:isAnimatingHeight', val),
});

function formatLabel({ value, source }: { value: string | undefined, source: SettingsSource | undefined }) {
  return formatSettingsSourceLabel({ value, source });
}

const isImageMode = computed({
  get: () => chatMedia.isImageMode.value,
  set: () => {
    chatMedia.toggleImageMode();
  },
});

const currentResolution = computed(() => {
  return chatMedia.resolution.value;
});

function updateResolution({ width, height }: { width: number, height: number }) {
  chatMedia.updateResolution({ width, height });
}

const currentCount = computed(() => {
  return chatMedia.count.value;
});

function updateCount({ count }: { count: number }) {
  chatMedia.updateCount({ count });
}

const currentPersistAs = computed(() => {
  return chatMedia.persistAs.value;
});

function updatePersistAs({ format }: { format: 'original' | 'webp' | 'jpeg' | 'png' }) {
  chatMedia.updatePersistAs({ format });
}

const currentSteps = computed(() => {
  return chatMedia.steps.value;
});

function updateSteps({ steps }: { steps: number | undefined }) {
  chatMedia.updateSteps({ steps });
}

const currentSeed = computed(() => {
  return chatMedia.seed.value;
});

function updateSeed({ seed }: { seed: number | 'browser_random' | undefined }) {
  chatMedia.updateSeed({ seed });
}

const selectedReasoningEffort = chatMetadata.reasoningEffort({
  chatId,
});

function updateReasoningEffort({ effort }: { effort: 'none' | 'low' | 'medium' | 'high' | undefined }) {
  void chatMetadata.updateReasoningEffort({
    chatId: props.chatId,
    effort,
  });
}

const selectedImageModel = computed(() => {
  return chatMedia.selectedImageModel.value;
});

function handleUpdateImageModel({ modelId }: { modelId: string }) {
  chatMedia.setImageModel({ modelId });
}

async function fetchModels() {
  await chatModels.fetchForChat({
    chatId: props.chatId,
  });
}

function toggleImageMode() {
  isImageMode.value = !isImageMode.value;
}

const sortedAvailableModels = computed(() => naturalSort({ values: chatMedia.availableModels.value || [] }));
const chatMountList = chatMounts.getMounts({
  chatId,
});

const input = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const hasFileSystemAccess = checkFileSystemAccessSupport();

type ActiveCopy = {
  id: string,
  name: string,
  progress: { processed: number, total: number } | null,
  abort: AbortController,
};
const activeCopies = ref<ActiveCopy[]>([]);

const isMaximized = ref(false); // New state for maximize button
const isOverLimit = ref(false); // New state to show maximize button only when content is long
const isAdvancedEditorOpen = ref(false);

function openAdvancedEditor() {
  isAdvancedEditorOpen.value = true;
}

function closeAdvancedEditor() {
  isAdvancedEditorOpen.value = false;
}

function handleAdvancedEditorUpdate({ content: newContent }: { content: string }) {
  input.value = newContent;
}

function handleAdvancedEditorModeUpdate({ mode }: { mode: 'advanced' | 'textarea' }) {
  setPreferredEditorMode({ mode });
}

const attachments = ref<Attachment[]>([]);
const attachmentUrls = ref(new Map<AttachmentId, string>());

// TODO: Remove this raw mirror once we find a way to expose branded IDs from
// `defineExpose()` without triggering vue-tsc TS4023 on the generated public
// surface (`__VLS_base` using `idBrand`). Internally this component should keep
// branded IDs; only the TEST_ONLY exposed boundary is downgraded to raw strings.
type TestOnlyAttachment =
  | (Omit<Extract<Attachment, { status: 'persisted' }>, 'id' | 'binaryObjectId'> & { id: string, binaryObjectId: string })
  | (Omit<Extract<Attachment, { status: 'memory' }>, 'id' | 'binaryObjectId'> & { id: string, binaryObjectId: string })
  | (Omit<Extract<Attachment, { status: 'missing' }>, 'id' | 'binaryObjectId'> & { id: string, binaryObjectId: string });

// Image Editor integration
const editingAttachmentId = ref<AttachmentId | undefined>(undefined);
const editingAttachment = computed(() => attachments.value.find(a => a.id === editingAttachmentId.value));
const testOnlyAttachments = computed({
  get: (): TestOnlyAttachment[] => attachments.value.map(attachment => ({
    ...attachment,
    id: idToRaw({ id: attachment.id }),
    binaryObjectId: idToRaw({ id: attachment.binaryObjectId }),
  })),
  set: (value: TestOnlyAttachment[]) => {
    attachments.value = value.map(attachment => ({
      ...attachment,
      id: toAttachmentId({ raw: attachment.id }),
      binaryObjectId: toBinaryObjectId({ raw: attachment.binaryObjectId }),
    }));
  },
});
const testOnlyEditingAttachmentId = computed({
  get: () => editingAttachmentId.value === undefined ? undefined : idToRaw({ id: editingAttachmentId.value }),
  set: (value: string | undefined) => {
    editingAttachmentId.value = value === undefined ? undefined : toAttachmentId({ raw: value });
  },
});
const testOnlyEditingAttachment = computed(() => {
  if (editingAttachment.value === undefined) {
    return undefined;
  }
  return {
    ...editingAttachment.value,
    id: idToRaw({ id: editingAttachment.value.id }),
    binaryObjectId: idToRaw({ id: editingAttachment.value.binaryObjectId }),
  } satisfies TestOnlyAttachment;
});

function openImageEditor({ id }: { id: AttachmentId }) {
  editingAttachmentId.value = id;
}

function closeImageEditor() {
  editingAttachmentId.value = undefined;
}

function saveEditedImage({ blob }: { blob: Blob }) {
  if (!editingAttachment.value) return;

  const index = attachments.value.findIndex(a => a.id === editingAttachmentId.value);
  if (index !== -1) {
    const original = attachments.value[index]!;

    // Explicitly revoke old URL to ensure UI refresh
    const oldUrl = attachmentUrls.value.get(original.id);
    if (oldUrl) {
      URL.revokeObjectURL(oldUrl);
      attachmentUrls.value.delete(original.id);
    }

    // Update the attachment with the new blob and a new binary object identity
    attachments.value[index] = {
      ...original,
      binaryObjectId: generateId<BinaryObjectId>(),
      status: 'memory',
      blob,
      size: blob.size,
    };
  }
  closeImageEditor();
}

watch(attachments, (newAtts) => {
  // Revoke URLs for removed attachments
  for (const [id, url] of attachmentUrls.value) {
    if (!newAtts.some(attachment => attachment.id === id)) {
      URL.revokeObjectURL(url);
      attachmentUrls.value.delete(id);
    }
  }

  // Create or refresh URLs for new/updated attachments
  newAtts.forEach(att => {
    const status = att.status;
    switch (status) {
    case 'memory': {
      const existingUrl = attachmentUrls.value.get(att.id);
      // If we don't have a URL (newly added or just revoked in saveEditedImage), create one
      if (!existingUrl) {
        attachmentUrls.value.set(att.id, URL.createObjectURL(att.blob));
      }
      break;
    }
    case 'persisted':
    case 'missing':
      break;
    default: {
      const _ex: never = status;
      throw new Error(`Unhandled status: ${_ex}`);
    }
    }
  });
}, { deep: true });

const isMac = typeof window !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const sendShortcutText = isMac ? 'Cmd + Enter' : 'Ctrl + Enter';

async function processFiles({ files }: { files: File[] }) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;

    const attachmentId = generateId<AttachmentId>();
    const attachment: Attachment = {
      id: attachmentId,
      binaryObjectId: generateId<BinaryObjectId>(),
      originalName: file.name,
      mimeType: file.type,
      size: file.size,
      uploadedAt: Date.now(),
      status: 'memory',
      blob: file,
    };
    attachments.value.push(attachment);
  }
  nextTick(() => adjustTextareaHeight({}));
}

function generateChatMountPath({ baseName }: { baseName: string }): string {
  const existingPaths = chatMountList.value.map(m => m.mountPath);
  const sanitized = baseName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  let path = `/home/user/${sanitized}`;
  const basePath = path;
  let suffix = 2;
  while (existingPaths.includes(path)) {
    path = `${basePath}-${suffix}`;
    suffix++;
  }
  return path;
}

async function finishMount({ volumeId, name }: { volumeId: VolumeId, name: string }) {
  if (!chat.value) return;
  const mountPath = generateChatMountPath({ baseName: name });
  await chatMounts.addMount({
    chatId: props.chatId,
    mount: { type: 'volume', volumeId, mountPath, readOnly: true },
  });
  setToolEnabled({ name: 'shell_execute', enabled: true });
  void storageService.getVolumeDirectoryHandle({ volumeId }).then(handle => {
    if (handle) startVolumeExtensionScan({ volumeId, handle });
  });
}

async function attachCopyAsVolume({ entries, name }: {
  entries: Array<{ file: File, relativePath: string }>,
  name: string,
}) {
  if (!chat.value) return;
  const copyId = generateOpaqueId();
  const abort = new AbortController();
  const copy: ActiveCopy = { id: copyId, name, progress: null, abort };
  activeCopies.value = [...activeCopies.value, copy];
  try {
    const vol = await storageService.createVolumeFromFiles({
      name,
      entries,
      signal: abort.signal,
      onProgress: ({ processed, total }) => {
        activeCopies.value = activeCopies.value.map(c =>
          c.id === copyId ? { ...c, progress: { processed, total } } : c,
        );
      },
    });
    await finishMount({ volumeId: vol.id, name });
  } catch (e) {
    if ((e as Error).name !== 'AbortError') {
      addToast({ message: await ensureStrings.ChatInput__failed_to_copy({
        name,
        errorMessage: (e as Error).message,
      }) });
    }
  } finally {
    activeCopies.value = activeCopies.value.filter(c => c.id !== copyId);
  }
}

async function attachLinkAsVolume() {
  if (!chat.value) return;
  try {
    // @ts-expect-error: File System Access API
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    const vol = await storageService.createVolume({ name: handle.name, type: 'host', sourceHandle: handle });
    await finishMount({ volumeId: vol.id, name: vol.name });
  } catch (e) {
    if ((e as Error).name !== 'AbortError') {
      addToast({ message: await ensureStrings.ChatInput__failed_to_link_folder({
        errorMessage: (e as Error).message,
      }) });
    }
  }
}

// Handlers for ChatAttachMenu emits
async function onAttachFilesSelected({ files }: { files: File[] }) {
  if (files.length === 0) return;
  if (files.every(f => f.type.startsWith('image/'))) {
    await processFiles({ files });
  } else {
    const name = files.length === 1 ? files[0]!.name : `${files.length} files`;
    const entries = files.map(f => ({ file: f, relativePath: f.webkitRelativePath || f.name }));
    await attachCopyAsVolume({ entries, name });
  }
}

async function onAttachFolderCopy({ folderName, files }: { folderName: string, files: File[] }) {
  const entries = files.map(f => ({ file: f, relativePath: f.webkitRelativePath || f.name }));
  await attachCopyAsVolume({ entries, name: folderName });
}

// Collects all files from a FileSystemDirectoryEntry recursively.
// relativePath is relative to the dropped directory root (does not include the root name).
async function collectFilesFromDirectoryEntry(
  { dirEntry, prefix = '' }: { dirEntry: FileSystemDirectoryEntry, prefix?: string },
): Promise<Array<{ file: File, relativePath: string }>> {
  const reader = dirEntry.createReader();
  const allEntries: FileSystemEntry[] = [];
  // readEntries returns at most 100 items per call — must loop until empty batch
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) break;
    allEntries.push(...batch);
  }
  const results: Array<{ file: File, relativePath: string }> = [];
  for (const entry of allEntries) {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      results.push({ file, relativePath: entryPath });
    } else {
      const sub = await collectFilesFromDirectoryEntry({ dirEntry: entry as FileSystemDirectoryEntry, prefix: entryPath });
      results.push(...sub);
    }
  }
  return results;
}

// Called by the chat pane when files/directories are dropped onto the chat surface.
// Phase 1 (synchronous): collect handles/entries while DataTransfer is still valid.
// Phase 2 (async): process them — directories become host volumes (link) or OPFS copies.
async function processDropItems({ items }: { items: DataTransferItem[] }) {
  if (!chat.value) return;

  type DropCollected =
    | { kind: 'fsa-handle', promise: Promise<FileSystemHandle> }
    | { kind: 'entry', entry: FileSystemEntry }
    | { kind: 'raw-file', item: DataTransferItem };

  // Phase 1: collect synchronously (DataTransfer items expire after event handler returns)
  const collected: DropCollected[] = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    if ('getAsFileSystemHandle' in item) {
      // File System Access API (Chromium) — lets us get a real FileSystemDirectoryHandle from the drop
      collected.push({
        kind: 'fsa-handle',
        promise: (item as DataTransferItem & {
          getAsFileSystemHandle(): Promise<FileSystemHandle>,
        }).getAsFileSystemHandle(),
      });
    } else {
      const entry = item.webkitGetAsEntry();
      collected.push(entry ? { kind: 'entry', entry } : { kind: 'raw-file', item });
    }
  }

  // Phase 2: process (can be async now)
  const plainFiles: File[] = [];
  for (const c of collected) {
    switch (c.kind) {
    case 'fsa-handle': {
      const handle = await c.promise;
      switch (handle.kind) {
      case 'directory': {
        // Attach as host volume — read permission is already granted by the browser drop gesture
        const dirHandle = handle as FileSystemDirectoryHandle;
        const vol = await storageService.createVolume({ name: dirHandle.name, type: 'host', sourceHandle: dirHandle });
        await finishMount({ volumeId: vol.id, name: vol.name });
        break;
      }
      case 'file':
        plainFiles.push(await (handle as FileSystemFileHandle).getFile());
        break;
      default: {
        const _ex: never = handle.kind;
        throw new Error(`Unhandled handle kind: ${_ex}`);
      }
      }
      break;
    }
    case 'entry': {
      const { entry } = c;
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) =>
          (entry as FileSystemFileEntry).file(resolve, reject),
        );
        plainFiles.push(file);
      } else if (entry.isDirectory) {
        // Non-Chromium fallback: collect files and copy to OPFS
        const entries = await collectFilesFromDirectoryEntry({ dirEntry: entry as FileSystemDirectoryEntry });
        await attachCopyAsVolume({ entries, name: entry.name });
      }
      break;
    }
    case 'raw-file': {
      const file = c.item.getAsFile();
      if (file) plainFiles.push(file);
      break;
    }
    default: {
      const _ex: never = c;
      throw new Error(`Unhandled drop kind: ${JSON.stringify(_ex)}`);
    }
    }
  }

  if (plainFiles.length > 0) {
    await onAttachFilesSelected({ files: plainFiles });
  }
}

async function handleOpenMountExplorer({ volumeId }: { volumeId: VolumeId }): Promise<void> {
  if (!chat.value) return;
  const mounts = chatMountList.value;
  if (mounts.length === 0) return;

  const workerMounts = await buildWorkerMountsForChat({
    chatMounts: mounts,
    chatGroupMounts: chatGroup.value?.mounts,
    chatId: chat.value.id,
    chatGroupId: chat.value.groupId ?? undefined,
    naidanSysfsAccessScope: getNaidanSysfsAccessScope({ chatId: chat.value.id }),
  });

  const clickedMount = mounts.find(m => m.volumeId === volumeId);
  const initialPath = clickedMount?.mountPath.split('/').filter(Boolean);

  openFileExplorer({ options: {
    kind: 'wesh-mounts',
    title: await ensureStrings.fileExplorer__files(),
    rootName: await ensureStrings.fileExplorer__files(),
    mounts: workerMounts,
    initialPath,
  } });
}

async function handleDetachMount({ volumeId }: { volumeId: VolumeId }) {
  if (!chat.value) return;
  let volumeType: 'opfs' | 'host' | undefined;
  for await (const vol of storageService.listVolumes()) {
    if (vol.id === volumeId) {
      volumeType = vol.type; break;
    }
  }

  let title: string;
  let message: string;
  let confirmButtonText: string;
  switch (volumeType) {
  case 'host':
    title = await ensureStrings.ChatInput__unlink_folder();
    message = await ensureStrings.ChatInput__stop_using_folder();
    confirmButtonText = await ensureStrings.ChatInput__unlink();
    break;
  case 'opfs':
  case undefined:
    title = await ensureStrings.ChatInput__remove_folder();
    message = await ensureStrings.ChatInput__remove_browser_copy();
    confirmButtonText = await ensureStrings.ChatInput__remove();
    break;
  default: {
    const _ex: never = volumeType;
    throw new Error(`Unhandled volume type: ${_ex}`);
  }
  }

  const confirmed = await showConfirm({ title, message, confirmButtonText, confirmButtonVariant: 'danger' });
  if (!confirmed) return;
  await chatMounts.removeMount({
    chatId: props.chatId,
    volumeId,
  });
  if (volumeType === 'opfs' || volumeType === undefined) {
    await storageService.deleteVolume({ volumeId });
  }
}

async function handleToggleMountReadOnly({ volumeId, readOnly }: { volumeId: VolumeId, readOnly: boolean }) {
  if (!chat.value) return;

  let volumeType: 'opfs' | 'host' | undefined;
  for await (const vol of storageService.listVolumes()) {
    if (vol.id === volumeId) {
      volumeType = vol.type; break;
    }
  }

  switch (volumeType) {
  case 'host': {
    const handle = await storageService.getVolumeDirectoryHandle({ volumeId });
    if (handle && !readOnly) {
      // Enabling writes: request write permission from the browser.
      // The handle was obtained with mode:'read', so writes will fail unless explicitly upgraded.
      type FSHandleWithPermission = FileSystemDirectoryHandle & {
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this signature mirrors the File System Access API requestPermission contract.
        requestPermission(descriptor: { mode: 'readwrite' }): Promise<PermissionState>,
      };
      const result = await (handle as FSHandleWithPermission).requestPermission({ mode: 'readwrite' });
      // Note: downgrading back to read-only cannot be enforced at the browser level.
      // requestPermission({ mode: 'read' }) on a readwrite handle just returns 'granted' immediately —
      // the browser has no API to revoke a previously granted write permission.
      // The readOnly flag is therefore enforced by Wesh only when reducing from write to read.
      switch (result) {
      case 'granted':
        break;
      case 'denied':
      case 'prompt':
        return;
      default: {
        const _ex: never = result;
        throw new Error(`Unhandled permission state: ${_ex}`);
      }
      }
    }
    break;
  }
  case 'opfs':
  case undefined:
    break;
  default: {
    const _ex: never = volumeType;
    throw new Error(`Unhandled volume type: ${_ex}`);
  }
  }

  await chatMounts.updateMount({
    chatId: props.chatId,
    volumeId,
    readOnly,
  });
}

async function handlePaste({ event }: { event: ClipboardEvent }) {
  const items = event.clipboardData?.items;
  if (!items) return;

  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item?.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        files.push(file);
      }
    }
  }

  if (files.length > 0) {
    await processFiles({ files });
  }
}

function removeAttachment({ id }: { id: AttachmentId }) {
  attachments.value = attachments.value.filter(a => a.id !== id);
  nextTick(() => adjustTextareaHeight({}));
}

function applySuggestion({ text }: { text: string }) {
  input.value = text;
  nextTick(() => {
    adjustTextareaHeight({});
    focusInput();
  });
}

function adjustTextareaHeight({ force }: { force?: boolean }) {
  const shouldForce = force === true;
  if (textareaRef.value) {
    const target = textareaRef.value;

    // Temporarily reset height to auto to measure content height
    if (!isAnimatingHeight.value) {
      target.style.height = 'auto';
    }

    const currentScrollHeight = target.scrollHeight;
    const computedStyle = getComputedStyle(target);
    const lineHeight = parseFloat(computedStyle.lineHeight);
    const paddingTop = parseFloat(computedStyle.paddingTop);
    const paddingBottom = parseFloat(computedStyle.paddingBottom);
    const borderTop = parseFloat(computedStyle.borderTopWidth);
    const borderBottom = parseFloat(computedStyle.borderBottomWidth);
    const verticalPadding = paddingTop + paddingBottom + borderTop + borderBottom;

    const minHeight = lineHeight + verticalPadding;
    const maxSixLinesHeight = (lineHeight * 6) + verticalPadding;

    isOverLimit.value = currentScrollHeight > maxSixLinesHeight;

    let finalHeight: number;
    if (isMaximized.value) {
      finalHeight = window.innerHeight * 0.7;
    } else {
      finalHeight = Math.max(minHeight, Math.min(currentScrollHeight, maxSixLinesHeight));
    }

    target.style.height = finalHeight + 'px';
    target.style.overflowY = (isMaximized.value ? currentScrollHeight > finalHeight : currentScrollHeight > maxSixLinesHeight) ? 'auto' : 'hidden';

    if (!isAnimatingHeight.value) {
      nextTick(() => emit('scroll-to-bottom', shouldForce));
    }
  }
}

const handleWindowResize = () => adjustTextareaHeight({});

function toggleMaximized() {
  if (textareaRef.value) {
    // 1. Capture current height and set it explicitly to ensure transition works
    const startHeight = textareaRef.value.getBoundingClientRect().height;
    textareaRef.value.style.height = startHeight + 'px';

    // 2. Enable animation state
    isAnimatingHeight.value = true;

    // 3. Trigger state change in next frames to allow CSS transition to catch the change
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        isMaximized.value = !isMaximized.value;
        if (isMaximized.value) {
          emit('update:visibility', 'active');
        }
      });
    });

    // 4. Cleanup after animation
    setTimeout(() => {
      isAnimatingHeight.value = false;
    }, 400); // Slightly longer than 300ms transition
  }
}

function handleMouseEnter() {
  isHovered.value = true;
  switch (props.visibility) {
  case 'submerged':
    emit('update:visibility', 'peeking');
    break;
  case 'peeking':
  case 'active':
    break;
  default: {
    const _ex: never = props.visibility;
    throw new Error(`Unhandled visibility: ${_ex}`);
  }
  }
}

function handleMouseLeave() {
  isHovered.value = false;
  switch (props.visibility) {
  case 'peeking':
    emit('update:visibility', 'submerged');
    break;
  case 'submerged':
  case 'active':
    break;
  default: {
    const _ex: never = props.visibility;
    throw new Error(`Unhandled visibility: ${_ex}`);
  }
  }
}

function toggleSubmerged() {
  const current = props.visibility;
  switch (current) {
  case 'submerged':
    emit('update:visibility', 'active');
    nextTick(() => textareaRef.value?.focus());
    break;
  case 'peeking':
  case 'active':
    emit('update:visibility', 'submerged');
    isMaximized.value = false;
    textareaRef.value?.blur();
    break;
  default: {
    const _ex: never = current;
    throw new Error(`Unhandled visibility: ${_ex}`);
  }
  }
}

async function handleGenerateImage() {
  if (!chat.value || (!input.value.trim() && attachments.value.length === 0) || props.isStreaming) return;

  const prompt = input.value;
  const currentAttachments = [...attachments.value];
  const sendingChatId = chat.value.id;
  const { width, height } = currentResolution.value;
  const count = currentCount.value;
  const success = await chatMedia.sendImageRequest({
    prompt,
    width,
    height,
    count,
    steps: currentSteps.value,
    seed: currentSeed.value,
    persistAs: currentPersistAs.value,
    attachments: currentAttachments,
  });
  if (success) {
    if (chat.value?.id === sendingChatId) {
      input.value = '';
      attachments.value = [];
    }
    chatDraft.clearDraft({ chatId: sendingChatId });
    emit('sent');
    nextTick(() => adjustTextareaHeight({}));
  }
}

async function handleSend() {
  if ((!input.value.trim() && attachments.value.length === 0) || props.isStreaming) return;

  if (isImageMode.value) {
    await handleGenerateImage();
    return;
  }

  const text = input.value;
  const currentAttachments = [...attachments.value];
  const sendingChatId = chat.value?.id;

  if (isMaximized.value && textareaRef.value) {
    const startHeight = textareaRef.value.getBoundingClientRect().height;
    textareaRef.value.style.height = startHeight + 'px';
    isAnimatingHeight.value = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        isMaximized.value = false;
      });
    });
    setTimeout(() => {
      isAnimatingHeight.value = false;
    }, 400);
  } else {
    isMaximized.value = false; // Reset maximized state immediately
  }

  // Use resolvedSettings if available (correctly inherits), otherwise fallback to the chat's own parameters.
  const lmParameters = toRaw(props.resolvedLmParameters || chat.value?.lmParameters || { reasoning: { effort: undefined } });

  const success = await chatConversation.sendMessage({
    chatId: props.chatId,
    content: text,
    parentId: undefined,
    attachments: currentAttachments,
    lmParameters: lmParameters as LmParameters,
  });

  if (success) {
    if (chat.value?.id === sendingChatId) {
      input.value = '';
      attachments.value = [];
    }
    if (sendingChatId !== undefined) {
      chatDraft.clearDraft({ chatId: sendingChatId });
    }
    emit('sent');

    nextTick(() => { // Ensure textarea is cleared before adjusting height
      adjustTextareaHeight({});
    });
  }

  focusInput();
}

watch(input, () => {
  adjustTextareaHeight({});
}, { flush: 'post' }); // Ensure DOM is updated before recalculating

watch(isMaximized, () => {
  nextTick(() => {
    adjustTextareaHeight({});
  });
});

watch(
  () => chat.value?.id,
  (_newId, oldId) => {
    // Save previous draft
    if (oldId !== undefined) {
      chatDraft.saveDraft({ chatId: oldId, draft: {
        input: input.value,
        attachments: attachments.value,
        attachmentUrls: attachmentUrls.value,
      } });
    }

    const draft = chatDraft.getDraft({ chatId: props.chatId });
    input.value = draft.input;
    attachments.value = draft.attachments;
    attachmentUrls.value = draft.attachmentUrls;

    if (chat.value) {
      isMaximized.value = false;
      fetchModels();
      nextTick(() => {
        const currentVis = props.visibility;
        switch (currentVis) {
        case 'active':
          focusInput();
          break;
        case 'submerged':
        case 'peeking':
          break;
        default: {
          const _ex: never = currentVis;
          throw new Error(`Unhandled visibility: ${_ex}`);
        }
        }
        adjustTextareaHeight({});
      });
    }
  },
  { immediate: true },
);

onMounted(async () => {
  if (chat.value) {
    fetchModels();
  }

  if (props.autoSendPrompt) {
    const doAutoSend = async () => {
      await nextTick();
      input.value = props.autoSendPrompt!;
      await handleSend();
      emit('auto-sent');
    };

    if (chat.value) {
      doAutoSend();
    } else {
      const unwatch = watch(() => chat.value, (chatValue) => {
        if (chatValue) {
          unwatch();
          doAutoSend();
        }
      });
    }
  }

  nextTick(() => {
    adjustTextareaHeight({ force: false }); // Call adjustTextareaHeight on mount without forcing scroll
    if (chat.value) {
      focusInput();
    }
  });
});

useEventTargetListener(window, 'resize', handleWindowResize);

onUnmounted(() => {
  // Save final state
  chatDraft.saveDraft({ chatId: props.chatId, draft: {
    input: input.value,
    attachments: attachments.value,
    attachmentUrls: attachmentUrls.value,
  } });

  // Revoke all created URLs across all drafts to prevent leaks
  chatDraft.revokeAll();
});

function handleFocus() {
  isFocused.value = true;
  setActiveFocusArea({ area: 'chat' });
  emit('update:visibility', 'active');
}

function handleBlur() {
  isFocused.value = false;
  // We no longer automatically submerge on blur to keep it 'active'
}

function focusInput() {
  switch (activeFocusArea.value) {
  case 'sidebar':
  case 'search':
    return;
  case 'chat':
  case 'chat-group-settings':
  case 'chat-settings':
  case 'settings':
  case 'onboarding':
  case 'dialog':
  case 'none':
    break;
  default: {
    const _ex: never = activeFocusArea.value;
    throw new Error(`Unhandled focus area: ${_ex}`);
  }
  }

  const currentVis = props.visibility;
  switch (currentVis) {
  case 'submerged':
  case 'peeking':
    emit('update:visibility', 'active');
    break;
  case 'active':
    break;
  default: {
    const _ex: never = currentVis;
    throw new Error(`Unhandled visibility: ${_ex}`);
  }
  }

  if (document.activeElement !== textareaRef.value) {
    nextTick(() => {
      textareaRef.value?.focus();
    });
  }
}

defineExpose({ focus: focusInput, input, applySuggestion, isMaximized, adjustTextareaHeight, processFiles, processDropItems, formatLabel,
  TEST_ONLY: {
    attachments: testOnlyAttachments,
    editingAttachmentId: testOnlyEditingAttachmentId,
    editingAttachment: testOnlyEditingAttachment,
    openAdvancedEditor,
    handleAdvancedEditorModeUpdate,
    selectedReasoningEffort,
  } });
</script>

<template>
  <div
    v-if="chat"
    class="absolute bottom-0 left-0 right-0 p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] sm:p-3 sm:pb-[calc(0.75rem+env(safe-area-inset-bottom))] bg-transparent pointer-events-none z-30 transition-transform duration-500 ease-in-out will-change-transform"
    :class="visibility === 'submerged' ? 'translate-y-[calc(100%-32px-env(safe-area-inset-bottom))] sm:translate-y-[calc(100%-40px-env(safe-area-inset-bottom))]' : 'translate-y-0'"
  >
    <!-- Glass Zone behind the input card (Full width blur) -->
    <div class="absolute inset-0 -z-10 glass-zone-mask" :class="{ 'opacity-0': visibility === 'submerged' }"></div>

    <div
      v-if="props.aboveInputVisibility === 'visible'"
      class="mx-auto mb-2 w-full max-w-4xl pointer-events-auto"
      data-testid="chat-input-above-slot"
    >
      <slot name="above-input"></slot>
    </div>

    <div
      class="max-w-4xl mx-auto w-full pointer-events-auto relative group border border-gray-100 dark:border-gray-700 rounded-2xl bg-white dark:bg-gray-800 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-all duration-300 flex flex-col"
      :class="[
        isMaximized || isAnimatingHeight ? 'shadow-2xl ring-1 ring-black/5 dark:ring-white/10' : 'shadow-lg group-hover:shadow-xl',
        visibility === 'submerged' ? 'cursor-pointer' : ''
      ]"
      @mouseenter="handleMouseEnter"
      @mouseleave="handleMouseLeave"
      @click="visibility === 'submerged' ? handleFocus() : null"
    >
      <!-- Hit area extension: expands the interaction zone around the card to prevent jittering during transitions -->
      <div class="absolute -inset-x-4 -top-4 -bottom-16 pointer-events-auto -z-10" data-testid="hit-area-extension"></div>

      <!-- Active copy progress bars -->
      <div v-if="activeCopies.length > 0" class="px-4 pt-4 space-y-2" data-testid="copy-progress-area">
        <div
          v-for="copy in activeCopies"
          :key="copy.id"
          class="rounded-xl border border-blue-200/70 dark:border-blue-800/50 bg-blue-50/80 dark:bg-blue-950/20 overflow-hidden"
          data-testid="copy-progress"
        >
          <div class="px-3 pt-3 pb-2.5">
            <div class="flex items-center justify-between mb-2">
              <span class="flex items-center gap-1.5 text-xs font-bold text-blue-700 dark:text-blue-300">
                <Loader2Icon class="w-3.5 h-3.5 animate-spin shrink-0" />
                {{ lazyStrings.ChatInput__copying_name({ name: copy.name }) }}
              </span>
              <div class="flex items-center gap-3">
                <span v-if="copy.progress" class="text-[11px] font-semibold text-blue-500 dark:text-blue-400 tabular-nums">
                  {{ copy.progress.processed }} / {{ copy.progress.total }}
                </span>
                <button
                  @click="copy.abort.abort()"
                  class="text-[11px] font-bold text-blue-600 dark:text-blue-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                  data-testid="copy-cancel-btn"
                >
                  {{ lazyStrings.ChatInput__cancel() }}
                </button>
              </div>
            </div>
            <div class="h-1 w-full bg-blue-200/70 dark:bg-blue-800/50 rounded-full overflow-hidden">
              <div
                class="h-full bg-blue-500 dark:bg-blue-400 rounded-full transition-all duration-200"
                :style="{ width: `${copy.progress ? (copy.progress.processed / copy.progress.total) * 100 : 5}%` }"
              ></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Folder/File Mounts attached to this chat -->
      <div v-if="chatMountList.length > 0" class="px-4 pt-4" data-testid="chat-mounts-preview">
        <MountBadgeList
          :mounts="chatMountList"
          path-trim-prefix="/home/user/"
          :show-explorer="true"
          @toggle-read-only="handleToggleMountReadOnly"
          @remove="handleDetachMount"
          @open-explorer="handleOpenMountExplorer"
        />
      </div>

      <!-- Attachment Previews -->
      <div v-if="attachments.length > 0" class="flex flex-wrap gap-2 px-4 pt-4" data-testid="attachment-preview">
        <div v-for="att in attachments" :key="idToRaw({ id: att.id })" class="relative group/att">
          <div class="bg-transparency-grid rounded-lg overflow-hidden" style="--grid-size: 10px;">
            <img
              :src="attachmentUrls.get(att.id)"
              class="w-20 h-20 object-cover border border-gray-200 dark:border-gray-700"
            />
          </div>
          <div class="absolute -top-2 -right-2 flex gap-1 opacity-0 group-hover/att:opacity-100 transition-opacity z-10">
            <button
              @click="openImageEditor({ id: att.id })"
              class="p-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-full text-gray-400 hover:text-blue-500 shadow-sm transition-colors touch-visible"
              :title="lazyStrings.ChatInput__edit_image()"
            >
              <Edit2Icon class="w-3 h-3" />
            </button>
            <button
              @click="removeAttachment({ id: att.id })"
              class="p-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-full text-gray-400 hover:text-red-500 shadow-sm transition-colors touch-visible"
              :title="lazyStrings.ChatInput__remove()"
            >
              <XIcon class="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      <textarea
        ref="textareaRef"
        v-model="input"
        @input="adjustTextareaHeight({})"
        @paste="handlePaste({ event: $event })"
        @focus="handleFocus"
        @blur="handleBlur"
        @click="setActiveFocusArea({ area: 'chat' })"
        @keydown.enter.ctrl.prevent="handleSend"
        @keydown.enter.meta.prevent="handleSend"
        @keydown.esc.prevent="isChatStreaming ? chatConversation.abort({ chatId: props.chatId }) : null"
        :placeholder="lazyStrings.ChatInput__type_a_message()"
        class="w-full text-base pl-5 pr-20 pt-4 pb-2 focus:outline-none bg-transparent text-gray-800 dark:text-gray-100 resize-none min-h-[84px] transition-colors"
        :class="{ 'animate-height': isAnimatingHeight }"
        data-testid="chat-input"
      ></textarea>

      <!-- Control Buttons inside input area -->
      <div class="absolute right-3 top-3 flex flex-col items-center gap-1.5 z-20">
        <button
          v-if="isOverLimit || isMaximized"
          @click.stop="toggleMaximized"
          class="p-1 rounded-xl text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50/50 dark:hover:bg-gray-700/50 transition-colors"
          :title="isMaximized ? lazyStrings.ChatInput__minimize_input() : lazyStrings.ChatInput__maximize_input()"
          data-testid="maximize-button"
        >
          <Minimize2Icon v-if="isMaximized" class="w-4 h-4" />
          <Maximize2Icon v-else class="w-4 h-4" />
        </button>

        <button
          @click.stop="toggleSubmerged"
          class="p-1 rounded-xl text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50/50 dark:hover:bg-gray-700/50 transition-colors"
          :title="visibility === 'submerged' ? lazyStrings.ChatInput__show_input() : lazyStrings.ChatInput__hide_input()"
          data-testid="submerge-button"
        >
          <ChevronUpIcon v-if="visibility === 'submerged'" class="w-4 h-4" />
          <ChevronDownIcon v-else class="w-4 h-4" />
        </button>

        <button
          @click.stop="openAdvancedEditor"
          class="p-1 rounded-xl text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50/50 dark:hover:bg-gray-700/50 transition-colors"
          :title="lazyStrings.ChatInput__open_advanced_editor()"
          data-testid="open-advanced-editor-button"
        >
          <FileEditIcon class="w-4 h-4" />
        </button>
      </div>

      <div class="flex items-center justify-between px-4 pb-2" :class="{ 'pointer-events-none invisible': visibility === 'submerged' }">
        <div class="flex items-center gap-2">
          <div class="w-[100px] sm:w-[180px]">
            <ModelSelector
              :model-value="chat.modelId"
              @update:model-value="val => chatMetadata.updateModel({ chatId: props.chatId, modelId: val! })"
              :models="sortedAvailableModels"
              :placeholder="formatLabel({ value: inheritedModelId, source: inheritedModelSource })"
              :loading="fetchingModels"
              allow-clear
              @refresh="fetchModels"
              data-testid="model-override-select"
            />
          </div>

          <ChatAttachMenu
            :has-file-system-access="hasFileSystemAccess"
            @files-selected="onAttachFilesSelected({ files: $event })"
            @folder-copy="(folderName, files) => onAttachFolderCopy({ folderName, files })"
            @folder-link="attachLinkAsVolume"
          />

          <ChatToolsMenu
            :can-generate-image="canGenerateImage && hasImageModel"
            :is-processing="isChatStreaming"
            :is-image-mode="isImageMode"
            :is-think-active="selectedReasoningEffort !== undefined"
            :selected-width="currentResolution.width"
            :selected-height="currentResolution.height"
            :selected-count="currentCount"
            :selected-steps="currentSteps"
            :selected-seed="currentSeed"
            :selected-persist-as="currentPersistAs"
            :available-image-models="availableImageModels"
            :selected-image-model="selectedImageModel"
            :selected-reasoning-effort="selectedReasoningEffort"
            @toggle-image-mode="toggleImageMode"
            @update:resolution="(width, height) => updateResolution({ width, height })"
            @update:count="updateCount({ count: $event })"
            @update:steps="updateSteps({ steps: $event })"
            @update:seed="updateSeed({ seed: $event })"
            @update:persist-as="updatePersistAs({ format: $event })"
            @update:model="handleUpdateImageModel({ modelId: $event })"
            @update:reasoning-effort="e => updateReasoningEffort({ effort: e })"
          />
        </div>

        <button
          @click="isChatStreaming ? chatConversation.abort({ chatId: props.chatId }) : handleSend()"
          :disabled="!isChatStreaming && !input.trim() && attachments.length === 0"
          class="px-4 py-2.5 text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-all shadow-lg shadow-blue-500/30 whitespace-nowrap"
          :title="isChatStreaming ? lazyStrings.ChatInput__stop_generating_with_shortcut({ shortcut: 'Esc' }) : lazyStrings.ChatInput__send_message_with_shortcut({ shortcut: sendShortcutText })"
          :data-testid="isChatStreaming ? 'abort-button' : 'send-button'"
        >
          <template v-if="isChatStreaming">
            <span class="text-xs font-medium opacity-90 hidden sm:inline">Esc</span>
            <SquareIcon class="w-4 h-4 fill-white text-white" />
          </template>
          <template v-else>
            <span class="text-[10px] font-bold opacity-90 hidden sm:inline tracking-wider">{{ sendShortcutText }}</span>
            <ImageIcon v-if="isImageMode" class="w-4 h-4 text-white" />
            <SendIcon v-else class="w-4 h-4" />
          </template>
        </button>
      </div>
    </div>

    <!-- Image Editor Overlay -->
    <Teleport to="body">
      <ImageEditor
        v-if="editingAttachment"
        :image-url="attachmentUrls.get(editingAttachment.id)!"
        :file-name="editingAttachment.originalName"
        :original-mime-type="editingAttachment.mimeType"
        @cancel="closeImageEditor"
        @save="saveEditedImage"
      />
      <div v-if="isAdvancedEditorOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-10 bg-black/50 backdrop-blur-sm">
        <div class="w-full max-w-5xl h-full max-h-[90vh]">
          <AdvancedTextEditor
            :initial-value="input"
            :title="undefined"
            :mode="preferredEditorMode"
            @update:content="handleAdvancedEditorUpdate"
            @update:mode="handleAdvancedEditorModeUpdate"
            @close="closeAdvancedEditor"
          />
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.animate-in {
  animation-fill-mode: forwards;
}

.animate-height {
  transition: height 0.3s ease-in-out !important;
}

.glass-zone-mask {
  backdrop-filter: blur(30px);
  -webkit-backdrop-filter: blur(30px);
  /* Keep top 35% clear for a tighter focus around the actual input card */
  mask-image: linear-gradient(to bottom, transparent, black 35%);
  -webkit-mask-image: linear-gradient(to bottom, transparent, black 35%);
  /* Start background fade later to match */
  background: linear-gradient(
    to bottom,
    transparent 25%,
    rgba(255, 255, 255, 0.5) 60%,
    rgba(255, 255, 255, 1) 95%
  );
}

.dark .glass-zone-mask {
  background: linear-gradient(
    to bottom,
    transparent 25%,
    rgba(17, 24, 39, 0.5) 60%,
    rgba(17, 24, 39, 1) 95%
  );
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes zoom-in {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
.fade-in {
  animation-name: fade-in;
}
.zoom-in {
  animation-name: zoom-in;
}
</style>
