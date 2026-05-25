<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { XIcon, BrainIcon, ChevronRightIcon } from 'lucide-vue-next';

const props = defineProps<{
  isOpen: boolean;
  totalMessages: number;
  initialKeepCount: number;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'confirm', keepCount: number): void;
}>();

const keepCount = ref(props.initialKeepCount);
const maxKeepCount = computed(() => Math.max(0, props.totalMessages - 1));

watch(() => props.isOpen, (open) => {
  if (open) {
    keepCount.value = Math.min(props.initialKeepCount, maxKeepCount.value);
  }
});

const compactCount = computed(() => Math.max(0, props.totalMessages - keepCount.value));

const percentageToKeep = computed(() => props.totalMessages > 0 ? (keepCount.value / props.totalMessages) * 100 : 0);

function handleConfirm() {
  if (compactCount.value === 0) {
    return;
  }
  emit('confirm', keepCount.value);
}


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <Transition
    enter-active-class="transition duration-300 ease-out"
    enter-from-class="opacity-0 scale-95"
    enter-to-class="opacity-100 scale-100"
    leave-active-class="transition duration-200 ease-in"
    leave-from-class="opacity-100 scale-100"
    leave-to-class="opacity-0 scale-95"
  >
    <div
      v-if="isOpen"
      class="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-[2px] px-4"
      @click.self="emit('close')"
    >
      <div class="w-full max-w-md bg-white/90 dark:bg-gray-950/90 border border-indigo-100/50 dark:border-indigo-900/40 rounded-3xl shadow-2xl overflow-hidden backdrop-blur-xl ring-1 ring-white/20 dark:ring-indigo-500/10">
        <!-- Header -->
        <div class="px-6 py-5 border-b border-indigo-50/50 dark:border-indigo-900/30 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div class="p-2 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-100 dark:border-indigo-900/50">
              <BrainIcon class="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h3 class="text-sm font-black uppercase tracking-widest text-gray-900 dark:text-indigo-100">Compact Context</h3>
              <p class="text-[10px] font-bold text-indigo-600/60 dark:text-indigo-400/50 uppercase tracking-tighter">Memory Reconfiguration</p>
            </div>
          </div>
          <button
            class="p-2 rounded-full text-gray-400 hover:text-gray-900 dark:hover:text-indigo-200 hover:bg-gray-50 dark:hover:bg-indigo-950/40 transition-all"
            @click="emit('close')"
          >
            <XIcon class="w-4 h-4" />
          </button>
        </div>

        <!-- Content -->
        <div class="p-6 space-y-8">
          <!-- Visualization -->
          <div class="relative h-20 flex items-end gap-1 px-2">
            <div
              v-for="i in 20"
              :key="i"
              class="flex-1 rounded-t-sm transition-all duration-500"
              :class="[
                i > (20 - (percentageToKeep / 100 * 20))
                  ? 'h-full bg-indigo-500/80 dark:bg-indigo-400/80 shadow-[0_-4px_10px_rgba(99,102,241,0.2)]'
                  : 'h-1/3 bg-gray-200 dark:bg-gray-800 opacity-40'
              ]"
            ></div>
            <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div class="bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border border-indigo-100 dark:border-indigo-900/50 px-3 py-1 rounded-full shadow-sm">
                <span class="text-[10px] font-black uppercase tracking-widest text-indigo-600 dark:text-indigo-300">
                  {{ compactCount }} To Compact <ChevronRightIcon class="inline w-3 h-3 mx-0.5" /> {{ keepCount }} To Keep
                </span>
              </div>
            </div>
          </div>

          <!-- Slider Control -->
          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <label class="text-[10px] font-black uppercase tracking-[0.2em] text-gray-400 dark:text-indigo-500/60">Messages to keep</label>
              <span class="text-xl font-black tabular-nums text-indigo-600 dark:text-indigo-400">{{ keepCount }}</span>
            </div>
            <input
              v-model.number="keepCount"
              type="range"
              min="0"
              :max="maxKeepCount"
              step="1"
              class="w-full h-1.5 bg-indigo-100 dark:bg-indigo-950 rounded-lg appearance-none cursor-pointer accent-indigo-600 dark:accent-indigo-400 focus:outline-none"
            />
            <div class="flex justify-between text-[9px] font-bold text-gray-400 dark:text-indigo-500/40 uppercase tracking-widest">
              <span>More History</span>
              <span>More Context</span>
            </div>
          </div>

          <!-- Quick Presets -->
          <div class="grid grid-cols-3 gap-2">
            <button
              v-for="preset in [
                { label: 'Compact', value: 0 },
                { label: 'Balanced', value: 6 },
                { label: 'Deep', value: 12 }
              ]"
              :key="preset.label"
              class="px-2 py-2 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all border"
              :class="[
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
          <div class="p-4 rounded-2xl bg-indigo-50/50 dark:bg-indigo-950/30 border border-indigo-100/50 dark:border-indigo-900/40 text-[11px] leading-relaxed text-indigo-900/70 dark:text-indigo-200/60">
            <p>
              Compacting will condense the first <strong class="text-indigo-600 dark:text-indigo-300">{{ compactCount }} messages</strong> into a single summary. This reduces token usage while preserving the core context.
            </p>
          </div>
        </div>

        <!-- Footer -->
        <div class="px-6 py-5 bg-gray-50/50 dark:bg-indigo-950/20 border-t border-indigo-50/50 dark:border-indigo-900/30 flex justify-end gap-3">
          <button
            class="px-5 py-2.5 text-xs font-bold text-gray-500 hover:text-gray-700 dark:text-indigo-400 dark:hover:text-indigo-200 transition-colors"
            @click="emit('close')"
          >
            Cancel
          </button>
          <button
            class="px-6 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 text-white text-xs font-black uppercase tracking-widest shadow-lg shadow-indigo-500/20 transition-all active:scale-95 flex items-center gap-2"
            :disabled="compactCount === 0"
            :class="{ 'opacity-50 cursor-not-allowed active:scale-100': compactCount === 0 }"
            @click="handleConfirm"
          >
            Compact Now
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
