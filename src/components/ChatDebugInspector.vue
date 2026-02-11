<script setup lang="ts">
import { ref, computed } from 'vue';
import { Bug, X, MessageSquare, Network, FileCode, Highlighter, ZapOff, ChevronLeft, ChevronRight } from 'lucide-vue-next';
import ChatDebugTreeNode from './ChatDebugTreeNode.vue';
import BinaryObjectPreviewModal from './BinaryObjectPreviewModal.vue';
import { storageService } from '../services/storage';
import type { BinaryObject, MessageNode } from '../models/types';

const props = defineProps<{
  show: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chat: any; // Using any to avoid deep readonly incompatibility with store output
  activeMessages: ReadonlyArray<MessageNode>;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const mode = ref<'active' | 'tree' | 'raw'>('active');
const isHighlightEnabled = ref(true);
const selectedNode = ref<Readonly<MessageNode> | null>(null);
const isTreeMapCollapsed = ref(false);

const activeIds = computed(() => new Set(props.activeMessages.map(m => m.id)));

function handleSelectNode(node: Readonly<MessageNode>) {
  selectedNode.value = node;
}

// Calculate the path from root to the selected node
const selectedPath = computed(() => {
  if (!selectedNode.value) return [];
  const path: MessageNode[] = [];
  const targetId = selectedNode.value.id;
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const findPath = (items: ReadonlyArray<any>, currentPath: MessageNode[]): boolean => {
    for (const item of items) {
      if (item.id === targetId) {
        path.push(...currentPath, item as MessageNode);
        return true;
      }
      if (item.replies?.items?.length) {
        if (findPath(item.replies.items, [...currentPath, item as MessageNode])) return true;
      }
    }
    return false;
  };

  if (props.chat?.root?.items) {
    findPath(props.chat.root.items, []);
  }
  return path;
});

// Attachment Preview Logic
const previewObjects = ref<BinaryObject[]>([]);
const previewInitialId = ref<string | null>(null);

async function handlePreviewAttachment(binaryObjectId: string) {
  const obj = await storageService.getBinaryObject({ binaryObjectId });
  if (obj) {
    previewObjects.value = [obj];
    previewInitialId.value = obj.id;
  }
}

function handleClose() {
  emit('close');
}

// Simple highlighter for the raw JSON view
const highlightJson = (json: string) => {
  if (!isHighlightEnabled.value) return json;
  return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, (match) => {
    let cls = 'text-blue-500 dark:text-blue-400'; // number
    if (/^"/.test(match)) {
      if (/:$/.test(match)) {
        cls = 'text-red-500 dark:text-red-400 font-bold'; // key
      } else {
        cls = 'text-green-600 dark:text-green-400'; // string
      }
    } else if (/true|false/.test(match)) {
      cls = 'text-orange-500';
    } else if (/null/.test(match)) {
      cls = 'text-magenta-500';
    }
    return `<span class="${cls}">${match}</span>`;
  });
};

const rawJsonOutput = computed(() => {
  const m = mode.value;
  switch (m) {
  case 'active':
  case 'tree':
    return '';
  case 'raw': {
    const json = JSON.stringify(props.chat, null, 2);
    return isHighlightEnabled.value ? highlightJson(json) : json;
  }
  default: {
    const _ex: never = m;
    throw new Error(`Unhandled mode: ${_ex}`);
  }
  }
});
</script>

<template>
  <Transition name="modal">
    <div
      v-if="show"
      class="fixed inset-0 z-[100] flex items-center justify-center p-2 bg-black/60 backdrop-blur-sm focus:outline-none"
      @click.self="handleClose"
      @keydown.esc="handleClose"
      tabindex="-1"
      data-testid="chat-inspector"
    >
      <div class="bg-white dark:bg-gray-900 rounded-[24px] shadow-2xl max-w-7xl w-full h-[98vh] flex flex-col overflow-hidden border border-gray-100 dark:border-white/5 modal-content-zoom font-mono text-xs">
        <!-- Header -->
        <div class="px-6 py-4 flex justify-between items-center bg-gray-50/50 dark:bg-white/5 border-b border-gray-100 dark:border-white/5 shrink-0">
          <div class="flex items-center gap-3">
            <div class="p-2 bg-indigo-500/10 rounded-xl">
              <Bug class="w-5 h-5 text-indigo-500" />
            </div>
            <div>
              <h3 class="text-base font-black text-gray-800 dark:text-white tracking-tight">Chat Inspector</h3>
              <p class="text-[9px] text-gray-400 uppercase tracking-widest font-black">Data Explorer</p>
            </div>
          </div>

          <div class="flex items-center gap-4">
            <!-- Mode Switcher -->
            <div class="flex bg-gray-100 dark:bg-gray-800 rounded-xl p-1 shadow-inner">
              <button 
                v-for="m in ([{id: 'active', icon: MessageSquare, label: 'Active'}, {id: 'tree', icon: Network, label: 'Tree'}, {id: 'raw', icon: FileCode, label: 'Full JSON'}] as const)"
                :key="m.id"
                @click="mode = m.id"
                class="px-4 py-1.5 rounded-lg transition-all flex items-center gap-2 font-black uppercase text-[9px] tracking-wider"
                :class="mode === m.id ? 'bg-white dark:bg-gray-700 shadow-sm text-indigo-500' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-200'"
              >
                <component :is="m.icon" class="w-3 h-3" />
                <span>{{ m.label }}</span>
              </button>
            </div>

            <!-- Global Highlighting Toggle -->
            <button 
              @click="isHighlightEnabled = !isHighlightEnabled"
              class="p-2 rounded-xl border transition-all flex items-center gap-2 hover:scale-105 active:scale-95"
              :class="isHighlightEnabled ? 'bg-indigo-500/10 border-indigo-500/20 text-indigo-500' : 'bg-gray-100 dark:bg-gray-800 border-transparent text-gray-400'"
              title="Toggle Highlighting"
            >
              <component :is="isHighlightEnabled ? Highlighter : ZapOff" class="w-4 h-4" />
            </button>

            <div class="w-px h-6 bg-gray-200 dark:bg-white/10 mx-1"></div>

            <button @click="handleClose" class="p-2 rounded-xl text-gray-400 hover:text-red-500 hover:bg-red-500/10 transition-all active:scale-90">
              <X class="w-6 h-6" />
            </button>
          </div>
        </div>

        <!-- Content Area (Lazy) -->
        <div class="flex-1 overflow-hidden bg-white dark:bg-gray-950 flex">
          
          <!-- Tab 1: Active Thread (Direct List) -->
          <div v-if="mode === 'active'" class="flex-1 overflow-y-auto p-6 space-y-2 max-w-4xl mx-auto thin-scrollbar">
            <ChatDebugTreeNode 
              v-for="m in activeMessages" 
              :key="m.id"
              :node="{ ...m, replies: { items: [] } }"
              :active-ids="activeIds"
              :highlight="isHighlightEnabled"
              :is-last="true"
              mode="active"
              @preview-attachment="handlePreviewAttachment"
            />
          </div>

          <!-- Tab 2: Tree Structure (Split View) -->
          <div v-else-if="mode === 'tree'" class="flex-1 flex overflow-hidden">
            <!-- Left: Visual Map -->
            <div 
              class="relative overflow-y-auto border-r border-gray-100 dark:border-white/5 thin-scrollbar bg-gray-50/10 dark:bg-white/[0.005] transition-all duration-300 ease-in-out"
              :class="isTreeMapCollapsed ? 'w-12 p-2 overflow-x-hidden' : 'w-[45%] p-8'"
            >
              <!-- Collapse Toggle -->
              <button 
                @click="isTreeMapCollapsed = !isTreeMapCollapsed"
                class="absolute right-2 top-2 p-1.5 rounded-lg text-gray-400 hover:text-indigo-500 hover:bg-white dark:hover:bg-gray-800 transition-all z-20"
                :title="isTreeMapCollapsed ? 'Expand Tree' : 'Collapse Tree'"
              >
                <component :is="isTreeMapCollapsed ? ChevronRight : ChevronLeft" class="w-4 h-4" />
              </button>

              <div v-if="!isTreeMapCollapsed && chat?.root?.items" class="relative" :class="chat.root.items.length > 1 ? 'ml-6' : ''">
                <ChatDebugTreeNode 
                  v-for="(node, index) in chat.root.items" 
                  :key="node.id" 
                  :node="node" 
                  :active-ids="activeIds"
                  :highlight="isHighlightEnabled"
                  :is-last="index === chat.root.items.length - 1"
                  :is-root="chat.root.items.length <= 1"
                  mode="compact"
                  @preview-attachment="handlePreviewAttachment"
                  @select-node="handleSelectNode"
                />
              </div>
              <div v-else class="h-full flex flex-col items-center pt-12 text-gray-300">
                <Network class="w-4 h-4 opacity-30" />
              </div>
            </div>

            <!-- Right: Detail Panel -->
            <div class="flex-1 overflow-y-auto p-8 thin-scrollbar">
              <div v-if="selectedPath.length > 0" class="space-y-4">
                <div v-if="selectedPath.length > 1" class="mb-8 border-b border-gray-100 dark:border-white/5 pb-4">
                  <span class="text-[9px] font-black uppercase tracking-widest text-gray-400">Context Path</span>
                </div>
                <ChatDebugTreeNode 
                  v-for="m in selectedPath"
                  :key="m.id"
                  :node="{ ...m, replies: { items: [] } }"
                  :active-ids="activeIds"
                  :highlight="isHighlightEnabled"
                  :is-root="true"
                  mode="active"
                  @preview-attachment="handlePreviewAttachment"
                />
              </div>
              <div v-else class="h-full flex flex-col items-center justify-center text-gray-400 opacity-30">
                <Network class="w-16 h-16 mb-4 stroke-[0.5px]" />
                <p class="text-[10px] font-black uppercase tracking-[0.2em]">Select a node to inspect</p>
              </div>
            </div>
          </div>

          <!-- Tab 3: Full JSON -->
          <div v-else-if="mode === 'raw'" class="flex-1 p-6 overflow-hidden">
            <pre 
              class="bg-gray-50/50 dark:bg-black/40 p-6 rounded-2xl border border-gray-100 dark:border-white/5 text-[11px] overflow-auto h-full text-gray-700 dark:text-gray-300 leading-relaxed font-mono thin-scrollbar"
              v-html="rawJsonOutput"
            ></pre>
          </div>

        </div>
      </div>

      <!-- Attachment Preview Modal -->
      <BinaryObjectPreviewModal
        v-if="previewInitialId"
        :objects="previewObjects"
        :initial-id="previewInitialId"
        @close="previewInitialId = null"
      />
    </div>
  </Transition>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.modal-enter-active .modal-content-zoom,
.modal-leave-active .modal-content-zoom {
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-content-zoom,
.modal-leave-to .modal-content-zoom {
  transform: scale(0.98) translateY(10px);
  opacity: 0;
}

.thin-scrollbar::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.thin-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.thin-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(156, 163, 175, 0.2);
  border-radius: 10px;
}
.thin-scrollbar::-webkit-scrollbar-thumb:hover {
  background: rgba(156, 163, 175, 0.4);
}
</style>
