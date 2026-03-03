<script setup lang="ts">
import { ref, onMounted, watch, nextTick } from 'vue';
import { Brain } from 'lucide-vue-next';
import type { Reasoning } from '../models/types';

defineOptions({
  name: 'ReasoningSettings'
});

const props = defineProps<{
  selectedEffort: Reasoning['effort'];
}>();

const emit = defineEmits<{
  (e: 'update:effort', effort: Reasoning['effort']): void;
}>();

const effortOptions: { label: string; shortLabel: string; value: Reasoning['effort'] }[] = [
  { label: 'Default', shortLabel: 'Default', value: undefined },
  { label: 'Off', shortLabel: 'Off', value: 'none' },
  { label: 'Low', shortLabel: 'Low', value: 'low' },
  { label: 'Medium', shortLabel: 'Med', value: 'medium' },
  { label: 'High', shortLabel: 'High', value: 'high' },
];

const buttonRefs = ref<(HTMLElement | null)[]>([]);
const isInitialized = ref(false);
const sliderStyle = ref({
  left: '0px',
  width: '0px',
  opacity: 0,
  transitionDuration: '0ms'
});

function updateSlider(immediate = false) {
  const index = effortOptions.findIndex(o => o.value === props.selectedEffort);
  const el = buttonRefs.value[index];
  if (el) {
    sliderStyle.value = {
      left: `${el.offsetLeft}px`,
      width: `${el.offsetWidth}px`,
      opacity: 1,
      transitionDuration: (immediate || !isInitialized.value) ? '0ms' : '300ms'
    };
  }
}

function setEffort({ effort }: { effort: Reasoning['effort'] }) {
  emit('update:effort', effort);
}

onMounted(() => {
  // First measurement: immediate without animation
  updateSlider(true);

  // Mark as initialized after a short delay to ensure next changes are animated
  setTimeout(() => {
    isInitialized.value = true;
  }, 50);
});

// Monitor for selection changes or potential layout updates (e.g., resizing)
watch(() => props.selectedEffort, () => {
  nextTick(() => updateSlider());
});


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="px-3 py-2 border-b dark:border-gray-700">
    <div class="flex items-center gap-2 mb-2">
      <Brain class="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
      <span class="text-[9px] font-bold text-gray-400 uppercase tracking-wider">Think</span>
    </div>

    <!-- Segmented Control Container -->
    <div class="relative flex p-0.5 bg-gray-100 dark:bg-gray-800 rounded-lg border border-gray-200/50 dark:border-gray-700/50">

      <!-- Animated Slider Background -->
      <div
        class="absolute top-0.5 bottom-0.5 bg-white dark:bg-gray-700 rounded-md border border-gray-200 dark:border-gray-600 transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
        :style="sliderStyle"
      ></div>

      <!-- Buttons -->
      <button
        v-for="(opt, idx) in effortOptions"
        :key="String(opt.value)"
        :ref="el => buttonRefs[idx] = el as HTMLElement"
        @click="setEffort({ effort: opt.value })"
        class="relative z-10 flex-1 py-1 text-[10px] font-medium transition-colors truncate px-0.5"
        :class="[
          selectedEffort === opt.value
            ? 'text-blue-600 dark:text-blue-400 font-bold'
            : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300',
          opt.value === undefined ? 'flex-[1.4]' : 'flex-1'
        ]"
        :data-testid="`reasoning-effort-${opt.label.toLowerCase()}`"
        :title="opt.label"
      >
        {{ opt.shortLabel }}
      </button>
    </div>

    <div class="mt-2 text-[8px] text-gray-400 dark:text-gray-500 leading-tight italic px-0.5">
      * Effort levels may be ignored by some models.
    </div>
  </div>
</template>

<style scoped>
/* Prevent jitter or incorrect positioning before slider initialization (opacity 0) */
.transition-all {
  will-change: left, width;
}
</style>
