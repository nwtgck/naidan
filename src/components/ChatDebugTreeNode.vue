<script setup lang="ts">
import { ref, computed, onUnmounted, watch } from 'vue';
import { ChevronRight, ChevronDown, Copy, Check, Image as ImageIcon, File, Cpu, Eye, EyeOff } from 'lucide-vue-next';
import createDOMPurify from 'dompurify';
import { storageService } from '../services/storage';
import { useGlobalEvents } from '../composables/useGlobalEvents';
import { IMAGE_BLOCK_LANG, GeneratedImageBlockSchema, stripNaidanSentinels } from '../utils/image-generation';
import type { GeneratedImageBlock } from '../utils/image-generation';
import type { MessageNode } from '../models/types';

const DOMPurify = (() => {
  const t = typeof window;
  switch (t) {
  case 'undefined': return createDOMPurify();
  case 'object':
  case 'boolean':
  case 'string':
  case 'number':
  case 'function':
  case 'symbol':
  case 'bigint':
    return createDOMPurify(window);
  default: {
    const _ex: never = t;
    return _ex;
  }
  }
})();

const props = defineProps<{
  node: Readonly<MessageNode>;
  activeIds: Set<string>;
  highlight: boolean;
  isContentCollapsed?: boolean;
  isLast?: boolean;
  isRoot?: boolean;
  mode?: 'active' | 'tree' | 'compact';
  hasLinearParent?: boolean;
}>();

const emit = defineEmits<{
  (e: 'preview-attachment', objId: string): void;
  (e: 'select-node', node: Readonly<MessageNode>): void;
}>();

const { addErrorEvent } = useGlobalEvents();

const isExpanded = ref(true);
const isActive = computed(() => props.activeIds.has(props.node.id));

const isLocallyCollapsed = ref(false);
const finalIsCollapsed = computed(() => props.isContentCollapsed || isLocallyCollapsed.value);

// Human readable content preview
const isCopied = ref(false);
const copyContent = async () => {
  if (!props.node.content) return;
  await navigator.clipboard.writeText(props.node.content);
  isCopied.value = true;
  setTimeout(() => isCopied.value = false, 2000);
};

// JSON Processing (Escaping + Optional Highlighting + Sanitization)
const processJsonOutput = (json: string) => {
  // 1. First, encode everything as plain text by escaping HTML special chars
  const escaped = json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  let html = escaped;
  if (props.highlight) {
    // 2. Add spans for highlighting. Since we already escaped the input,
    // 'match' here cannot contain unescaped < or >.
    html = escaped.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, (match) => {
      let cls = 'text-blue-500 dark:text-blue-400';
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          cls = 'text-red-500 dark:text-red-400 opacity-80';
        } else {
          cls = 'text-green-600 dark:text-green-400';
        }
      } else if (/true|false/.test(match)) {
        cls = 'text-orange-500';
      } else if (/null/.test(match)) {
        cls = 'text-magenta-500';
      }
      return `<span class="${cls}">${match}</span>`;
    });
  }

  // 3. Finally, sanitize the result to be absolutely sure no XSS is possible.
  // We only allow span tags with class attributes.
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['span'],
    ALLOWED_ATTR: ['class']
  });
};

const jsonOutput = computed(() => {
  const cleanNode = { ...props.node, replies: undefined };
  const json = JSON.stringify(cleanNode, null, 2);
  return processJsonOutput(json);
});

const isoTimestamp = computed(() => {
  if (!props.node.timestamp) return '';
  try {
    return new Date(props.node.timestamp).toISOString();
  } catch {
    return '';
  }
});

const isLinear = computed(() => props.node.replies?.items?.length === 1);

// --- Image Extraction & Thumbnail Logic ---
const thumbnailUrls = ref<Record<string, string>>({});

const inlineImages = computed(() => {
  if (!props.node.content) return [];
  const images: GeneratedImageBlock[] = [];
  const regex = new RegExp('```' + IMAGE_BLOCK_LANG + '\\n([\\s\\S]*?)\\n```', 'g');
  let match;
  while ((match = regex.exec(props.node.content)) !== null) {
    const jsonStr = match[1];
    if (!jsonStr) continue;
    try {
      const parsed = JSON.parse(jsonStr);
      const result = GeneratedImageBlockSchema.safeParse(parsed);
      if (result.success) {
        images.push(result.data);
      } else {
        console.warn('Failed to validate inline image schema in ChatDebugTreeNode:', result.error);
        addErrorEvent({
          source: 'ChatDebugTreeNode:inlineImages',
          message: 'Failed to validate generated image metadata.',
          details: result.error.message,
        });
      }
    } catch (e) {
      console.error('Failed to parse inline image JSON in ChatDebugTreeNode:', e);
      addErrorEvent({
        source: 'ChatDebugTreeNode:inlineImages',
        message: 'Failed to parse generated image metadata.',
        details: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return images;
});

const cleanContentCompact = computed(() => {
  if (!props.node.content) return '';
  const stripped = stripNaidanSentinels(props.node.content).trim();
  return stripped.slice(0, 50) + (stripped.length > 50 ? '...' : '');
});

async function loadThumbnails() {
  // 1. Load from attachments
  if (props.node.attachments) {
    for (const att of props.node.attachments) {
      if (att.mimeType.startsWith('image/') && !thumbnailUrls.value[att.binaryObjectId]) {
        try {
          const blob = await storageService.getFile(att.binaryObjectId);
          if (blob) {
            thumbnailUrls.value[att.binaryObjectId] = URL.createObjectURL(blob);
          }
        } catch (e) {
          console.error('Failed to load thumbnail:', e);
        }
      }
    }
  }

  // 2. Load from inline images
  for (const img of inlineImages.value) {
    if (!thumbnailUrls.value[img.binaryObjectId]) {
      try {
        const blob = await storageService.getFile(img.binaryObjectId);
        if (blob) {
          thumbnailUrls.value[img.binaryObjectId] = URL.createObjectURL(blob);
        }
      } catch (e) {
        console.error('Failed to load inline image:', e);
      }
    }
  }
}

function cleanupThumbnails() {
  Object.values(thumbnailUrls.value).forEach(url => URL.revokeObjectURL(url));
  thumbnailUrls.value = {};
}

watch([() => props.node.attachments, () => props.node.content], () => {
  loadThumbnails();
}, { immediate: true });

onUnmounted(() => {
  cleanupThumbnails();
});



defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<script lang="ts">
export default {
  name: 'ChatDebugTreeNode'
};
</script>

<template>
  <div class="relative group/node">
    <!-- Visual Guide Lines for Tree/Compact Mode -->
    <template v-if="!isRoot && mode !== 'active' && !hasLinearParent">
      <!-- Vertical line: top to bottom, bridges the margin gap -->
      <div
        class="absolute left-[-24px] top-0 w-px bg-gray-200 dark:bg-gray-800 transition-colors"
        :class="isLast ? 'h-4' : 'bottom-[-8px]'"
      ></div>
      <!-- Horizontal L-arm: exactly 24px wide to reach the node -->
      <div class="absolute left-[-24px] top-4 w-6 h-px bg-gray-200 dark:bg-gray-800 transition-colors"></div>
    </template>

    <!-- 1. Compact View (Visual Map Mode) -->
    <div
      v-if="mode === 'compact'"
      class="flex items-center gap-2 py-1 px-2 rounded-lg cursor-pointer mb-0.5 w-fit transition-colors"
      :class="isActive ? 'bg-indigo-500/5' : 'hover:bg-gray-100 dark:hover:bg-white/5'"
      @click="emit('select-node', node)"
    >
      <span
        class="font-black uppercase text-[7px] tracking-widest px-1 py-0.5 rounded-sm shrink-0 border border-gray-200 dark:border-white/10"
        :class="[
          node.role === 'user' ? 'text-blue-500' :
          node.role === 'assistant' ? 'text-emerald-500' : 'text-gray-400'
        ]"
      >
        {{ node.role }}
      </span>
      <span class="text-[9px] text-gray-500 dark:text-gray-400 truncate max-w-[300px] font-sans">
        {{ cleanContentCompact }}
      </span>
    </div>

    <!-- 2. Unified Detailed Block (Active / Detail Mode) -->
    <div
      v-else
      class="flex flex-col mb-4 bg-white dark:bg-gray-900/40 border border-gray-100 dark:border-white/5 rounded-2xl overflow-hidden transition-all duration-200"
      :class="isActive ? 'opacity-100 ring-1 ring-indigo-500/10' : 'opacity-80'"
    >
      <!-- Integrated Header -->
      <div
        class="flex items-center justify-between px-4 py-2.5 bg-gray-50/50 dark:bg-white/[0.02] border-b border-gray-100 dark:border-white/5 cursor-pointer"
        @click="isExpanded = !isExpanded"
      >
        <div class="flex items-center gap-3 overflow-hidden">
          <div class="w-3 flex justify-center shrink-0">
            <component :is="isExpanded ? ChevronDown : ChevronRight" class="w-3 h-3 text-gray-400" />
          </div>

          <span v-if="isoTimestamp" class="text-[8px] text-gray-400/60 font-mono whitespace-nowrap pr-2 border-r border-gray-200 dark:border-white/10 shrink-0">{{ isoTimestamp }}</span>

          <span
            class="font-black uppercase text-[8px] tracking-[0.15em] px-2 py-0.5 rounded-sm shrink-0 border"
            :class="[
              node.role === 'user' ? 'bg-blue-50 dark:bg-blue-500/10 border-blue-200/50 dark:border-blue-500/20 text-blue-600' :
              node.role === 'assistant' ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200/50 dark:border-emerald-500/20 text-emerald-600' :
              'bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-white/10 text-gray-400'
            ]"
          >
            {{ node.role }}
          </span>
          <div class="flex items-center gap-2 overflow-hidden">
            <span v-if="node.role === 'assistant' && node.modelId" class="flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-[8px] text-gray-400 font-bold border border-gray-200 dark:border-white/5 whitespace-nowrap">
              <Cpu class="w-2.5 h-2.5" />
              {{ node.modelId }}
            </span>
          </div>
        </div>
        <div class="flex items-center gap-4">
          <div v-if="node.replies?.items?.length && mode === 'tree'" class="flex items-center gap-1.5 ml-2">
            <span class="text-[8px] font-bold text-gray-300 dark:text-gray-600 uppercase tracking-tighter">{{ node.replies.items.length }} branches</span>
          </div>
          <button
            @click.stop="isLocallyCollapsed = !isLocallyCollapsed"
            class="p-1 rounded-md text-gray-300 hover:text-indigo-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-all"
            :title="finalIsCollapsed ? 'Show Content' : 'Collapse Content'"
          >
            <component :is="finalIsCollapsed ? EyeOff : Eye" class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <!-- Unified Body -->
      <div v-if="isExpanded" class="flex flex-col">
        <!-- Message Content & Attachments -->
        <div class="p-4 bg-transparent space-y-3">
          <!-- Textual Content Group (Collapsible) -->
          <div v-if="!finalIsCollapsed" class="space-y-3">
            <!-- Error Display -->
            <div v-if="node.error" class="p-3 bg-red-500/5 border border-red-500/20 rounded-xl text-[11px] text-red-600 dark:text-red-400 font-sans">
              <div class="font-black uppercase text-[8px] mb-1 opacity-70">Error</div>
              {{ node.error }}
            </div>

            <!-- Thinking Process -->
            <div v-if="node.thinking" class="p-3 bg-amber-500/5 border border-amber-500/10 rounded-xl text-[11px] text-amber-700 dark:text-amber-400/80 font-sans italic italic-custom">
              <div class="font-black uppercase text-[8px] not-italic mb-1 opacity-70">Thinking Process</div>
              {{ node.thinking }}
            </div>

            <!-- Text Content -->
            <div v-if="node.content" class="text-[12px] text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-all leading-relaxed font-sans max-h-[600px] overflow-y-auto thin-scrollbar pr-2 relative group/content">
              <button
                @click.stop="copyContent"
                data-testid="copy-content-btn"
                class="absolute right-0 top-0 p-1.5 text-gray-400 hover:text-indigo-500 opacity-0 group-hover/content:opacity-100 transition-opacity bg-white/80 dark:bg-gray-800/80 rounded-md"
              >
                <Check v-if="isCopied" class="w-3.5 h-3.5 text-green-500" />
                <Copy v-else class="w-3.5 h-3.5" />
              </button>
              {{ node.content }}
            </div>
          </div>
          <div v-else-if="node.content || node.thinking || node.error" class="px-3 py-1.5 rounded-lg bg-gray-50/30 dark:bg-white/[0.01] border border-dashed border-gray-200 dark:border-white/5">
            <span class="text-[9px] font-bold text-gray-400 uppercase tracking-widest italic opacity-60">Text content hidden</span>
          </div>

          <!-- Non-collapsible visual elements (Images/Attachments) -->
          <template v-if="inlineImages.length > 0 || (node.attachments && node.attachments.length)">
            <!-- Inline Generated Images -->
            <div v-if="inlineImages.length > 0" class="mt-4 space-y-4">
              <div v-for="img in inlineImages" :key="img.binaryObjectId" class="relative group/inline-img max-w-full overflow-hidden">
                <div class="text-[8px] font-black uppercase tracking-[0.2em] text-gray-400 mb-2 flex items-center gap-2">
                  <ImageIcon class="w-3 h-3" />
                  <span>Generated Image Reference</span>
                </div>
                <div
                  @click.stop="emit('preview-attachment', img.binaryObjectId)"
                  class="rounded-xl overflow-hidden border border-gray-100 dark:border-white/5 cursor-pointer bg-gray-100/30 dark:bg-white/5 flex items-center justify-center w-fit max-w-full shadow-sm hover:shadow-md transition-shadow"
                >
                  <img
                    v-if="thumbnailUrls[img.binaryObjectId]"
                    :src="thumbnailUrls[img.binaryObjectId]"
                    class="max-h-[300px] object-contain block"
                    :style="{ width: img.displayWidth + 'px', maxWidth: '100%' }"
                  />
                  <div v-else class="p-8 flex flex-col items-center gap-2">
                    <ImageIcon class="w-6 h-6 text-gray-300 animate-pulse" />
                  </div>
                </div>
                <div v-if="img.prompt" class="mt-1.5 text-[10px] text-gray-500 dark:text-gray-400 italic px-3 border-l-2 border-indigo-500/30 font-sans">
                  "{{ img.prompt }}"
                </div>
              </div>
            </div>

            <div v-if="node.attachments && node.attachments.length" class="mt-4 flex flex-wrap gap-2">
              <div
                v-for="att in node.attachments"
                :key="att.id"
                @click.stop="emit('preview-attachment', att.binaryObjectId)"
                class="relative w-14 h-14 rounded-xl overflow-hidden border border-gray-100 dark:border-white/5 cursor-pointer bg-gray-100/30 dark:bg-white/5 flex items-center justify-center group/att"
              >
                <img v-if="thumbnailUrls[att.binaryObjectId]" :src="thumbnailUrls[att.binaryObjectId]" class="w-full h-full object-cover" />
                <div v-else class="flex flex-col items-center justify-center gap-1">
                  <ImageIcon v-if="att.mimeType.startsWith('image/')" class="w-4 h-4 text-gray-400" />
                  <File v-else class="w-4 h-4 text-gray-400" />
                </div>
                <div class="absolute bottom-0 inset-x-0 bg-black/40 text-[7px] text-white px-1 py-0.5 truncate text-center font-bold backdrop-blur-sm">
                  {{ att.mimeType.split('/')[1] }}
                </div>
              </div>
            </div>
          </template>
        </div>

        <!-- Integrated JSON -->
        <div class="p-4 bg-gray-50/20 dark:bg-black/10 border-t border-gray-100 dark:border-white/5">
          <pre
            class="text-[10px] overflow-x-auto text-gray-500 dark:text-gray-400 leading-tight font-mono max-h-48 thin-scrollbar"
            v-html="jsonOutput"
          ></pre>
        </div>
      </div>
    </div>

    <!-- Recursive Children -->
    <div
      v-if="node.replies?.items?.length && isExpanded && mode === 'tree'"
      class="mt-0 space-y-1"
      :class="isLinear ? 'ml-0' : 'ml-6'"
    >
      <ChatDebugTreeNode
        v-for="(child, index) in node.replies.items"
        :key="child.id"
        :node="child"
        :active-ids="activeIds"
        :highlight="highlight"
        :is-last="index === node.replies.items.length - 1"
        :mode="mode"
        :has-linear-parent="isLinear"
        @preview-attachment="id => emit('preview-attachment', id)"
        @select-node="n => emit('select-node', n)"
      />
    </div>

    <!-- Recursive Children (Compact) -->
    <div
      v-if="node.replies?.items?.length && mode === 'compact'"
      class="mt-0"
      :class="isLinear ? 'ml-0' : 'ml-6'"
    >
      <ChatDebugTreeNode
        v-for="(child, index) in node.replies.items"
        :key="child.id"
        :node="child"
        :active-ids="activeIds"
        :highlight="highlight"
        :is-last="index === node.replies.items.length - 1"
        :mode="mode"
        :has-linear-parent="isLinear"
        @select-node="n => emit('select-node', n)"
        @preview-attachment="id => emit('preview-attachment', id)"
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
