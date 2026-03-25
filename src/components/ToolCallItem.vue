<script setup lang="ts">
import { Hammer, CheckCircle2, AlertCircle, ChevronDown, ChevronUp, Loader2 } from 'lucide-vue-next';
import { ref, watch, onMounted, nextTick, inject, computed, markRaw } from 'vue';
import type { CombinedToolCall } from '@/models/types';
import { storageService } from '@/services/storage';
import ShellExecuteToolCall from './ShellExecuteToolCall.vue';

const props = defineProps<{
  toolCall: CombinedToolCall;
}>();

const inSequence = inject<boolean>('inSequence', false);

type DetailState = 'collapsed' | 'preview' | 'expanded';

// Inside a sequence: start in preview (height-limited).
// Outside a sequence: start expanded (original behaviour).
const detailState = ref<DetailState>(inSequence ? 'preview' : 'expanded');

const isDetailVisible = computed(() => detailState.value !== 'collapsed');
const isPreview = computed(() => detailState.value === 'preview');

const detailsRef = ref<HTMLElement | null>(null);
const isPreviewOverflowing = ref(false);

const binaryContent = ref<string | null>(null);
const isLoadingBinary = ref(false);

const resolveBinary = async () => {
  const result = props.toolCall.result;
  let binaryId: string | null = null;

  if (result.status === 'success' && result.content.type === 'binary_object') {
    binaryId = result.content.id;
  } else if (result.status === 'error' && result.error.message.type === 'binary_object') {
    binaryId = result.error.message.id;
  }

  if (binaryId && !binaryContent.value && !isLoadingBinary.value) {
    isLoadingBinary.value = true;
    try {
      const blob = await storageService.getFile(binaryId);
      if (blob) {
        binaryContent.value = await blob.text();
      }
    } catch (e) {
      console.error('Failed to load binary tool content:', e);
      binaryContent.value = '[Error: Failed to load content]';
    } finally {
      isLoadingBinary.value = false;
    }
  }
};

function checkPreviewOverflow() {
  if (!detailsRef.value || detailState.value !== 'preview') {
    isPreviewOverflowing.value = false;
    return;
  }
  isPreviewOverflowing.value = detailsRef.value.scrollHeight > detailsRef.value.clientHeight;
}

watch(() => props.toolCall.result, resolveBinary, { immediate: true });
watch([binaryContent, isLoadingBinary], async () => {
  await nextTick();
  checkPreviewOverflow();
});
watch(detailState, async () => {
  await nextTick();
  checkPreviewOverflow();
});
onMounted(async () => {
  await resolveBinary();
  await nextTick();
  checkPreviewOverflow();
});

// Header click: collapse if visible, expand (skip preview) if collapsed.
function handleHeaderClick() {
  switch (detailState.value) {
  case 'collapsed':
    detailState.value = 'expanded';
    break;
  case 'preview':
  case 'expanded':
    detailState.value = 'collapsed';
    break;
  default: {
    const _ex: never = detailState.value;
    throw new Error(`Unhandled detail state: ${_ex}`);
  }
  }
}

// Returns a specialized display component for known tool names, or null to use generic rendering.
const specializedContent = computed(() => {
  switch (props.toolCall.call.function.name) {
  case 'shell_execute': return markRaw(ShellExecuteToolCall);
  default: return null;
  }
});

// Content area click in preview: expand fully.
function handlePreviewClick() {
  detailState.value = 'expanded';
}

const formatArgs = ({ args }: { args: string | Record<string, unknown> }): string => {
  if (typeof args === 'string') {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch (e) {
      return args;
    }
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch (e) {
    return String(args);
  }
};

defineExpose({
  __testOnly: {
    detailState,
    handleHeaderClick,
    handlePreviewClick,
    // Backward compat for existing tests
    isExpanded: isDetailVisible,
    toggleExpand: handleHeaderClick,
  }
});
</script>

<template>
  <div
    class="group/tool border rounded-xl overflow-hidden transition-all duration-300 shadow-sm mb-2 last:mb-0"
    :class="[
      toolCall.result.status === 'executing' ? 'bg-blue-50/20 border-blue-100/30 dark:bg-blue-900/10 dark:border-blue-800/20' : '',
      toolCall.result.status === 'success' ? 'bg-white/50 dark:bg-gray-800/30 border-gray-100/50 dark:border-gray-700/30' : '',
      toolCall.result.status === 'error' ? 'bg-red-50/20 border-red-100/30 dark:bg-red-900/10 dark:border-red-800/20' : ''
    ]"
    data-testid="lm-tool-call"
  >
    <!-- Tool Header -->
    <div
      @click="handleHeaderClick"
      class="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
    >
      <div class="flex items-center gap-2.5">
        <div class="p-1 rounded-lg" :class="[
          toolCall.result.status === 'executing' ? 'bg-blue-100/50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : '',
          toolCall.result.status === 'success' ? 'bg-gray-100 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400' : '',
          toolCall.result.status === 'error' ? 'bg-red-100/50 dark:bg-red-900/30 text-red-600 dark:text-red-400' : ''
        ]">
          <Hammer v-if="toolCall.result.status === 'executing'" class="w-3 h-3 animate-bounce" />
          <CheckCircle2 v-else-if="toolCall.result.status === 'success'" class="w-3 h-3" />
          <AlertCircle v-else class="w-3 h-3" />
        </div>

        <div class="flex flex-col">
          <span class="text-[10px] font-bold capitalize tracking-wider" :class="[
            toolCall.result.status === 'executing' ? 'text-blue-700 dark:text-blue-300' : 'text-gray-500 dark:text-gray-400'
          ]">
            {{ toolCall.call.function.name }}
          </span>
          <span v-if="toolCall.result.status === 'executing'" class="text-[9px] text-blue-600/70 dark:text-blue-400/70 animate-pulse">
            Executing...
          </span>
        </div>
      </div>

      <button class="p-1 text-gray-400 group-hover/tool:text-gray-600 dark:group-hover/tool:text-gray-300 transition-colors">
        <ChevronUp v-if="isDetailVisible" class="w-3.5 h-3.5" />
        <ChevronDown v-else class="w-3.5 h-3.5" />
      </button>
    </div>

    <!-- Tool Details (Expandable) -->
    <Transition
      enter-active-class="transition-all duration-300 ease-out"
      leave-active-class="transition-all duration-200 ease-in"
      enter-from-class="max-h-0 opacity-0"
      enter-to-class="max-h-[1500px] opacity-100"
      leave-from-class="max-h-[1500px] opacity-100"
      leave-to-class="max-h-0 opacity-0"
    >
      <div v-if="isDetailVisible" class="border-t border-inherit overflow-hidden">
        <!-- Preview wrapper: height-limited, entire area clickable to expand -->
        <div
          v-if="isPreview"
          ref="detailsRef"
          class="relative max-h-40 overflow-hidden cursor-pointer"
          data-testid="tool-detail-preview"
          @click="handlePreviewClick"
        >
          <div class="p-3 flex flex-col gap-3">
            <component
              v-if="specializedContent"
              :is="specializedContent"
              :args="toolCall.call.function.arguments"
              :result="toolCall.result"
            />
            <template v-else>
              <!-- Arguments -->
              <div>
                <div class="text-[9px] font-bold text-gray-400 uppercase tracking-tight mb-1">Arguments</div>
                <pre class="text-[10px] font-mono p-2 bg-black/5 dark:bg-black/20 rounded-lg overflow-x-auto custom-scrollbar">{{ formatArgs({ args: toolCall.call.function.arguments }) }}</pre>
              </div>

              <!-- Result -->
              <div v-if="toolCall.result.status !== 'executing'">
                <div class="text-[9px] font-bold text-gray-400 uppercase tracking-tight mb-1">
                  {{ toolCall.result.status === 'success' ? 'Result' : 'Error' }}
                </div>
                <template v-if="toolCall.result.status === 'success'">
                  <div v-if="toolCall.result.content.type === 'text'"
                       class="text-[10px] font-mono p-2 rounded-lg break-words bg-green-500/5 text-gray-700 dark:text-gray-300 whitespace-pre-wrap"
                  >{{ toolCall.result.content.text }}</div>
                  <div v-else class="text-[10px] font-mono p-2 rounded-lg break-words bg-green-500/5 text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{{ binaryContent }}</div>
                </template>
                <template v-else-if="toolCall.result.status === 'error'">
                  <div class="text-[10px] font-mono p-2 rounded-lg break-words bg-red-500/5 text-red-600 dark:text-red-400">
                    <div class="font-bold mb-1 uppercase text-[8px] tracking-widest opacity-70">Code: {{ toolCall.result.error.code }}</div>
                    <div v-if="toolCall.result.error.message.type === 'text'" class="whitespace-pre-wrap">{{ toolCall.result.error.message.text }}</div>
                    <div v-else class="whitespace-pre-wrap">{{ binaryContent }}</div>
                  </div>
                </template>
              </div>
            </template>
          </div>

          <!-- Bottom fade hint when content overflows -->
          <div
            v-if="isPreviewOverflowing"
            class="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-white dark:from-gray-800 to-transparent pointer-events-none"
            data-testid="tool-detail-overflow-hint"
          />
        </div>

        <!-- Expanded: full content, no height limit -->
        <div v-else class="p-3 flex flex-col gap-3">
          <component
            v-if="specializedContent"
            :is="specializedContent"
            :args="toolCall.call.function.arguments"
            :result="toolCall.result"
          />
          <template v-else>
            <!-- Arguments -->
            <div>
              <div class="text-[9px] font-bold text-gray-400 uppercase tracking-tight mb-1">Arguments</div>
              <pre class="text-[10px] font-mono p-2 bg-black/5 dark:bg-black/20 rounded-lg overflow-x-auto custom-scrollbar">{{ formatArgs({ args: toolCall.call.function.arguments }) }}</pre>
            </div>

            <!-- Result -->
            <div v-if="toolCall.result.status !== 'executing'">
              <div class="text-[9px] font-bold text-gray-400 uppercase tracking-tight mb-1">
                {{ toolCall.result.status === 'success' ? 'Result' : 'Error' }}
              </div>

              <div v-if="isLoadingBinary" class="flex items-center gap-2 p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg text-gray-400">
                <Loader2 class="w-3.5 h-3.5 animate-spin" />
                <span class="text-[10px] font-medium">Loading large result...</span>
              </div>

              <template v-else-if="toolCall.result.status === 'success'">
                <div v-if="toolCall.result.content.type === 'text'"
                     class="text-[10px] font-mono p-2 rounded-lg break-words bg-green-500/5 text-gray-700 dark:text-gray-300 whitespace-pre-wrap"
                >
                  {{ toolCall.result.content.text }}
                </div>
                <div v-else class="text-[10px] font-mono p-2 rounded-lg break-words bg-green-500/5 text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
                  {{ binaryContent }}
                </div>
              </template>

              <template v-else-if="toolCall.result.status === 'error'">
                <div class="text-[10px] font-mono p-2 rounded-lg break-words bg-red-500/5 text-red-600 dark:text-red-400">
                  <div class="font-bold mb-1 uppercase text-[8px] tracking-widest opacity-70">Code: {{ toolCall.result.error.code }}</div>
                  <div v-if="toolCall.result.error.message.type === 'text'" class="whitespace-pre-wrap">{{ toolCall.result.error.message.text }}</div>
                  <div v-else class="whitespace-pre-wrap">{{ binaryContent }}</div>
                </div>
              </template>
            </div>
          </template>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  height: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(156, 163, 175, 0.2);
  border-radius: 10px;
}
</style>
