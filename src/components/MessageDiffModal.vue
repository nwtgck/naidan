<script setup lang="ts">
import { computed, ref } from 'vue';
import { X, History, Clock, Cpu, ArrowDown, Copy, Check, ArrowRight, XCircle } from 'lucide-vue-next';
import type { MessageNode } from '../models/types';
import { computeWordDiff, type DiffPart } from '../utils/diff';

const props = defineProps<{
  isOpen: boolean;
  siblings: MessageNode[];
  currentMessageId: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

type DiffVisibility = 'visible' | 'hidden';
const diffVisibility = ref<DiffVisibility>('visible');

const baseVersionId = ref<string | undefined>(undefined);
const targetVersionId = ref<string | undefined>(undefined);

interface VersionItem {
  id: string;
  versionNumber: number;
  content: string;
  modelId: string | undefined;
  timestamp: number;
}

const versionItems = computed((): VersionItem[] => {
  return props.siblings.map((msg, i) => ({
    id: msg.id,
    versionNumber: i + 1,
    content: msg.content,
    modelId: msg.modelId,
    timestamp: msg.timestamp,
  }));
});

const customDiff = computed(() => {
  if (!baseVersionId.value || !targetVersionId.value) return null;
  const base = versionItems.value.find(v => v.id === baseVersionId.value);
  const target = versionItems.value.find(v => v.id === targetVersionId.value);
  if (!base || !target) return null;

  return {
    base,
    target,
    parts: computeWordDiff({ oldText: base.content, newText: target.content })
  };
});

interface SequentialDiff {
  id: string;
  versionNumber: number;
  timestamp: number;
  modelId: string | undefined;
  content: string;
  diffParts: DiffPart[];
  isCurrent: boolean;
}

const copiedId = ref<string | undefined>(undefined);

const sequentialDiffs = computed(() => {
  const result: SequentialDiff[] = [];

  for (let i = 0; i < props.siblings.length; i++) {
    const msg = props.siblings[i]!;
    const prevMsg = i > 0 ? props.siblings[i - 1] : null;

    const diffParts = prevMsg
      ? computeWordDiff({ oldText: prevMsg.content, newText: msg.content })
      : [{ type: 'unchanged', value: msg.content } as DiffPart];

    result.push({
      id: msg.id,
      versionNumber: i + 1,
      timestamp: msg.timestamp,
      modelId: msg.modelId,
      content: msg.content,
      diffParts,
      isCurrent: msg.id === props.currentMessageId,
    });
  }

  return result.reverse(); // Show latest first
});

async function handleCopy({ id, content }: { id: string, content: string }) {
  try {
    await navigator.clipboard.writeText(content);
    copiedId.value = id;
    setTimeout(() => {
      if (copiedId.value === id) copiedId.value = undefined;
    }, 2000);
  } catch (err) {
    console.error('Failed to copy version content:', err);
  }
}

function formatDate({ timestamp }: { timestamp: number }): string {
  return new Date(timestamp).toLocaleString();
}

function handleClose() {
  emit('close');
}

function clearSelection() {
  baseVersionId.value = undefined;
  targetVersionId.value = undefined;
}

defineExpose({
  __testOnly: {}
});
</script>

<template>
  <Transition name="modal">
    <div v-if="isOpen" class="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 md:p-6" @click.self="handleClose">
      <div class="bg-white dark:bg-gray-900 rounded-3xl shadow-2xl w-full max-w-5xl h-[90vh] flex flex-col border border-gray-100 dark:border-gray-800 modal-content-zoom overflow-hidden">

        <!-- Header -->
        <div class="px-6 py-5 border-b border-gray-100 dark:border-gray-800 shrink-0 bg-white dark:bg-gray-900 z-10 flex items-center justify-between">
          <div class="flex items-center gap-4">
            <div class="p-2.5 bg-blue-500/10 rounded-xl border border-blue-200 dark:border-blue-500/20">
              <History class="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <h2 class="text-base font-bold text-gray-800 dark:text-white tracking-tight">Message History & Compare</h2>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 font-medium">Select versions to compare differences</p>
            </div>
          </div>
          <div class="flex items-center gap-6">
            <!-- Diff Toggle -->
            <div class="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 p-1 rounded-xl">
              <button
                @click="diffVisibility = 'visible'"
                class="px-3 py-1 text-[9px] font-bold uppercase tracking-widest rounded-lg transition-all"
                :class="diffVisibility === 'visible' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
              >
                Diff On
              </button>
              <button
                @click="diffVisibility = 'hidden'"
                class="px-3 py-1 text-[9px] font-bold uppercase tracking-widest rounded-lg transition-all"
                :class="diffVisibility === 'hidden' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
              >
                Off
              </button>
            </div>

            <div class="flex items-center gap-3">
              <button
                v-if="baseVersionId || targetVersionId"
                @click="clearSelection"
                class="flex items-center gap-2 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
              >
                <XCircle class="w-3.5 h-3.5" />
                <span>Clear Selection</span>
              </button>              <button @click="handleClose" class="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors">
                <X class="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>

        <!-- Main Scrollable Area -->
        <div class="flex-1 overflow-y-auto bg-gray-50/30 dark:bg-black/10">

          <!-- Sticky Custom Diff Panel (shown when both are selected) -->
          <div
            v-if="customDiff"
            class="sticky top-0 z-20 p-6 bg-gray-50/90 dark:bg-gray-950/90 backdrop-blur-md border-b border-blue-100 dark:border-blue-900/30 shadow-lg animate-in fade-in slide-in-from-top-2 duration-300"
          >
            <div class="bg-white dark:bg-gray-900 rounded-2xl border border-blue-200 dark:border-blue-800 shadow-xl overflow-hidden flex flex-col max-h-[40vh]">
              <div class="px-5 py-2.5 border-b border-gray-50 dark:border-gray-800 bg-blue-50/30 dark:bg-blue-900/20 flex items-center justify-between">
                <div class="flex items-center gap-3 text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                  <span class="text-blue-600 dark:text-blue-400">Comparing Base v{{ customDiff.base.versionNumber }}</span>
                  <ArrowRight class="w-3 h-3" />
                  <span class="text-green-600 dark:text-green-400">Target v{{ customDiff.target.versionNumber }}</span>
                </div>
                <button
                  @click="handleCopy({ id: customDiff.target.id, content: customDiff.target.content })"
                  class="flex items-center gap-2 px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-gray-400 hover:text-blue-600 transition-colors"
                >
                  <Check v-if="copiedId === customDiff.target.id" class="w-3.5 h-3.5 text-green-500" />
                  <Copy v-else class="w-3.5 h-3.5" />
                  <span>Copy Result</span>
                </button>
              </div>
              <div class="p-5 overflow-y-auto font-mono text-sm leading-relaxed whitespace-pre-wrap break-words dark:text-gray-200">
                <template v-if="diffVisibility === 'visible'">
                  <template v-for="(part, pIdx) in customDiff.parts" :key="pIdx">
                    <span
                      v-if="part.type === 'added'"
                      class="bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 rounded-sm px-0.5"
                    >{{ part.value }}</span>
                    <span
                      v-else-if="part.type === 'removed'"
                      class="bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400 line-through rounded-sm px-0.5"
                    >{{ part.value }}</span>
                    <span v-else class="text-gray-700 dark:text-gray-300">{{ part.value }}</span>
                  </template>
                </template>
                <template v-else>
                  {{ customDiff.target.content }}
                </template>
              </div>
            </div>
          </div>

          <!-- Version List -->
          <div class="p-6 space-y-8">
            <div v-for="(diff, index) in sequentialDiffs" :key="diff.id" class="relative">
              <!-- Version Card -->
              <div
                class="bg-white dark:bg-gray-900 rounded-2xl border transition-all shadow-sm group/card"
                :class="[
                  diff.isCurrent ? 'ring-2 ring-blue-500/10' : '',
                  baseVersionId === diff.id ? 'border-blue-500 bg-blue-50/5 dark:bg-blue-900/5' :
                  targetVersionId === diff.id ? 'border-green-500 bg-green-50/5 dark:bg-green-900/5' :
                  'border-gray-100 dark:border-gray-800'
                ]"
              >
                <!-- Card Header -->
                <div class="px-5 py-3 border-b border-gray-50 dark:border-gray-800 flex items-center justify-between bg-gray-50/50 dark:bg-gray-800/30">
                  <div class="flex items-center gap-3">
                    <span
                      class="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest"
                      :class="diff.isCurrent ? 'bg-blue-600 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400'"
                    >
                      v{{ diff.versionNumber }}
                    </span>
                    <div class="flex items-center gap-1.5 text-[10px] font-medium text-gray-400">
                      <Clock class="w-3 h-3" />
                      {{ formatDate({ timestamp: diff.timestamp }) }}
                    </div>
                  </div>

                  <div class="flex items-center gap-2">
                    <div v-if="diff.modelId" class="hidden sm:flex items-center gap-1.5 text-[10px] font-bold text-gray-400 tracking-widest mr-2">
                      <Cpu class="w-3 h-3" />
                      {{ diff.modelId }}
                    </div>
                    <!-- Comparison Selectors -->
                    <div class="flex items-center gap-1 bg-gray-100/50 dark:bg-black/20 p-0.5 rounded-lg mr-1">
                      <button
                        @click="baseVersionId = baseVersionId === diff.id ? undefined : diff.id"
                        class="px-2 py-1 text-[9px] font-black uppercase tracking-tighter rounded transition-all"
                        :class="baseVersionId === diff.id ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-blue-600'"
                      >
                        Base
                      </button>
                      <button
                        @click="targetVersionId = targetVersionId === diff.id ? undefined : diff.id"
                        class="px-2 py-1 text-[9px] font-black uppercase tracking-tighter rounded transition-all"
                        :class="targetVersionId === diff.id ? 'bg-green-600 text-white' : 'text-gray-400 hover:text-green-600'"
                      >
                        Target
                      </button>
                    </div>

                    <button
                      @click="handleCopy({ id: diff.id, content: diff.content })"
                      class="p-1.5 text-gray-400 hover:text-blue-600 rounded-lg hover:bg-white dark:hover:bg-gray-800 transition-colors"
                      :title="copiedId === diff.id ? 'Copied!' : 'Copy this version'"
                    >
                      <Check v-if="copiedId === diff.id" class="w-3.5 h-3.5 text-green-500" />
                      <Copy v-else class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <!-- Content Area (Default shows sequential diff) -->
                <div class="p-5 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words dark:text-gray-300">
                  <template v-if="diffVisibility === 'visible'">
                    <template v-for="(part, pIdx) in diff.diffParts" :key="pIdx">
                      <span
                        v-if="part.type === 'added'"
                        class="bg-green-50/50 dark:bg-green-900/20 text-green-700/80 dark:text-green-400/80 rounded px-0.5"
                      >{{ part.value }}</span>
                      <span
                        v-else-if="part.type === 'removed'"
                        class="bg-red-50/50 dark:bg-red-900/20 text-red-700/80 dark:text-red-400/80 line-through rounded px-0.5"
                      >{{ part.value }}</span>
                      <span v-else class="text-gray-700/80 dark:text-gray-400/80">{{ part.value }}</span>
                    </template>
                  </template>
                  <template v-else>
                    {{ diff.content }}
                  </template>
                </div>
              </div>

              <!-- Connector Arrow -->
              <div v-if="index < sequentialDiffs.length - 1" class="flex justify-center -my-3 relative z-10">
                <div class="bg-gray-100 dark:bg-gray-800 p-1.5 rounded-full border border-gray-200 dark:border-gray-700 text-gray-400 shadow-sm">
                  <ArrowDown class="w-4 h-4" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="px-6 py-4 border-t border-gray-100 dark:border-gray-800 flex justify-end bg-white dark:bg-gray-900 shrink-0">
          <button @click="handleClose" class="px-8 py-2.5 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 rounded-2xl font-bold text-[11px] uppercase tracking-widest hover:bg-gray-200 dark:hover:bg-gray-700 transition-all active:scale-95">
            Close
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

::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: rgba(156, 163, 175, 0.2);
  border-radius: 10px;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(156, 163, 175, 0.4);
}

.animate-in {
  animation-fill-mode: forwards;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes slide-in-from-top {
  from { transform: translateY(-1rem); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
.fade-in {
  animation-name: fade-in;
}
.slide-in-from-top-2 {
  animation-name: slide-in-from-top;
}
</style>
