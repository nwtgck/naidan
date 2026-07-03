<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { XIcon, BrainIcon, ChevronRightIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';

const props = defineProps<{
  isOpen: boolean,
  totalMessages: number,
  initialKeepCount: number,
  initialInstruction: string,
}>();

const emit = defineEmits<{
  (e: 'close'): void,
  (e: 'confirm', value: { keepCount: number, instruction: string }): void,
}>();

const keepCount = ref(props.initialKeepCount);
const instructionDraft = ref(props.initialInstruction);
const showInstructionEditor = ref(false);
const maxKeepCount = computed(() => Math.max(0, props.totalMessages - 1));
const instructionPreview = computed(() => {
  const compact = instructionDraft.value.replace(/\s+/g, ' ').trim();
  if (compact.length <= 140) {
    return compact;
  }
  return `${compact.slice(0, 140)}...`;
});

watch(() => props.isOpen, (open) => {
  if (open) {
    keepCount.value = Math.min(props.initialKeepCount, maxKeepCount.value);
    instructionDraft.value = props.initialInstruction;
    showInstructionEditor.value = false;
  }
});

const compactCount = computed(() => Math.max(0, props.totalMessages - keepCount.value));

const percentageToKeep = computed(() => props.totalMessages > 0 ? (keepCount.value / props.totalMessages) * 100 : 0);

const compactPresets = computed(() => [
  { label: lazyStrings.contextCompact__compact(), value: 0 },
  { label: lazyStrings.contextCompact__balanced(), value: 6 },
  { label: lazyStrings.contextCompact__deep(), value: 12 },
]);

function handleConfirm() {
  if (compactCount.value === 0) {
    return;
  }
  emit('confirm', {
    keepCount: keepCount.value,
    instruction: instructionDraft.value,
  });
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
  <Transition
    tw-enter-active-class="transition duration-300 ease-out"
    tw-enter-from-class="opacity-0 scale-95"
    tw-enter-to-class="opacity-100 scale-100"
    tw-leave-active-class="transition duration-200 ease-in"
    tw-leave-from-class="opacity-100 scale-100"
    tw-leave-to-class="opacity-0 scale-95"
  >
    <div
      v-if="isOpen"
      tw-class="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-[2px] px-4"
      @click.self="emit('close')"
    >
      <div tw-class="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-indigo-100/50 bg-white/90 shadow-2xl ring-1 ring-white/20 backdrop-blur-xl dark:border-indigo-900/40 dark:bg-gray-950/90 dark:ring-indigo-500/10">
        <!-- Header -->
        <div tw-class="px-6 py-5 border-b border-indigo-50/50 dark:border-indigo-900/30 flex items-center justify-between shrink-0">
          <div tw-class="flex items-center gap-3">
            <div tw-class="p-2 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-100 dark:border-indigo-900/50">
              <BrainIcon tw-class="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h3 tw-class="text-sm font-black uppercase tracking-widest text-gray-900 dark:text-indigo-100">{{ lazyStrings.contextCompact__compact_context() }}</h3>
              <p tw-class="text-[10px] font-bold text-indigo-600/60 dark:text-indigo-400/50 uppercase tracking-tighter">{{ lazyStrings.contextCompact__memory_reconfiguration() }}</p>
            </div>
          </div>
          <button
            tw-class="p-2 rounded-full text-gray-400 hover:text-gray-900 dark:hover:text-indigo-200 hover:bg-gray-50 dark:hover:bg-indigo-950/40 transition-all"
            @click="emit('close')"
          >
            <XIcon tw-class="w-4 h-4" />
          </button>
        </div>

        <!-- Content -->
        <div tw-class="flex-1 overflow-y-auto p-6 space-y-8">
          <!-- Visualization -->
          <div tw-class="relative h-20 flex items-end gap-1 px-2">
            <div
              v-for="i in 20"
              :key="i"
              :tw-class="['flex-1 rounded-t-sm transition-all duration-500',
                          i > (20 - (percentageToKeep / 100 * 20))
                            ? 'h-full bg-indigo-500/80 dark:bg-indigo-400/80 shadow-[0_-4px_10px_rgba(99,102,241,0.2)]'
                            : 'h-1/3 bg-gray-200 dark:bg-gray-800 opacity-40'
              ]"
            ></div>
            <div tw-class="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div tw-class="bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border border-indigo-100 dark:border-indigo-900/50 px-3 py-1 rounded-full shadow-sm">
                <span tw-class="text-[10px] font-black uppercase tracking-widest text-indigo-600 dark:text-indigo-300">
                  {{ lazyStrings.contextCompact__to_compact({ count: compactCount }) }} <ChevronRightIcon tw-class="inline w-3 h-3 mx-0.5" /> {{ lazyStrings.contextCompact__to_keep({ count: keepCount }) }}
                </span>
              </div>
            </div>
          </div>

          <!-- Slider Control -->
          <div tw-class="space-y-4">
            <div tw-class="flex items-center justify-between">
              <label tw-class="text-[10px] font-black uppercase tracking-[0.2em] text-gray-400 dark:text-indigo-500/60">{{ lazyStrings.contextCompact__messages_to_keep() }}</label>
              <span tw-class="text-xl font-black tabular-nums text-indigo-600 dark:text-indigo-400">{{ keepCount }}</span>
            </div>
            <input
              v-model.number="keepCount"
              type="range"
              min="0"
              :max="maxKeepCount"
              step="1"
              tw-class="w-full h-1.5 bg-indigo-100 dark:bg-indigo-950 rounded-lg appearance-none cursor-pointer accent-indigo-600 dark:accent-indigo-400 focus:outline-none"
            />
            <div tw-class="flex justify-between text-[9px] font-bold text-gray-400 dark:text-indigo-500/40 uppercase tracking-widest">
              <span>{{ lazyStrings.contextCompact__more_history() }}</span>
              <span>{{ lazyStrings.contextCompact__more_context() }}</span>
            </div>
          </div>

          <!-- Quick Presets -->
          <div tw-class="grid grid-cols-3 gap-2">
            <button
              v-for="preset in compactPresets"
              :key="preset.label"
              :tw-class="['px-2 py-2 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all border',
                          keepCount === preset.value
                            ? 'bg-indigo-600 border-indigo-600 text-white shadow-md shadow-indigo-500/20'
                            : 'bg-white dark:bg-indigo-950/20 border-indigo-100 dark:border-indigo-900/40 text-indigo-600/60 dark:text-indigo-400/60 hover:border-indigo-300 dark:hover:border-indigo-700'
              ]"
              :disabled="preset.value > maxKeepCount"
              @click="keepCount = Math.min(preset.value, maxKeepCount)"
            >
              {{ preset.label }}
            </button>
          </div>

          <!-- Info Box -->
          <div tw-class="p-4 rounded-2xl bg-indigo-50/50 dark:bg-indigo-950/30 border border-indigo-100/50 dark:border-indigo-900/40 text-[11px] leading-relaxed text-indigo-900/70 dark:text-indigo-200/60">
            <p>
              {{ lazyStrings.contextCompact__compacting_will_condense_messages_into_a_single_summary({ count: compactCount }) }}
            </p>
          </div>

          <div tw-class="rounded-2xl border border-indigo-100/50 dark:border-indigo-900/40 bg-white/60 dark:bg-indigo-950/20 overflow-hidden">
            <button
              tw-class="w-full flex items-start justify-between gap-3 px-4 py-3 text-left"
              data-testid="context-compact-instruction-toggle"
              @click="showInstructionEditor = !showInstructionEditor"
            >
              <div tw-class="min-w-0">
                <div tw-class="text-[10px] font-black uppercase tracking-[0.2em] text-gray-400 dark:text-indigo-500/60">{{ lazyStrings.contextCompact__compact_prompt() }}</div>
                <p tw-class="mt-1 text-[11px] leading-relaxed text-indigo-900/70 dark:text-indigo-100/70 line-clamp-3">
                  {{ instructionPreview }}
                </p>
              </div>
              <component :is="showInstructionEditor ? ChevronUpIcon : ChevronDownIcon" tw-class="mt-0.5 w-4 h-4 shrink-0 text-indigo-500/70 dark:text-indigo-300/60" />
            </button>

            <div v-if="showInstructionEditor" tw-class="border-t border-indigo-100/50 dark:border-indigo-900/40 px-4 py-3 space-y-2">
              <label tw-class="text-[10px] font-black uppercase tracking-[0.2em] text-gray-400 dark:text-indigo-500/60" for="context-compact-instruction">
                {{ lazyStrings.contextCompact__editable_prompt() }}
              </label>
              <textarea
                id="context-compact-instruction"
                v-model="instructionDraft"
                tw-class="h-48 max-h-[40vh] w-full resize-y rounded-xl border border-indigo-100 dark:border-indigo-900/40 bg-white/80 dark:bg-gray-950/60 px-3 py-2 text-[11px] leading-relaxed text-gray-800 dark:text-indigo-100 shadow-inner focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                data-testid="context-compact-instruction-editor"
                spellcheck="false"
              />
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div tw-class="px-6 py-5 bg-gray-50/50 dark:bg-indigo-950/20 border-t border-indigo-50/50 dark:border-indigo-900/30 flex justify-end gap-3 shrink-0">
          <button
            tw-class="px-5 py-2.5 text-xs font-bold text-gray-500 hover:text-gray-700 dark:text-indigo-400 dark:hover:text-indigo-200 transition-colors"
            @click="emit('close')"
          >
            {{ lazyStrings.contextCompact__cancel() }}
          </button>
          <button
            :disabled="compactCount === 0"
            :tw-class="['px-6 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 text-white text-xs font-black uppercase tracking-widest shadow-lg shadow-indigo-500/20 transition-all active:scale-95 flex items-center gap-2', { 'opacity-50 cursor-not-allowed active:scale-100': compactCount === 0 }]"
            @click="handleConfirm"
          >
            {{ lazyStrings.contextCompact__compact_now() }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  background: white;
  border: 3px solid #6366f1;
  border-radius: 50%;
  box-shadow: 0 0 10px rgba(99, 102, 241, 0.3);
  transition: all 0.2s;
}

input[type='range']:active::-webkit-slider-thumb {
  transform: scale(1.2);
  box-shadow: 0 0 15px rgba(99, 102, 241, 0.5);
}

.dark input[type='range']::-webkit-slider-thumb {
  background: #1e1b4b;
  border-color: #818cf8;
}
</style>
