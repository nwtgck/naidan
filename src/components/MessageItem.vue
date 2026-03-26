<script setup lang="ts">
import { computed, ref, onMounted, nextTick, watch, onUnmounted, provide } from 'vue';
import BlockMarkdownRenderer from './block-markdown/BlockMarkdownRenderer.vue';
import GeneratingIndicator from './GeneratingIndicator.vue';
import { markRaw } from 'vue';
import 'katex/dist/katex.min.css';
import type { MessageNode, BinaryObject, EndpointType, LmParameters, Reasoning } from '@/models/types';
import type { FlowMetadata, MessageMode } from '@/composables/useChatDisplayFlow';
import { EMPTY_LM_PARAMETERS } from '@/models/types';
import { User, Bird, ChevronLeft, ChevronRight, AlertTriangle, Download, RefreshCw, Settings2, XCircle, Square, FileEdit, MoreHorizontal, Brain } from 'lucide-vue-next';
import { storageService } from '@/services/storage';
// IMPORTANT: SpeechControl is used in every message and should be immediately available.
import SpeechControl from './SpeechControl.vue';
// IMPORTANT: ImageConjuringLoader is essential for showing image generation progress immediately.
import ImageConjuringLoader from './ImageConjuringLoader.vue';
import ImageIndexBadge from './ImageIndexBadge.vue';
import MessageThinking from './MessageThinking.vue';
import AssistantWaitingIndicator from './AssistantWaitingIndicator.vue';
import MessageActions from './MessageActions.vue';
import SpeechLanguageSelector from './SpeechLanguageSelector.vue';
import { transformersJsService } from '@/services/transformers-js';
import { defineAsyncComponentAndLoadOnMounted } from '@/utils/vue';
const ImageGenerationSettings = defineAsyncComponentAndLoadOnMounted(() => import('./ImageGenerationSettings.vue'));
const ReasoningSettings = defineAsyncComponentAndLoadOnMounted(() => import('./ReasoningSettings.vue'));
const MessageDiffModal = defineAsyncComponentAndLoadOnMounted(() => import('./MessageDiffModal.vue'));
const AdvancedTextEditor = defineAsyncComponentAndLoadOnMounted(() => import('./AdvancedTextEditorV3.vue'));
import { useImagePreview, MESSAGE_CONTEXTUAL_PREVIEW_KEY } from '@/composables/useImagePreview';
import { useChat } from '@/composables/useChat';
import { useReasoning } from '@/composables/useReasoning';
import { useLayout } from '@/composables/useLayout';
import { useSettings } from '@/composables/useSettings';
import {
  isImageGenerationPending,
  isImageGenerationProcessed,
  getImageGenerationProgress,
  stripNaidanSentinels,
  isImageRequest,
  parseImageRequest,
  createImageRequestMarker,
} from '@/utils/image-generation';

const props = withDefaults(defineProps<{
  chatId?: string;
  message: MessageNode;
  siblings?: MessageNode[];
  canGenerateImage?: boolean;
  isProcessing?: boolean;
  isGenerating?: boolean;
  availableImageModels?: string[];
  endpointType?: EndpointType;
  flow?: FlowMetadata;
  mode?: MessageMode;
  partContent?: string;
  isFirstInNode?: boolean;
  isLastInNode?: boolean;
  isFirstInTurn?: boolean;
  showGeneratingIndicator?: boolean;
}>(), {
  flow: () => ({ position: 'standalone', nesting: 'none' }),
  isGenerating: false,
  mode: 'content',
  isFirstInNode: true,
  isLastInNode: true,
  isFirstInTurn: false,
  showGeneratingIndicator: false
});

const emit = defineEmits<{
  (e: 'fork', messageId: string): void;
  (e: 'edit', messageId: string, newContent: string, lmParameters: LmParameters | undefined): void;
  (e: 'switch-version', messageId: string): void;
  (e: 'regenerate', messageId: string): void;
  (e: 'abort'): void;
}>();

const isEditing = ref(false);
const isAdvancedEditorOpen = ref(false);
const showExtensions = ref(false);
const editContent = ref((props.message.content || '').trimEnd());
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const showDiffModal = ref(false);

const transformersStatus = ref(transformersJsService.getState().status);
let transformersUnsubscribe: (() => void) | null = null;

const isImageRequestMsg = computed(() => isImageRequest(props.message.content || ''));
const showImageSettings = ref(false);
const editImageMode = ref(false);
const editImageParams = ref({
  width: 512,
  height: 512,
  model: undefined as string | undefined,
  count: 1,
  steps: undefined as number | undefined,
  seed: undefined as number | 'browser_random' | undefined,
  persistAs: 'original' as 'original' | 'webp' | 'jpeg' | 'png'
});

const attachmentUrls = ref<Record<string, string>>({});

const { openPreview } = useImagePreview();
const { imageProgressMap, currentChat } = useChat();
const { getReasoningEffort } = useReasoning();
const { preferredEditorMode, setPreferredEditorMode } = useLayout();
const { settings } = useSettings();

const editReasoningEffort = ref<Reasoning['effort']>(undefined);

function openAdvancedEditor() {
  isAdvancedEditorOpen.value = true;
}

function closeAdvancedEditor() {
  isAdvancedEditorOpen.value = false;
}

function handleAdvancedEditorUpdate({ content: newContent }: { content: string }) {
  editContent.value = newContent;
}

function handleAdvancedEditorModeUpdate({ mode }: { mode: 'advanced' | 'textarea' }) {
  setPreferredEditorMode({ mode });
}

async function handlePreviewImage({ id }: { id: string }) {
  // To support next/prev navigation, we'd ideally pass all images in this chat or message.
  // For now, let's at least try to fetch metadata for the clicked one.
  const obj = await storageService.getBinaryObject({ binaryObjectId: id });
  if (obj) {
    // If it's a message attachment, we can pass all images in this message for navigation
    const allImages: BinaryObject[] = (props.message.attachments || [])
      .filter(a => a.status !== 'missing' && a.mimeType.startsWith('image/'))
      .map(a => ({ id: a.binaryObjectId, mimeType: a.mimeType, size: a.size, createdAt: a.uploadedAt, name: a.originalName }));

    // Also include generated images if they exist in this message's content
    const placeholders = messageRef.value?.querySelectorAll('.naidan-generated-image');
    if (placeholders) {
      for (const el of placeholders) {
        const hid = (el as HTMLElement).dataset.id;
        if (hid && !allImages.find(i => i.id === hid)) {
          // Fetch meta if missing
          const meta = await storageService.getBinaryObject({ binaryObjectId: hid });
          if (meta) allImages.push(meta);
        }
      }
    }

    openPreview({
      objects: allImages.length > 0 ? allImages : [obj],
      initialId: id
    });
  }
}

provide(MESSAGE_CONTEXTUAL_PREVIEW_KEY, handlePreviewImage);

async function loadAttachments() {
  if (!props.message.attachments) return;

  for (const att of props.message.attachments) {
    switch (att.status) {
    case 'memory':
      attachmentUrls.value[att.id] = URL.createObjectURL(att.blob);
      break;
    case 'persisted':
      try {
        const blob = await storageService.getFile(att.binaryObjectId);
        if (blob) {
          attachmentUrls.value[att.id] = URL.createObjectURL(blob);
        }
      } catch (e) {
        console.error('Failed to load persisted attachment:', e);
      }
      break;
    case 'missing':
      break;
    default: {
      const _ex: never = att;
      throw new Error(`Unhandled attachment status: ${_ex}`);
    }
    }
  }
}

const isMac = (() => {
  const t = typeof window;
  switch (t) {
  case 'undefined': return false;
  case 'object':
  case 'boolean':
  case 'string':
  case 'number':
  case 'function':
  case 'symbol':
  case 'bigint':
    return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  default: {
    const _ex: never = t;
    return _ex;
  }
  }
})();
const sendShortcutText = isMac ? 'Cmd + Enter' : 'Ctrl + Enter';

// Focus and move cursor to end when editing starts
watch(isEditing, (editing) => {
  if (editing) {
    editContent.value = stripNaidanSentinels(props.message.content || '').trimEnd();

    // Initialize reasoning effort from message if available, otherwise from current chat
    if (props.message.role === 'user' && props.message.lmParameters?.reasoning) {
      editReasoningEffort.value = props.message.lmParameters.reasoning.effort;
    } else if (currentChat.value) {
      editReasoningEffort.value = getReasoningEffort({ chatId: currentChat.value.id });
    }

    // Initialize image generation settings if it's an image request
    if (isImageRequestMsg.value) {
      editImageMode.value = true;
      const parsed = parseImageRequest(props.message.content || '');
      if (parsed) {
        editImageParams.value = {
          width: parsed.width ?? 512,
          height: parsed.height ?? 512,
          model: parsed.model || undefined,
          count: parsed.count ?? 1,
          steps: parsed.steps,
          seed: parsed.seed,
          persistAs: parsed.persistAs ?? 'original'
        };
      }
    } else {
      editImageMode.value = false;
    }

    // Auto-open tools if either image mode or non-default reasoning is active
    showImageSettings.value = editImageMode.value || editReasoningEffort.value !== undefined;

    nextTick(() => {
      if (textareaRef.value) {
        textareaRef.value.focus();
        // Move cursor to end
        textareaRef.value.selectionStart = textareaRef.value.value.length;
        textareaRef.value.selectionEnd = textareaRef.value.value.length;
      }
    });
  }
});

const versionInfo = computed(() => {
  if (!props.siblings || props.siblings.length <= 1) return null;
  const index = props.siblings.findIndex(m => m.id === props.message.id);
  return {
    current: index + 1,
    total: props.siblings.length,
    hasPrev: index > 0,
    hasNext: index < props.siblings.length - 1,
    prevId: index > 0 ? props.siblings[index - 1]?.id : null,
    nextId: index < props.siblings.length - 1 ? props.siblings[index + 1]?.id : null,
  };
});

function handleSaveEdit() {
  if (editContent.value.trim()) {
    let finalContent = editContent.value.trimEnd();
    if (editImageMode.value) {
      const marker = createImageRequestMarker({
        width: editImageParams.value.width,
        height: editImageParams.value.height,
        model: editImageParams.value.model,
        count: editImageParams.value.count,
        steps: editImageParams.value.steps,
        seed: editImageParams.value.seed,
        persistAs: editImageParams.value.persistAs
      });
      finalContent = marker + '\n' + finalContent;
    }
    const lmParameters: LmParameters = {
      ...(settings.value.lmParameters || EMPTY_LM_PARAMETERS),
      stop: settings.value.lmParameters?.stop ? [...settings.value.lmParameters.stop] : undefined,
      reasoning: { effort: editReasoningEffort.value }
    };
    emit('edit', props.message.id, finalContent, lmParameters);
  }
  isEditing.value = false;
}

function handleCancelEdit() {
  editContent.value = stripNaidanSentinels(props.message.content || '').trimEnd();
  isEditing.value = false;
}

function handleClearContent() {
  editContent.value = '';
  nextTick(() => {
    textareaRef.value?.focus();
  });
}

onMounted(() => {
  loadAttachments();

  transformersUnsubscribe = transformersJsService.subscribe((s) => {
    transformersStatus.value = s;
  });

});

onUnmounted(() => {
  Object.values(attachmentUrls.value).forEach(url => URL.revokeObjectURL(url));

  if (transformersUnsubscribe) transformersUnsubscribe();
});

const messageRef = ref<HTMLElement | null>(null);

const displayContent = computed(() => {
  const mode = props.mode;
  switch (mode) {
  case 'content': {
    if (props.partContent !== undefined) return props.partContent;
    let content = props.message.content || '';
    content = stripNaidanSentinels(content);
    const cleanContent = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
    if (cleanContent.length > 0) return cleanContent;
    return '';
  }
  case 'thinking':
  case 'waiting':
  case 'tool_calls':
    return '';
  default: {
    const _ex: never = mode;
    return _ex;
  }
  }
});

const isImageResponse = computed(() => isImageGenerationProcessed(props.message.content || ''));


const speechText = computed(() => {
  const mode = props.mode;
  switch (mode) {
  case 'content': {
    const text = props.partContent !== undefined ? props.partContent : displayContent.value;
    if (!text) return '';
    if (isImageResponse.value) return 'Image generated.';
    return text.replace(/<[^>]*>/g, '');
  }
  case 'thinking':
  case 'waiting':
  case 'tool_calls':
    return '';
  default: {
    const _ex: never = mode;
    return _ex;
  }
  }
});

const isUser = computed((): boolean => {
  const node = props.message;
  switch (node.role) {
  case 'user': return true;
  case 'assistant':
  case 'system':
  case 'tool':
    return false;
  default: {
    const _ex: never = node;
    return (_ex as { role: string }).role === 'user';
  }
  }
});

const reasoningEffortLabel = computed(() => {
  const effort = (() => {
    switch (props.message.role) {
    case 'assistant':
      return props.message.lmParameters?.reasoning?.effort;
    case 'user':
    case 'system':
    case 'tool':
      return undefined;
    default: {
      const _ex: never = props.message;
      throw new Error(`Unhandled role: ${(_ex as { role: string }).role}`);
    }
    }
  })();

  if (effort === undefined) return undefined;

  switch (effort) {
  case 'none':
    return 'Off';
  case 'low':
  case 'medium':
  case 'high':
    return 'Think';
  default: {
    const _ex: never = effort;
    return _ex;
  }
  }
});

const reasoningEffortTooltip = computed(() => {
  const effort = (() => {
    switch (props.message.role) {
    case 'assistant':
      return props.message.lmParameters?.reasoning?.effort;
    case 'user':
    case 'system':
    case 'tool':
      return undefined;
    default: {
      const _ex: never = props.message;
      throw new Error(`Unhandled role: ${(_ex as { role: string }).role}`);
    }
    }
  })();

  if (effort === undefined) return undefined;

  switch (effort) {
  case 'none':
    return 'Think: Disabled';
  case 'low':
  case 'medium':
  case 'high': {
    const label = effort.charAt(0).toUpperCase() + effort.slice(1);
    return `Think: ${label} Effort\n(Note: Specific effort levels may be ignored by some models)`;
  }
  default: {
    const _ex: never = effort;
    return _ex;
  }
  }
});

const hasThinking = computed(() => !!props.message.thinking || /<think>/i.test(props.message.content || ''));

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

const showHeader = computed(() => props.flow.position === 'standalone' || props.flow.position === 'start');
const isNested = computed(() => props.flow.nesting === 'inside-group');

defineExpose({
  __testOnly: {
    openAdvancedEditor,
    handleAdvancedEditorModeUpdate,
  }
});
</script>

<template>
  <div
    v-if="!(isGenerating && (transformersStatus === 'loading' || transformersStatus === 'error') && endpointType === 'transformers_js')"
    ref="messageRef"
    class="flex flex-col gap-2 group transition-colors"
    :class="[
      isNested ? 'px-5' : 'p-5',
      {
        'bg-gray-50/30 dark:bg-gray-800/20': !isUser && !isNested,
        'border-t border-gray-100 dark:border-gray-800/50': !isUser && !isNested && (flow.position === 'standalone' || flow.position === 'start'),
        'border-b border-gray-100 dark:border-gray-800/50': !isUser && !isNested && (flow.position === 'standalone' || flow.position === 'end'),
        'pt-2': !isUser && (isNested || flow.position === 'middle' || flow.position === 'end'),
        'pb-2': !isUser && (isNested || flow.position === 'start' || flow.position === 'middle')
      }
    ]"
  >
    <div v-if="showHeader && isFirstInTurn && !isNested" class="flex items-center gap-3 mb-1">
      <div class="w-8 h-8 rounded-xl flex items-center justify-center shadow-sm border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800">
        <User v-if="isUser" class="w-4 h-4 text-gray-500" />
        <Bird v-else class="w-4 h-4 text-blue-600 dark:text-blue-400" />
      </div>
      <div class="text-[10px] font-bold text-gray-400 dark:text-gray-500 flex items-center gap-2">
        <span v-if="isUser" class="text-gray-800 dark:text-gray-200 uppercase tracking-widest">You</span>
        <template v-else>
          <span>{{ message.modelId || 'Assistant' }}</span>
          <div
            v-if="reasoningEffortLabel"
            class="flex items-center gap-1 ml-1 text-[8px] font-mono text-gray-400 dark:text-gray-500 leading-none cursor-help"
            :title="reasoningEffortTooltip"
            data-testid="reasoning-effort-badge"
          >
            <Brain class="w-2.5 h-2.5" />
            <span>{{ reasoningEffortLabel }}</span>
          </div>
          <div class="flex items-center gap-1 group/msg-header-tools">
            <SpeechControl v-if="!isImageResponse && !isImageGenerationPending(message.content || '')" :message-id="message.id" :content="speechText" :is-generating="isGenerating" />

            <!-- Header Extensions Slot (Seamless transition) -->
            <div v-if="showExtensions" class="flex items-center gap-1 mx-1 animate-in slide-in-from-left-1 fade-in duration-200">
              <SpeechLanguageSelector :message-id="message.id" :content="speechText" is-mini align="down" />
              <!-- Future tools here -->
            </div>

            <button
              v-if="isGenerating"
              @click="emit('abort')"
              class="p-1 rounded-lg text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              title="Stop generation"
              data-testid="message-abort-button"
            >
              <Square class="w-3 h-3" />
            </button>

            <!-- Generic More Button (Absolute Right Anchor for Header) -->
            <button
              v-if="!isImageResponse && !isImageGenerationPending(message.content || '')"
              @click="showExtensions = !showExtensions"
              class="p-1 rounded-lg transition-colors"
              :class="showExtensions ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'"
              title="More Message Tools"
            >
              <MoreHorizontal class="w-3.5 h-3.5" />
            </button>
          </div>
        </template>
      </div>
    </div>

    <div :class="isEditing ? 'overflow-visible' : 'overflow-hidden'">
      <!-- Attachments (Only shown in the first part of a node if any) -->
      <div v-if="isFirstInNode && message.attachments && message.attachments.length > 0" class="flex flex-wrap gap-2 mb-3">
        <div v-for="(att, idx) in message.attachments" :key="att.id" class="relative group/att">
          <template v-if="att.status !== 'missing' && attachmentUrls[att.id]">
            <img
              :src="attachmentUrls[att.id]"
              @click="handlePreviewImage({ id: att.binaryObjectId })"
              class="max-w-[300px] max-h-[300px] object-contain rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm cursor-pointer hover:opacity-95 transition-opacity"
            />
            <div v-if="message.attachments.length > 1" class="absolute bottom-2 left-2 z-10">
              <ImageIndexBadge :index="idx + 1" :total="message.attachments.length" />
            </div>
            <a
              :href="attachmentUrls[att.id]"
              :download="att.originalName"
              class="absolute top-2 right-2 p-1.5 bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-gray-100 dark:border-gray-700 rounded-lg text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 shadow-sm opacity-0 touch-visible group-hover/att:opacity-100 transition-all z-10"
              title="Download image"
              data-testid="download-attachment"
            >
              <Download class="w-4 h-4" />
            </a>
          </template>
          <template v-else>
            <div class="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 text-xs text-gray-500">
              <AlertTriangle class="w-3.5 h-3.5 text-amber-500" />
              <span>Image missing ({{ att.originalName }}) - {{ formatSize(att.size) }}</span>
            </div>
          </template>
        </div>
      </div>

      <MessageThinking
        v-if="mode === 'thinking'"
        :message="message"
        :part-content="partContent"
        :no-margin="isNested"
        :trailing-inline="showGeneratingIndicator ? markRaw(GeneratingIndicator) : undefined"
      />

      <!-- Content -->
      <div v-if="isEditing" class="mt-1" data-testid="edit-mode">
        <!-- Edit mode remains full-content for now -->
        <div class="border border-gray-200 dark:border-gray-600 rounded-xl bg-white dark:bg-gray-800 shadow-sm focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-all overflow-visible">
          <textarea
            ref="textareaRef"
            v-model="editContent"
            @keydown.enter.ctrl.prevent="handleSaveEdit"
            @keydown.enter.meta.prevent="handleSaveEdit"
            @keydown.esc.prevent="handleCancelEdit"
            class="w-full p-4 bg-transparent text-gray-800 dark:text-gray-100 text-sm focus:outline-none h-32 resize-none"
            data-testid="edit-textarea"
          ></textarea>

          <div class="flex items-center justify-between px-3 pb-3">
            <div class="flex items-center gap-1">
              <button
                v-if="canGenerateImage || true"
                @click="showImageSettings = !showImageSettings"
                class="p-2 rounded-xl transition-colors"
                :class="showImageSettings || editImageMode || editReasoningEffort !== undefined ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20 ring-2 ring-blue-500/20' : 'text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800'"
                title="Tools"
                data-testid="toggle-edit-image-mode"
              >
                <Settings2 class="w-5 h-5" />
              </button>
              <button
                @click="openAdvancedEditor"
                class="p-2 rounded-xl text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                title="Open Advanced Editor"
                data-testid="open-advanced-editor-button"
              >
                <FileEdit class="w-5 h-5" />
              </button>
            </div>
            <div class="flex items-center gap-2">
              <button
                v-if="editContent"
                @click="handleClearContent"
                class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg transition-colors"
                title="Clear all text"
                data-testid="clear-edit-content"
              >
                <XCircle class="w-3.5 h-3.5" />
                <span>Clear</span>
              </button>
              <button @click="handleCancelEdit" class="px-3 py-1.5 text-xs font-bold text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors">Cancel</button>
              <button @click="handleSaveEdit" class="px-4 py-1.5 text-xs font-bold bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-all flex items-center gap-2 shadow-lg shadow-blue-500/30" data-testid="save-edit">
                <span>{{ isUser ? 'Send & Branch' : 'Update & Branch' }}</span>
                <span class="opacity-60 text-[9px] border border-white/20 px-1 rounded font-medium">{{ sendShortcutText }}</span>
              </button>
            </div>
          </div>

          <!-- Inline Experimental Tools (if active) -->
          <div v-if="showImageSettings" class="border-t border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/20 py-1" data-testid="embedded-experimental-tools">
            <div class="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest border-b dark:border-gray-700 mb-1">
              Options/Tools
            </div>
            <ReasoningSettings
              :selected-effort="editReasoningEffort"
              @update:effort="e => editReasoningEffort = e"
            />
            <ImageGenerationSettings
              :can-generate-image="canGenerateImage ?? false"
              :is-processing="isProcessing ?? false"
              :is-image-mode="editImageMode"
              :selected-width="editImageParams.width"
              :selected-height="editImageParams.height"
              :selected-count="editImageParams.count"
              :selected-steps="editImageParams.steps"
              :selected-seed="editImageParams.seed"
              :selected-persist-as="editImageParams.persistAs"
              :available-image-models="availableImageModels ?? []"
              :selected-image-model="editImageParams.model"
              @toggle-image-mode="editImageMode = !editImageMode"
              @update:resolution="(w, h) => { editImageParams.width = w; editImageParams.height = h; }"
              @update:count="c => editImageParams.count = c"
              @update:steps="s => editImageParams.steps = s"
              @update:seed="s => editImageParams.seed = s"
              @update:persist-as="f => editImageParams.persistAs = f"
              @update:model="m => editImageParams.model = m"
            />
          </div>
        </div>
      </div>
      <div v-else>
        <!-- Content Display (Always shown if present) -->
        <div v-if="displayContent" data-testid="message-content">
          <BlockMarkdownRenderer
            :content="displayContent"
            :trailing-inline="showGeneratingIndicator && !!displayContent ? markRaw(GeneratingIndicator) : undefined"
          />
        </div>

        <!-- AI Image Synthesis Loader (Componentized) -->
        <!-- Only shown in content mode or first part if pending -->
        <ImageConjuringLoader
          v-if="mode === 'content' && isImageGenerationPending(message.content || '') && message.role === 'assistant' && !message.error"
          v-bind="getImageGenerationProgress(message.content || '')"
          :current-step="isGenerating && chatId ? imageProgressMap[chatId]?.currentStep : undefined"
          :total-steps="isGenerating && chatId ? imageProgressMap[chatId]?.totalSteps : undefined"
        />

        <!-- Loading State (Initial Wait for regular text) -->
        <AssistantWaitingIndicator
          v-else-if="mode === 'waiting' && !displayContent && !hasThinking && message.role === 'assistant' && !message.error && !isImageGenerationPending(message.content)"
          :is-nested="isNested"
          data-testid="loading-indicator"
        />

        <!-- Error State (Appended below content) -->
        <div v-if="isLastInNode && message.error" class="mt-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 rounded-xl text-red-600 dark:text-red-400 text-sm flex flex-col gap-2 items-start" data-testid="error-message">
          <div class="flex items-center gap-2 font-bold">
            <AlertTriangle class="w-4 h-4" />
            <span>Generation Failed</span>
          </div>
          <div class="opacity-90">{{ message.error }}</div>
          <button
            @click="emit('regenerate', message.id)"
            class="mt-1 px-3 py-1.5 bg-white dark:bg-gray-800 border border-red-200 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg text-xs font-bold transition-colors flex items-center gap-2"
            data-testid="retry-button"
          >
            <RefreshCw class="w-3.5 h-3.5" />
            <span>Retry</span>
          </button>
        </div>


        <div v-if="isLastInNode" class="flex items-center justify-between min-h-[28px]" :class="isNested ? 'mt-1' : 'mt-3'" data-testid="message-actions-wrapper">
          <!-- Version Paging -->
          <div v-if="versionInfo" class="message-version-paging flex items-center gap-2 text-[10px] font-bold text-gray-400 uppercase tracking-widest bg-gray-50 dark:bg-gray-800 px-2 py-0.5 rounded-lg border border-gray-100 dark:border-gray-700" data-testid="version-paging">
            <button
              @click="versionInfo.prevId && emit('switch-version', versionInfo.prevId)"
              :disabled="!versionInfo.hasPrev"
              class="p-1 hover:text-blue-600 disabled:opacity-20 transition-colors"
            >
              <ChevronLeft class="w-3 h-3" />
            </button>
            <span class="min-w-[2.5rem] text-center">{{ versionInfo.current }} / {{ versionInfo.total }}</span>
            <button
              @click="versionInfo.nextId && emit('switch-version', versionInfo.nextId)"
              :disabled="!versionInfo.hasNext"
              class="p-1 hover:text-blue-600 disabled:opacity-20 transition-colors"
            >
              <ChevronRight class="w-3 h-3" />
            </button>
          </div>
          <div v-else></div>

          <!-- Message Actions -->
          <MessageActions
            :message="message"
            :is-image-response="isImageResponse"
            :is-user="isUser"
            :is-generating="isGenerating"
            v-model:show-extensions="showExtensions"
            :speech-text="speechText"
            :display-content="displayContent"
            @regenerate="id => emit('regenerate', id)"
            @edit="(id, content, params) => emit('edit', id, content, params)"
            @fork="id => emit('fork', id)"
            @enter-edit-mode="isEditing = true"
            @show-diff="showDiffModal = true"
          />

        </div>
      </div>
    </div>

    <!-- Version History Diff Modal -->
    <MessageDiffModal
      v-if="showDiffModal"
      :is-open="showDiffModal"
      :siblings="siblings || []"
      :current-message-id="message.id"
      @close="showDiffModal = false"
      data-testid="message-diff-modal"
    />

    <Teleport to="body">
      <div v-if="isAdvancedEditorOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-10 bg-black/50 backdrop-blur-sm">
        <div class="w-full max-w-5xl h-full max-h-[90vh]">
          <AdvancedTextEditor
            :initial-value="editContent"
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
/* Dropdown Transition */
.dropdown-enter-active,
.dropdown-leave-active {
  transition: all 0.2s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: scale(0.95) translateY(10px);
}
</style>
