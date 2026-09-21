<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { ref, computed, onUnmounted, watch } from 'vue';
import { ChevronRightIcon, ChevronDownIcon, CopyIcon, CheckIcon, ImageIcon, CpuIcon, EyeIcon, EyeOffIcon, FileIcon } from 'lucide-vue-next';
import { storageService } from '@/00-storage/service';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { stripNaidanSentinels } from '@/utils/image-generation';
import type { MessageNode } from '@/01-models/types';
import { getMessageText } from '@/01-models/message-text';
import { inspectDebugImages } from '@/logic/chat-debug-images';
import AllowedHtmlView from '@/components/common/AllowedHtmlView.vue';
import { jsonToHighlightedHtml } from '@/logic/security/allowedHtml';
import { idToRaw, toBinaryObjectId } from '@/01-models/ids';
import type { BinaryObjectId, MessageId } from '@/01-models/ids';

const props = defineProps<{
  node: Readonly<MessageNode>,
  activeIds: Set<MessageId>,
  highlight: boolean,
  isContentCollapsed?: boolean,
  isLast?: boolean,
  isRoot?: boolean,
  mode?: 'active' | 'tree' | 'compact',
  hasLinearParent?: boolean,
}>();

const emit = defineEmits<{
  (e: 'preview-attachment', objId: BinaryObjectId): void,
  (e: 'select-node', node: Readonly<MessageNode>): void,
}>();

const { addErrorEvent } = useGlobalEvents();

const isExpanded = ref(true);
const isActive = computed(() => props.activeIds.has(props.node.id));

const isLocallyCollapsed = ref(false);
const finalIsCollapsed = computed(() => props.isContentCollapsed || isLocallyCollapsed.value);

const rawContent = computed(() => getMessageText({ message: props.node }));
const attachmentParts = computed(() => props.node.parts.filter(part => part.type === 'attachment'));
const interruption = computed(() => {
  const node = props.node;
  switch (node.role) {
  case 'assistant': return node.interruption;
  case 'user':
  case 'system':
  case 'tool': return undefined;
  default: { const unhandled: never = node; throw new Error(`Unhandled debug node: ${unhandled}`); }
  }
});

// Human readable content preview
const isCopied = ref(false);
const copyContent = async () => {
  if (!rawContent.value) return;
  await navigator.clipboard.writeText(rawContent.value);
  isCopied.value = true;
  setTimeout(() => isCopied.value = false, 2000);
};

const jsonOutput = computed(() => {
  const cleanNode = { ...props.node, replies: undefined };
  const json = JSON.stringify(cleanNode, null, 2);
  return jsonToHighlightedHtml({
    json,
    highlight: props.highlight,
    keyStyle: 'tree',
  });
});

const isoTimestamp = computed(() => {
  try {
    return new Date(props.node.createdAt).toISOString();
  } catch {
    return '';
  }
});

const isLinear = computed(() => props.node.replies?.items?.length === 1);

// --- Image Extraction & Thumbnail Logic ---
const thumbnailUrls = ref<Record<string, string>>({});

const imageInspection = computed(() => inspectDebugImages({ message: props.node }));
const inlineImages = computed(() => imageInspection.value.images);
watch(() => imageInspection.value.errors, errors => {
  for (const details of errors) {
    addErrorEvent({ source: 'ChatDebugTreeNode:inlineImages', message: 'Failed to parse generated image metadata.', details });
  }
});

const cleanContentCompact = computed(() => {
  // Strip display markers within each part, not across unrelated part boundaries.
  const stripped = props.node.parts.flatMap(part => {
    switch (part.type) {
    case 'text': return [stripNaidanSentinels({ content: part.text })];
    case 'reasoning':
    case 'attachment':
    case 'tool_call':
    case 'tool_result': return [];
    default: { const unhandled: never = part; throw new Error(`Unhandled debug part: ${unhandled}`); }
    }
  }).join(' ').trim();
  return stripped.slice(0, 50) + (stripped.length > 50 ? '...' : '');
});

let thumbnailsVersion = 0;
let disposed = false;
async function loadThumbnails() {
  const version = ++thumbnailsVersion;
  cleanupThumbnails();
  const blobs = new Map<BinaryObjectId, Blob | undefined>();
  for (const { attachment } of attachmentParts.value) {
    if (!attachment.mimeType.startsWith('image/')) continue;
    switch (attachment.status) {
    case 'memory': blobs.set(attachment.binaryObjectId, attachment.blob); break;
    case 'persisted': if (!blobs.has(attachment.binaryObjectId)) blobs.set(attachment.binaryObjectId, undefined); break;
    case 'missing': break;
    default: {
      const unhandled: never = attachment;
      throw new Error(`Unhandled debug attachment: ${unhandled}`);
    }
    }
  }
  for (const { image } of inlineImages.value) {
    const id = toBinaryObjectId({ raw: image.binaryObjectId });
    if (!blobs.has(id)) blobs.set(id, undefined);
  }
  for (const [id, memoryBlob] of blobs) {
    try {
      const blob = memoryBlob ?? await storageService.getFile({ binaryObjectId: id });
      if (disposed || version !== thumbnailsVersion) return;
      if (blob) thumbnailUrls.value[idToRaw({ id })] = URL.createObjectURL(blob);
    } catch (error) {
      console.error('Failed to load debug thumbnail:', error);
    }
  }
}

function cleanupThumbnails() {
  Object.values(thumbnailUrls.value).forEach(url => URL.revokeObjectURL(url));
  thumbnailUrls.value = {};
}

watch([attachmentParts, inlineImages], () => {
  loadThumbnails();
}, { immediate: true, deep: true });

onUnmounted(() => {
  disposed = true; thumbnailsVersion += 1;
  cleanupThumbnails();
});



defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<script lang="ts">
export default {
  name: 'ChatDebugTreeNode',
};
</script>

<template>
  <div tw-class="relative group/node">
    <!-- Visual Guide Lines for Tree/Compact Mode -->
    <template v-if="!isRoot && mode !== 'active' && !hasLinearParent">
      <!-- Vertical line: top to bottom, bridges the margin gap -->
      <div
        :tw-class="['absolute left-[-24px] top-0 w-px bg-gray-200 dark:bg-gray-800 transition-colors', isLast ? 'h-4' : 'bottom-[-8px]']"
      ></div>
      <!-- Horizontal L-arm: exactly 24px wide to reach the node -->
      <div tw-class="absolute left-[-24px] top-4 w-6 h-px bg-gray-200 dark:bg-gray-800 transition-colors"></div>
    </template>

    <!-- 1. Compact View (Visual Map Mode) -->
    <div
      v-if="mode === 'compact'"
      :tw-class="['flex items-center gap-2 py-1 px-2 rounded-lg cursor-pointer mb-0.5 w-fit transition-colors', isActive ? 'bg-indigo-500/5' : 'hover:bg-gray-100 dark:hover:bg-white/5']"
      @click="emit('select-node', node)"
    >
      <span
        :tw-class="['font-black uppercase text-[7px] tracking-widest px-1 py-0.5 rounded-sm shrink-0 border border-gray-200 dark:border-white/10',
                    node.role === 'user' ? 'text-blue-500' :
                    node.role === 'assistant' ? 'text-emerald-500' : 'text-gray-400'
        ]"
      >
        {{ node.role }}
      </span>
      <span tw-class="text-[9px] text-gray-500 dark:text-gray-400 truncate max-w-[300px] font-sans">
        {{ cleanContentCompact }}
      </span>
    </div>

    <!-- 2. Unified Detailed Block (Active / Detail Mode) -->
    <div
      v-else
      :tw-class="['flex flex-col mb-4 bg-white dark:bg-gray-900/40 border border-gray-100 dark:border-white/5 rounded-2xl overflow-hidden transition-all duration-200', isActive ? 'opacity-100 ring-1 ring-indigo-500/10' : 'opacity-80']"
    >
      <!-- Integrated Header -->
      <div
        tw-class="flex items-center justify-between px-4 py-2.5 bg-gray-50/50 dark:bg-white/[0.02] border-b border-gray-100 dark:border-white/5 cursor-pointer"
        @click="isExpanded = !isExpanded"
      >
        <div tw-class="flex items-center gap-3 overflow-hidden">
          <div tw-class="w-3 flex justify-center shrink-0">
            <component :is="isExpanded ? ChevronDownIcon : ChevronRightIcon" tw-class="w-3 h-3 text-gray-400" />
          </div>

          <span v-if="isoTimestamp" tw-class="text-[8px] text-gray-400/60 font-mono whitespace-nowrap pr-2 border-r border-gray-200 dark:border-white/10 shrink-0">{{ isoTimestamp }}</span>

          <span
            :tw-class="['font-black uppercase text-[8px] tracking-[0.15em] px-2 py-0.5 rounded-sm shrink-0 border',
                        node.role === 'user' ? 'bg-blue-50 dark:bg-blue-500/10 border-blue-200/50 dark:border-blue-500/20 text-blue-600' :
                        node.role === 'assistant' ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200/50 dark:border-emerald-500/20 text-emerald-600' :
                        'bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-white/10 text-gray-400'
            ]"
          >
            {{ node.role }}
          </span>
          <div tw-class="flex items-center gap-2 overflow-hidden">
            <span v-if="node.role === 'assistant' && node.modelId" tw-class="flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-[8px] text-gray-400 font-bold border border-gray-200 dark:border-white/5 whitespace-nowrap">
              <CpuIcon tw-class="w-2.5 h-2.5" />
              {{ node.modelId }}
            </span>
          </div>
        </div>
        <div tw-class="flex items-center gap-4">
          <div v-if="node.replies?.items?.length && mode === 'tree'" tw-class="flex items-center gap-1.5 ml-2">
            <span tw-class="text-[8px] font-bold text-gray-300 dark:text-gray-600 uppercase tracking-tighter">{{ node.replies.items.length }} branches</span>
          </div>
          <button
            @click.stop="isLocallyCollapsed = !isLocallyCollapsed"
            tw-class="p-1 rounded-md text-gray-300 hover:text-indigo-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-all"
            :title="finalIsCollapsed ? lazyStrings.ChatDebugTreeNode__show_content() : lazyStrings.ChatDebugTreeNode__collapse_content()"
          >
            <component :is="finalIsCollapsed ? EyeOffIcon : EyeIcon" tw-class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <!-- Unified Body -->
      <div v-if="isExpanded" tw-class="flex flex-col">
        <!-- Message Content & Attachments -->
        <div tw-class="p-4 bg-transparent space-y-3">
          <!-- Textual Content Group (Collapsible) -->
          <div v-if="!finalIsCollapsed" tw-class="space-y-3" data-testid="debug-parts">
            <div v-if="interruption" tw-class="text-[11px] text-red-500" data-testid="debug-interruption">
              <span tw-class="text-[9px] font-black uppercase tracking-widest block mb-1 opacity-70">{{ interruption.type === 'error' ? 'Error' : 'Cancelled' }}:</span>
              {{ interruption.type === 'error' ? interruption.message : '' }}
            </div>
            <template v-for="part in node.parts" :key="part.id">
              <div v-if="part.type === 'text' || part.type === 'reasoning'" tw-class="relative group/content text-[11px] whitespace-pre-wrap font-sans leading-relaxed text-gray-700 dark:text-gray-300 break-words" :data-testid="'debug-part-' + part.id">
                <span tw-class="text-[9px] font-black uppercase tracking-widest block mb-1 opacity-70">{{ part.type === 'reasoning' ? 'Thinking Process' : 'Content' }} ({{ part.completeness }}):</span>
                <button v-if="part.type === 'text'" @click.stop="copyContent" data-testid="copy-content-btn" tw-class="absolute right-0 top-0 p-1 opacity-0 group-hover/content:opacity-100">
                  <CheckIcon v-if="isCopied" tw-class="w-3.5 h-3.5 text-green-500" />
                  <CopyIcon v-else tw-class="w-3.5 h-3.5" />
                </button>
                <span data-testid="debug-part-text">{{ part.text }}</span>
              </div>
              <div v-else-if="part.type === 'tool_call' || part.type === 'tool_result'" tw-class="text-[11px] whitespace-pre-wrap break-words" :data-testid="'debug-part-' + part.id">
                <span>{{ part.type }}</span>
                <pre>{{ JSON.stringify(part.type === 'tool_call' ? part.toolCall : part.result, null, 2) }}</pre>
              </div>
            </template>
          </div>
          <div v-else-if="node.parts.length || interruption" tw-class="px-3 py-1.5 rounded-lg bg-gray-50/30 dark:bg-white/[0.01] border border-dashed border-gray-200 dark:border-white/5">
            <span tw-class="text-[9px] font-bold text-gray-400 uppercase tracking-widest italic opacity-60">{{ lazyStrings.ChatDebugTreeNode__text_content_hidden() }}</span>
          </div>

          <!-- Non-collapsible visual elements (Images/Attachments) -->
          <template v-if="inlineImages.length > 0 || attachmentParts.length">
            <!-- Inline Generated Images -->
            <div v-if="inlineImages.length > 0" tw-class="mt-4 space-y-4">
              <div v-for="{ image: img, key } in inlineImages" :key="key" tw-class="relative group/inline-img max-w-full overflow-hidden">
                <div tw-class="text-[8px] font-black uppercase tracking-[0.2em] text-gray-400 mb-2 flex items-center gap-2">
                  <ImageIcon tw-class="w-3 h-3" />
                  <span>{{ lazyStrings.ChatDebugTreeNode__generated_image_reference() }}</span>
                </div>
                <div
                  @click.stop="emit('preview-attachment', toBinaryObjectId({ raw: img.binaryObjectId }))"
                  tw-class="rounded-xl overflow-hidden border border-gray-100 dark:border-white/5 cursor-pointer bg-gray-100/30 dark:bg-white/5 flex items-center justify-center w-fit max-w-full shadow-sm hover:shadow-md transition-shadow"
                >
                  <img
                    v-if="thumbnailUrls[img.binaryObjectId]"
                    :src="thumbnailUrls[img.binaryObjectId]"
                    tw-class="max-h-[300px] object-contain block"
                    :style="{ width: img.displayWidth + 'px', maxWidth: '100%' }"
                  />
                  <div v-else tw-class="p-8 flex flex-col items-center gap-2">
                    <ImageIcon tw-class="w-6 h-6 text-gray-300 animate-pulse" />
                  </div>
                </div>
                <div v-if="img.prompt" tw-class="mt-1.5 text-[10px] text-gray-500 dark:text-gray-400 italic px-3 border-l-2 border-indigo-500/30 font-sans">
                  "{{ img.prompt }}"
                </div>
              </div>
            </div>

            <div v-if="attachmentParts.length" tw-class="mt-4 flex flex-wrap gap-2">
              <div
                v-for="{ id, attachment: att } in attachmentParts"
                :key="id"
                @click.stop="emit('preview-attachment', att.binaryObjectId)"
                tw-class="relative w-14 h-14 rounded-xl overflow-hidden border border-gray-100 dark:border-white/5 cursor-pointer bg-gray-100/30 dark:bg-white/5 flex items-center justify-center group/att"
              >
                <img v-if="thumbnailUrls[idToRaw({ id: att.binaryObjectId })]" :src="thumbnailUrls[idToRaw({ id: att.binaryObjectId })]" tw-class="w-full h-full object-cover" />
                <div v-else tw-class="flex flex-col items-center justify-center gap-1">
                  <ImageIcon v-if="att.mimeType.startsWith('image/')" tw-class="w-4 h-4 text-gray-400" />
                  <FileIcon v-else tw-class="w-4 h-4 text-gray-400" />
                </div>
                <div tw-class="absolute bottom-0 inset-x-0 bg-black/40 text-[7px] text-white px-1 py-0.5 truncate text-center font-bold backdrop-blur-sm">
                  {{ att.mimeType.split('/')[1] }}
                </div>
              </div>
            </div>
          </template>
        </div>

        <!-- Integrated JSON -->
        <div tw-class="p-4 bg-gray-50/20 dark:bg-black/10 border-t border-gray-100 dark:border-white/5">
          <AllowedHtmlView
            as="pre"
            :html="jsonOutput"
            class="thin-scrollbar" tw-class="text-[10px] overflow-x-auto text-gray-500 dark:text-gray-400 leading-tight font-mono max-h-48"
          />
        </div>
      </div>
    </div>

    <!-- Recursive Children -->
    <div
      v-if="node.replies?.items?.length && isExpanded && mode === 'tree'"
      :tw-class="['mt-0 space-y-1', isLinear ? 'ml-0' : 'ml-6']"
    >
      <ChatDebugTreeNode
        v-for="(child, index) in node.replies.items"
        :key="idToRaw({ id: child.id })"
        :node="child"
        :active-ids="activeIds"
        :highlight="highlight"
        :is-last="index === node.replies.items.length - 1"
        :mode="mode"
        :has-linear-parent="isLinear"
        @preview-attachment="emit('preview-attachment', $event)"
        @select-node="emit('select-node', $event)"
      />
    </div>

    <!-- Recursive Children (Compact) -->
    <div
      v-if="node.replies?.items?.length && mode === 'compact'"
      :tw-class="['mt-0', isLinear ? 'ml-0' : 'ml-6']"
    >
      <ChatDebugTreeNode
        v-for="(child, index) in node.replies.items"
        :key="idToRaw({ id: child.id })"
        :node="child"
        :active-ids="activeIds"
        :highlight="highlight"
        :is-last="index === node.replies.items.length - 1"
        :mode="mode"
        :has-linear-parent="isLinear"
        @select-node="emit('select-node', $event)"
        @preview-attachment="emit('preview-attachment', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.thin-scrollbar::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}
.thin-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.thin-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(156, 163, 175, 0.1);
  border-radius: 10px;
}
.thin-scrollbar::-webkit-scrollbar-thumb:hover {
  background: rgba(156, 163, 175, 0.2);
}
</style>
