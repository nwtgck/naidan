<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { generateId } from '@/01-models/id';
import { ref, watch, onUnmounted, computed } from 'vue';
import draggable from 'vuedraggable';
import {
  XIcon, SaveIcon, PlusIcon, Trash2Icon,
  UserIcon, BotIcon, HammerIcon, CpuIcon,
  PaperclipIcon, ImageIcon, HistoryIcon,
  CopyIcon, GripVerticalIcon, MessageSquareQuoteIcon, InfoIcon,
} from 'lucide-vue-next';
import { copyMessageWithoutReplies } from '@/logic/copy-message-node';
import { cloneLmParameters } from '@/utils/lm-parameters';
import { useLayout } from '@/composables/useLayout';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import type { Attachment, MessageNode, SystemPrompt } from '@/01-models/types';
import { storageService } from '@/00-storage/service';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { commitFullHistoryManipulationForChat } from '@/composables/chat/chat-scoped/chat-history-flow';
import { idToRaw } from '@/01-models/ids';
import type { AttachmentId, BinaryObjectId, ChatId, EditableHistoryItemId, MessageId } from '@/01-models/ids';

const props = defineProps<{
  isOpen: boolean,
}>();

const emit = defineEmits<{
  (e: 'close'): void,
}>();

const { currentChat, activeMessages, inheritedSettings } = useCurrentChatState();
const { setActiveFocusArea } = useLayout();

type EditableHistoryItem = {
  localId: EditableHistoryItemId,
  message: MessageNode,
};

const editableMessages = ref<EditableHistoryItem[]>([]);
const attachmentUrls = ref(new Map<string, string>());
const fileInputs = ref<(HTMLInputElement | null)[]>([]);
const isDragging = ref(false);
const isSaving = ref(false);
const editingChatId = ref<ChatId | undefined>(undefined);
const localSystemPrompt = ref<SystemPrompt | undefined>(undefined);
const inheritedSystemPromptMessages = ref<string[]>([]);
let editSession = 0;
let previewVersion = 0;
let disposed = false;

function setFileInputRef({ el, index }: { el: unknown, index: number }) {
  fileInputs.value[index] = el instanceof HTMLInputElement ? el : null;
}

function clearAttachmentUrls() {
  previewVersion++;
  for (const url of attachmentUrls.value.values()) URL.revokeObjectURL(url);
  attachmentUrls.value = new Map();
}

watch(() => props.isOpen, open => {
  editSession++;
  isSaving.value = false;
  clearAttachmentUrls();
  fileInputs.value = [];
  if (open && currentChat.value) {
    setActiveFocusArea({ area: 'dialog' });
    editingChatId.value = currentChat.value.id;
    inheritedSystemPromptMessages.value = [...(inheritedSettings.value?.systemPromptMessages ?? [])];
    localSystemPrompt.value = currentChat.value.systemPrompt === undefined ? undefined : { ...currentChat.value.systemPrompt };
    // Tool results and reasoning are part of the selected history, not disposable
    // presentation fields. Unchanged parts retain their order, state and metadata.
    editableMessages.value = activeMessages.value.map(message => ({
      localId: generateId<EditableHistoryItemId>(),
      message: copyMessageWithoutReplies({ message }),
    }));
  } else {
    editingChatId.value = undefined;
    inheritedSystemPromptMessages.value = [];
    editableMessages.value = [];
    setActiveFocusArea({ area: 'chat' });
  }
}, { immediate: true });

function attachmentKey({ item, partId }: { item: EditableHistoryItem; partId: string }): string {
  return JSON.stringify([idToRaw({ id: item.localId }), partId]);
}

const attachmentPreviews = computed(() => editableMessages.value.flatMap(item =>
  item.message.parts.flatMap(part => {
    switch (part.type) {
    case 'attachment': return [{ key: attachmentKey({ item, partId: part.id }), attachment: part.attachment }];
    case 'text':
    case 'reasoning':
    case 'tool_call':
    case 'tool_result': return [];
    default: { const _ex: never = part; throw new Error(`Unhandled part: ${_ex}`); }
    }
  }),
));

watch(attachmentPreviews, async entries => {
  clearAttachmentUrls();
  const version = previewVersion;
  for (const { key, attachment } of entries) {
    try {
      let blob: Blob | undefined;
      switch (attachment.status) {
      case 'memory': blob = attachment.blob; break;
      case 'persisted': blob = await storageService.getFile({ binaryObjectId: attachment.binaryObjectId }) ?? undefined; break;
      case 'missing': continue;
      default: { const _ex: never = attachment; throw new Error(`Unhandled attachment: ${_ex}`); }
      }
      if (disposed || !props.isOpen || version !== previewVersion) return;
      if (blob !== undefined) attachmentUrls.value.set(key, URL.createObjectURL(blob));
    } catch (error) {
      if (disposed || version !== previewVersion) return;
      console.error('Failed to load history attachment preview:', error);
    }
  }
});

onUnmounted(() => {
  disposed = true;
  editSession++;
  clearAttachmentUrls();
});

function predictNextRole({ index }: { index: number }): 'user' | 'assistant' {
  const role = editableMessages.value[index]?.message.role ?? editableMessages.value[0]?.message.role;
  switch (role) {
  case 'user': return 'assistant';
  case 'assistant':
  case 'system':
  case 'tool':
  case undefined: return 'user';
  default: { const _ex: never = role; throw new Error(`Unhandled role: ${_ex}`); }
  }
}

function addMessage({ index }: { index: number }) {
  const role = predictNextRole({ index });
  const common = {
    id: generateId<MessageId>(), createdAt: Date.now(), replies: { items: [] },
    modelId: undefined, lmParameters: cloneLmParameters({ lmParameters: EMPTY_LM_PARAMETERS }),
    parts: [{ id: 'text', type: 'text' as const, text: '', completeness: 'complete' as const }],
  };
  editableMessages.value.splice(index + 1, 0, {
    localId: generateId<EditableHistoryItemId>(),
    message: (() => {
      switch (role) {
      case 'user': return { ...common, role };
      case 'assistant': return { ...common, role, interruption: undefined };
      default: { const _ex: never = role; throw new Error(`Unhandled role: ${_ex}`); }
      }
    })(),
  });
}

function removeMessage({ index }: { index: number }) {
  editableMessages.value.splice(index, 1);
}

function canDuplicateMessage({ message }: { message: MessageNode }): boolean {
  // Duplicating a single call or result would duplicate its call identity without
  // a corresponding pair. Keep this action visible but unavailable for such rows.
  return !message.parts.some(part => part.type === 'tool_call' || part.type === 'tool_result');
}

function duplicateMessage({ index }: { index: number }) {
  const item = editableMessages.value[index];
  if (item === undefined || !canDuplicateMessage({ message: item.message })) return;
  editableMessages.value.splice(index + 1, 0, {
    localId: generateId<EditableHistoryItemId>(),
    message: { ...copyMessageWithoutReplies({ message: item.message }), id: generateId<MessageId>() },
  });
}

function canSwitchRole({ message }: { message: MessageNode }): boolean {
  // Switching a structured row must not silently discard reasoning, attachments,
  // completed calls, results, or the recorded interruption.
  return message.role !== 'tool'
    && message.parts.every(part => part.type === 'text')
    && (message.role !== 'assistant' || message.interruption === undefined);
}

function switchRole({ item }: { item: EditableHistoryItem }) {
  const message = item.message;
  if (!canSwitchRole({ message })) return;
  const parts = message.parts.map(part => {
    switch (part.type) {
    case 'text': return { ...part };
    case 'reasoning':
    case 'attachment':
    case 'tool_call':
    case 'tool_result': throw new Error('Only text-only messages can switch roles.');
    default: { const _ex: never = part; throw new Error(`Unhandled part: ${_ex}`); }
    }
  });
  const common = {
    id: message.id, createdAt: message.createdAt, replies: { items: [] }, parts,
    lmParameters: cloneLmParameters({ lmParameters: message.lmParameters }),
  };
  switch (message.role) {
  case 'user': item.message = { ...common, role: 'assistant', modelId: undefined, interruption: undefined }; break;
  case 'assistant':
  case 'system': item.message = { ...common, role: 'user', modelId: undefined }; break;
  case 'tool': throw new Error('Tool results cannot switch roles.');
  default: { const _ex: never = message; throw new Error(`Unhandled message: ${_ex}`); }
  }
}

function triggerFileInput({ index }: { index: number }) {
  const message = editableMessages.value[index]?.message;
  if (message === undefined) return;
  switch (message.role) {
  case 'user': fileInputs.value[index]?.click(); break;
  case 'assistant':
  case 'system':
  case 'tool': break;
  default: { const _ex: never = message; throw new Error(`Unhandled message: ${_ex}`); }
  }
}

function appendImages({ index, files }: { index: number; files: readonly File[] }) {
  const message = editableMessages.value[index]?.message;
  if (message === undefined) return;
  switch (message.role) {
  case 'user': break;
  case 'assistant':
  case 'system':
  case 'tool': return;
  default: { const _ex: never = message; throw new Error(`Unhandled message: ${_ex}`); }
  }
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const attachment: Attachment = {
      id: generateId<AttachmentId>(), binaryObjectId: generateId<BinaryObjectId>(),
      originalName: file.name, mimeType: file.type, size: file.size, uploadedAt: Date.now(),
      status: 'memory', blob: file,
    };
    let partId: string;
    do {
      partId = idToRaw({ id: generateId<EditableHistoryItemId>() });
    }
    while (message.parts.some(part => part.id === partId));
    message.parts.push({ id: partId, type: 'attachment', attachment });
  }
}

function handleFileSelect({ event, index }: { event: Event, index: number }) {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement) || input.files === null) return;
  appendImages({ index, files: Array.from(input.files) });
  input.value = '';
}

function handlePaste({ event, index }: { event: ClipboardEvent, index: number }) {
  const files: File[] = [];
  for (const item of Array.from(event.clipboardData?.items ?? [])) {
    if (!item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file !== null) files.push(file);
  }
  appendImages({ index, files });
}

function removeAttachment({ index, partId }: { index: number; partId: string }) {
  const message = editableMessages.value[index]?.message;
  if (message === undefined) return;
  switch (message.role) {
  case 'user': break;
  case 'assistant':
  case 'system':
  case 'tool': return;
  default: { const _ex: never = message; throw new Error(`Unhandled message: ${_ex}`); }
  }
  message.parts = message.parts.filter(part => part.id !== partId || part.type !== 'attachment');
}

function hasReasoning({ message }: { message: MessageNode }): boolean {
  return message.parts.some(part => part.type === 'reasoning');
}

const systemPromptBehavior = computed({
  get: () => {
    if (!localSystemPrompt.value) return 'inherit';
    if (localSystemPrompt.value.behavior === 'override' && localSystemPrompt.value.content === null) return 'clear';
    return localSystemPrompt.value.behavior;
  },
  set: (val: 'inherit' | 'clear' | 'override' | 'append') => {
    switch (val) {
    case 'inherit':
      localSystemPrompt.value = undefined;
      break;
    case 'clear':
      localSystemPrompt.value = { behavior: 'override', content: null };
      break;
    case 'override': {
      const content = (localSystemPrompt.value && localSystemPrompt.value.content !== null) ? localSystemPrompt.value.content : '';
      localSystemPrompt.value = { behavior: 'override', content };
      break;
    }
    case 'append': {
      const content = (localSystemPrompt.value && localSystemPrompt.value.content !== null) ? localSystemPrompt.value.content : '';
      localSystemPrompt.value = { behavior: 'append', content };
      break;
    }
    default: {
      const _ex: never = val;
      throw new Error(`Unhandled behavior: ${_ex}`);
    }
    }
  },
});

async function handleSave() {
  const chatId = editingChatId.value;
  if (chatId === undefined || isSaving.value) return;
  const session = editSession;
  const messages = editableMessages.value.map(item => copyMessageWithoutReplies({ message: item.message }));
  const systemPrompt = localSystemPrompt.value === undefined ? undefined : { ...localSystemPrompt.value };
  isSaving.value = true;
  try {
    await commitFullHistoryManipulationForChat({ chatId, messages, systemPrompt });
    if (!disposed && session === editSession && props.isOpen) emit('close');
  } finally {
    if (!disposed && session === editSession) isSaving.value = false;
  }
}

function handleCancel() {
  emit('close');
}

function capitalize({ s }: { s: string }) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <Transition name="modal">
    <div v-if="isOpen" tw-class="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 md:p-6" @click.self="handleCancel">
      <div class="modal-content-zoom" tw-class="bg-white dark:bg-gray-900 rounded-3xl shadow-2xl w-full max-w-5xl h-[90vh] flex flex-col border border-gray-100 dark:border-gray-800 overflow-hidden">

        <!-- Header -->
        <div tw-class="flex items-center justify-between px-6 py-5 border-b border-gray-100 dark:border-gray-800 shrink-0 bg-white dark:bg-gray-900 z-10">
          <div tw-class="flex items-center gap-4">
            <div tw-class="p-2.5 bg-orange-500/10 rounded-xl border border-orange-200 dark:border-orange-500/20">
              <HammerIcon tw-class="w-5 h-5 text-orange-500" />
            </div>
            <div>
              <h2 tw-class="text-base font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.HistoryManipulationModal__super_edit() }}</h2>
              <p tw-class="text-[11px] text-gray-500 dark:text-gray-400 font-medium">{{ lazyStrings.HistoryManipulationModal__manipulate_full_chat_history_a_new_branch_will_be_created() }}</p>
            </div>
          </div>
          <button @click="handleCancel" tw-class="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors">
            <XIcon tw-class="w-5 h-5" />
          </button>
        </div>

        <div :inert="isSaving" tw-class="flex-1 overflow-y-auto flex flex-col overscroll-contain bg-gray-50/30 dark:bg-black/10">

          <!-- Banner -->
          <div tw-class="px-6 pt-6">
            <div tw-class="flex items-center gap-3 px-4 py-3 bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100/50 dark:border-blue-900/20 rounded-2xl">
              <InfoIcon tw-class="w-4 h-4 text-blue-500 shrink-0" />
              <p tw-class="text-[11px] text-blue-700/70 dark:text-blue-300/70 font-medium leading-relaxed">
                {{ lazyStrings.HistoryManipulationModal__applying_changes_creates_a() }} <span tw-class="font-bold text-blue-600 dark:text-blue-400">{{ lazyStrings.HistoryManipulationModal__new_branch() }}</span> {{ lazyStrings.HistoryManipulationModal__from_the_root_the_original_conversation_remains_preserved() }}
              </p>
            </div>
          </div>

          <!-- Chat System Prompt Section -->
          <div tw-class="p-6">
            <div tw-class="space-y-4">
              <div tw-class="flex items-center justify-between px-1">
                <label tw-class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest flex items-center gap-2">
                  <MessageSquareQuoteIcon tw-class="w-3.5 h-3.5" />
                  {{ lazyStrings.HistoryManipulationModal__chat_system_prompt() }}
                </label>

                <div tw-class="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
                  <button
                    v-for="b in (['inherit', 'clear', 'override', 'append'] as const)"
                    :key="b"
                    @click="systemPromptBehavior = b"
                    :tw-class="['px-2 py-0.5 text-[9px] font-bold rounded transition-all', systemPromptBehavior === b ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
                  >
                    {{ capitalize({ s: b }) }}
                  </button>
                </div>
              </div>

              <div v-if="systemPromptBehavior === 'override' || systemPromptBehavior === 'append'" class="animate-in fade-in slide-in-from-top-1" tw-class="duration-200">
                <textarea
                  v-model="localSystemPrompt!.content"
                  tw-class="w-full bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-sm font-medium text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm resize-none min-h-[120px]"
                  :placeholder="lazyStrings.HistoryManipulationModal__enter_system_prompt_content()"
                ></textarea>
              </div>

              <div v-else-if="systemPromptBehavior === 'clear'" class="animate-in fade-in slide-in-from-top-1" tw-class="w-full bg-gray-50 dark:bg-gray-800/50 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl px-4 py-8 text-center duration-200">
                <p tw-class="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">{{ lazyStrings.HistoryManipulationModal__parent_prompt_cleared() }}</p>
                <p tw-class="text-[10px] text-gray-400 dark:text-gray-500 mt-1">{{ lazyStrings.HistoryManipulationModal__this_chat_will_not_use_any_system_instructions() }}</p>
              </div>

              <div v-else class="animate-in fade-in slide-in-from-top-1" tw-class="p-4 bg-white dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800 rounded-2xl space-y-3 duration-200">
                <div tw-class="flex items-center justify-between text-[10px] font-bold">
                  <span tw-class="text-gray-400 uppercase tracking-widest">{{ lazyStrings.HistoryManipulationModal__system_prompt_resolution() }}</span>
                  <span tw-class="text-gray-300">{{ lazyStrings.HistoryManipulationModal__inherited() }}</span>
                </div>
                <div tw-class="pt-2 border-t border-gray-50 dark:border-gray-800/50">
                  <div tw-class="text-xs text-gray-500 dark:text-gray-400 leading-relaxed italic font-medium">
                    {{ inheritedSystemPromptMessages.join('\n---\n') || lazyStrings.HistoryManipulationModal__no_system_prompt_inherited() }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Message List -->
          <div tw-class="p-6 pt-0 space-y-6">
            <label tw-class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
              <HistoryIcon tw-class="w-3.5 h-3.5" />
              {{ lazyStrings.HistoryManipulationModal__message_list() }}
            </label>

            <div v-if="editableMessages.length === 0" tw-class="p-16 bg-white dark:bg-gray-900 border border-dashed border-gray-200 dark:border-gray-700 rounded-2xl flex flex-col items-center justify-center text-gray-400 gap-5 shadow-sm">
              <div tw-class="p-5 bg-orange-50 dark:bg-orange-900/20 rounded-full border border-orange-100 dark:border-orange-800">
                <HammerIcon tw-class="w-8 h-8 text-orange-500 opacity-40" />
              </div>
              <p tw-class="text-xs font-bold uppercase tracking-widest opacity-60">{{ lazyStrings.HistoryManipulationModal__forge_empty_history() }}</p>
              <button @click="addMessage({ index: -1 })" tw-class="flex items-center gap-2 px-8 py-3 bg-blue-600 text-white rounded-2xl hover:bg-blue-700 transition-all font-bold text-[11px] uppercase tracking-widest shadow-xl shadow-blue-500/20 active:scale-95">
                <PlusIcon tw-class="w-4 h-4" />
                {{ lazyStrings.HistoryManipulationModal__add_first_message() }}
              </button>
            </div>

            <draggable
              v-model="editableMessages"
              item-key="localId"
              handle=".handle"
              tag="div"
              :animation="250"
              :delay="200"
              :delay-on-touch-only="true"
              @start="isDragging = true"
              @end="isDragging = false"
              ghost-class="sortable-ghost"
              :tw-class="['space-y-6', isDragging ? 'pb-40' : 'pb-8']"
              :scroll="true"
              :force-fallback="true"
              tw-fallback-class="opacity-0"
            >
              <template #item="{ element: msg, index }">
                <div tw-class="relative group">
                  <div tw-class="flex gap-5 items-start">
                    <!-- Control Column -->
                    <div tw-class="flex flex-col items-center gap-3 pt-3 shrink-0">
                      <div class="handle" tw-class="p-1.5 text-gray-300 dark:text-gray-700 cursor-grab active:cursor-grabbing hover:text-blue-500 transition-colors bg-white dark:bg-gray-900 rounded-lg border border-gray-100 dark:border-gray-800 shadow-sm">
                        <GripVerticalIcon tw-class="w-3.5 h-3.5" />
                      </div>

                      <button
                        @click="switchRole({ item: msg })"
                        :disabled="!canSwitchRole({ message: msg.message })"
                        :tw-class="['w-10 h-10 flex items-center justify-center rounded-xl transition-all shadow-sm border', {
                          'bg-blue-50 dark:bg-blue-900/20 text-blue-600 border-blue-100 dark:border-blue-800/50': msg.message.role === 'user',
                          'bg-purple-50 dark:bg-purple-900/20 text-purple-600 border-purple-100 dark:border-purple-800/50': msg.message.role === 'assistant'
                        }]"
                        :title="lazyStrings.HistoryManipulationModal__switch_role()"
                      >
                        <UserIcon v-if="msg.message.role === 'user'" tw-class="w-5 h-5" />
                        <BotIcon v-else-if="msg.message.role === 'assistant'" tw-class="w-5 h-5" />
                        <CpuIcon v-else-if="msg.message.role === 'system'" tw-class="w-5 h-5" />
                        <HammerIcon v-else tw-class="w-5 h-5" />
                      </button>
                      <div tw-class="text-[9px] font-bold text-gray-400 tracking-tight" data-testid="role-label">{{ capitalize({ s: msg.message.role }) }}</div>
                    </div>

                    <!-- Message Card -->
                    <div tw-class="flex-1 bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 overflow-hidden focus-within:ring-4 focus-within:ring-blue-500/10 focus-within:border-blue-500 transition-all flex flex-col shadow-sm group-hover:shadow-md">
                      <div data-testid="history-parts">
                        <div v-for="part in msg.message.parts" :key="part.id" :data-testid="`history-part-${part.id}`">
                          <textarea
                            v-if="part.type === 'text'"
                            v-model="part.text"
                            @paste="handlePaste({ event: $event, index })"
                            tw-class="w-full bg-transparent p-4 text-[14px] text-gray-800 dark:text-gray-100 focus:outline-none resize-none min-h-[100px] font-medium leading-relaxed"
                            :placeholder="lazyStrings.HistoryManipulationModal__type_message_content()"
                          ></textarea>
                          <div v-else-if="part.type === 'attachment'" tw-class="px-5 pt-5">
                            <div tw-class="relative group/att pb-5">
                              <img
                                v-if="part.attachment.mimeType.startsWith('image/')"
                                :src="attachmentUrls.get(attachmentKey({ item: msg, partId: part.id }))"
                                :alt="part.attachment.originalName"
                                tw-class="w-20 h-20 object-cover rounded-xl border-2 border-white dark:border-gray-800 shadow-sm"
                              />
                              <div v-else tw-class="w-20 h-20 flex items-center justify-center bg-gray-100 dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
                                <ImageIcon tw-class="w-8 h-8 text-gray-400" />
                              </div>
                              <button
                                @click="removeAttachment({ index, partId: part.id })"
                                data-testid="remove-history-attachment"
                                tw-class="absolute -top-2 -right-2 p-1.5 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-full text-gray-400 hover:text-red-500 shadow-lg opacity-0 group-hover/att:opacity-100 transition-opacity"
                              ><XIcon tw-class="w-3.5 h-3.5" /></button>
                            </div>
                          </div>
                          <div v-else tw-class="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                            <div tw-class="font-bold">{{ part.type === 'reasoning' ? lazyStrings.HistoryManipulationModal__thoughts() : part.type }}</div>
                            <pre tw-class="whitespace-pre-wrap break-words">{{ part.type === 'reasoning' ? part.text : part.type === 'tool_call' ? JSON.stringify(part.toolCall, null, 2) : JSON.stringify(part.result, null, 2) }}</pre>
                          </div>
                        </div>
                      </div>

                      <!-- Card Toolbar -->
                      <div tw-class="px-4 py-1.5 bg-gray-50/50 dark:bg-gray-800/30 flex items-center justify-between border-t border-gray-50 dark:border-gray-800">
                        <div tw-class="flex gap-4 text-[9px] font-bold font-mono text-gray-400/80 tracking-tight">
                          <span v-if="msg.message.modelId" tw-class="flex items-center gap-1"><CpuIcon tw-class="w-3 h-3" /> {{ msg.message.modelId }}</span>
                          <span v-if="hasReasoning({ message: msg.message })" tw-class="flex items-center gap-1"><HistoryIcon tw-class="w-3 h-3" /> {{ lazyStrings.HistoryManipulationModal__thoughts() }}</span>
                        </div>

                        <div tw-class="flex items-center gap-2">
                          <input
                            :ref="(el: unknown) => setFileInputRef({ el, index })"
                            type="file" accept="image/*" multiple tw-class="hidden"
                            @change="handleFileSelect({ event: $event, index })"
                          />
                          <button
                            data-testid="history-attach-media"
                            @click="triggerFileInput({ index })"
                            :disabled="msg.message.role !== 'user'"
                            tw-class="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-white dark:hover:bg-gray-800 transition-all border border-transparent hover:border-gray-100 dark:hover:border-gray-700 shadow-sm"
                            :title="lazyStrings.HistoryManipulationModal__attach_media()"
                          >
                            <PaperclipIcon tw-class="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>

                    <!-- Side Action Column -->
                    <div tw-class="flex flex-col gap-2 pt-3">
                      <button @click="removeMessage({ index })" tw-class="p-2.5 text-gray-400 hover:text-red-500 hover:bg-white dark:hover:bg-gray-800 rounded-xl transition-all border border-transparent hover:border-gray-100 dark:hover:border-gray-800 shadow-sm" :title="lazyStrings.HistoryManipulationModal__remove_message()">
                        <Trash2Icon tw-class="w-4.5 h-4.5" />
                      </button>
                      <button @click="duplicateMessage({ index })" :disabled="!canDuplicateMessage({ message: msg.message })" tw-class="p-2.5 text-gray-400 hover:text-blue-500 hover:bg-white dark:hover:bg-gray-800 rounded-xl transition-all border border-transparent hover:border-gray-100 dark:hover:border-gray-800 shadow-sm" :title="lazyStrings.HistoryManipulationModal__copy_message()">
                        <CopyIcon tw-class="w-4.5 h-4.5" />
                      </button>
                      <button @click="addMessage({ index })" tw-class="p-2.5 text-gray-400 hover:text-blue-500 hover:bg-white dark:hover:bg-gray-800 rounded-xl transition-all border border-transparent hover:border-gray-100 dark:hover:border-gray-800 shadow-sm" :title="lazyStrings.HistoryManipulationModal__add_message_after()">
                        <PlusIcon tw-class="w-4.5 h-4.5" />
                      </button>
                    </div>
                  </div>

                  <!-- Connector Line -->
                  <div v-if="index < editableMessages.length - 1" tw-class="absolute left-[24.5px] top-[60px] bottom-[-32px] w-[2px] bg-gradient-to-b from-gray-200 via-gray-100 to-gray-200 dark:from-gray-700 dark:via-gray-800 dark:to-gray-700 -z-10 opacity-40"></div>
                </div>
              </template>
            </draggable>

            <div v-if="editableMessages.length > 0" tw-class="flex justify-center pt-4 pb-8">
              <button
                @click="addMessage({ index: editableMessages.length - 1 })"
                tw-class="flex items-center gap-2 px-6 py-2.5 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl text-gray-500 hover:text-blue-600 hover:border-blue-200 dark:hover:border-blue-900/50 hover:bg-blue-50/30 dark:hover:bg-blue-900/10 transition-all shadow-sm font-bold text-xs uppercase tracking-widest active:scale-95"
              >
                <PlusIcon tw-class="w-4 h-4" />
                {{ lazyStrings.HistoryManipulationModal__append_message() }}
              </button>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div tw-class="px-8 py-6 border-t border-gray-100 dark:border-gray-800 flex items-center justify-end gap-5 bg-white dark:bg-gray-900 shrink-0">
          <button @click="handleCancel" tw-class="px-6 py-2.5 text-[11px] font-bold text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors uppercase tracking-[0.15em]">
            {{ lazyStrings.HistoryManipulationModal__discard() }}
          </button>
          <button
            @click="handleSave"
            :disabled="editableMessages.length === 0 || isSaving"
            tw-class="flex items-center gap-2.5 px-10 py-3.5 bg-blue-600 text-white rounded-2xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-xl shadow-blue-500/25 font-bold text-[11px] uppercase tracking-[0.15em] active:scale-95"
          >
            <SaveIcon tw-class="w-4 h-4" />
            {{ lazyStrings.HistoryManipulationModal__apply_changes() }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.3s ease;
}

.modal-enter-active .modal-content-zoom,
.modal-leave-active .modal-content-zoom {
  transition: all 0.3s cubic-bezier(0.34, 1.05, 0.64, 1);
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-content-zoom,
.modal-leave-to .modal-content-zoom {
  transform: scale(0.95);
  opacity: 0;
}

textarea {
  scrollbar-width: thin;
}

.animate-in {
  animation-fill-mode: forwards;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes slide-in-from-top {
  from { transform: translateY(-0.5rem); }
  to { transform: translateY(0); }
}
.fade-in {
  animation-name: fade-in;
}
.slide-in-from-top-1 {
  animation-name: slide-in-from-top;
}
</style>
