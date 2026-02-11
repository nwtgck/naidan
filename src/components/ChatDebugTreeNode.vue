<script setup lang="ts">
import { ref, computed, onUnmounted, watch } from 'vue';
import { ChevronRight, ChevronDown, Copy, Check, Image as ImageIcon, File, Cpu } from 'lucide-vue-next';
import { storageService } from '../services/storage';
import type { MessageNode } from '../models/types';

const props = defineProps<{
  node: Readonly<MessageNode>;
  activeIds: Set<string>;
  highlight: boolean;
  isLast?: boolean;
  isRoot?: boolean;
  mode?: 'active' | 'tree' | 'compact';
  hasLinearParent?: boolean;
}>();

const emit = defineEmits<{
  (e: 'preview-attachment', objId: string): void;
  (e: 'select-node', node: Readonly<MessageNode>): void;
}>();

const isExpanded = ref(true);
const isActive = computed(() => props.activeIds.has(props.node.id));

// Human readable content preview
const isCopied = ref(false);
const copyContent = async () => {
  if (!props.node.content) return;
  await navigator.clipboard.writeText(props.node.content);
  isCopied.value = true;
  setTimeout(() => isCopied.value = false, 2000);
};

// JSON Highlighting
const highlightJson = (json: string) => {
  if (!props.highlight) return json;
  return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, (match) => {
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
};

const jsonOutput = computed(() => {
  const cleanNode = { ...props.node, replies: undefined };
  const json = JSON.stringify(cleanNode, null, 2);
  return props.highlight ? highlightJson(json) : json;
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

// --- Thumbnail Logic ---
const thumbnailUrls = ref<Record<string, string>>({});

async function loadThumbnails() {
  if (!props.node.attachments) return;
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

function cleanupThumbnails() {
  Object.values(thumbnailUrls.value).forEach(url => URL.revokeObjectURL(url));
  thumbnailUrls.value = {};
}

watch(() => props.node.attachments, (newAtts) => {
  cleanupThumbnails();
  if (newAtts) loadThumbnails();
}, { immediate: true });

onUnmounted(() => {
  cleanupThumbnails();
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
        {{ node.content?.slice(0, 50) }}{{ node.content?.length > 50 ? '...' : '' }}
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
        <div v-if="node.replies?.items?.length && mode === 'tree'" class="flex items-center gap-1.5 ml-2">
          <span class="text-[8px] font-bold text-gray-300 dark:text-gray-600 uppercase tracking-tighter">{{ node.replies.items.length }} branches</span>
        </div>
      </div>

      <!-- Unified Body -->
      <div v-if="isExpanded" class="flex flex-col">
        <!-- Message Content & Attachments -->
        <div class="p-4 bg-transparent space-y-3">
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
