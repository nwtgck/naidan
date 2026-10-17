<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { computed, ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { BrainIcon } from 'lucide-vue-next';
import ReasoningSettingsHelp from './ReasoningSettingsHelp.vue';
import type { Reasoning } from '@/01-models/types';

defineOptions({
  name: 'ReasoningSettings',
});

type SpecialReasoningSettingsValue = 'inherit' | 'same_scope';
type ReasoningSettingsValue = Reasoning['effort'] | SpecialReasoningSettingsValue;

type LeadingOption = {
  label: string | undefined,
  shortLabel: string | undefined,
  testId: string,
  value: SpecialReasoningSettingsValue,
};

type EffortOption = {
  label: string,
  shortLabel: string,
  testId: string,
  value: ReasoningSettingsValue,
  width: 'default' | 'normal' | 'wide',
};

const props = defineProps<{
  defaultLabel?: string,
  selectedEffort: Reasoning['effort'],
  selectedValue?: ReasoningSettingsValue,
  leadingOptions?: readonly LeadingOption[],
  heading?: string | undefined,
  disabled?: boolean,
  surface?: 'flat' | 'card' | 'plain',
  notice?: 'paragraph' | 'inline-help',
}>();

const emit = defineEmits<{
  (e: 'update:effort', effort: Reasoning['effort']): void,
  (e: 'update:value', value: ReasoningSettingsValue): void,
}>();

function isReasoningEffort(value: ReasoningSettingsValue): value is Reasoning['effort'] {
  switch (value) {
  case undefined:
  case 'none':
  case 'low':
  case 'medium':
  case 'high':
    return true;
  case 'inherit':
  case 'same_scope':
    return false;
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled reasoning settings value: ${_ex}`);
  }
  }
}

const selectedValue = computed<ReasoningSettingsValue>(() => props.selectedValue ?? props.selectedEffort);
const headingLabel = computed(() => props.heading ?? lazyStrings.ReasoningSettings__think());
const surface = computed(() => props.surface ?? 'flat');

const effortOptions = computed<EffortOption[]>(() => {
  const leadingOptions = props.leadingOptions ?? [];
  const leading = leadingOptions
    .filter((option): option is LeadingOption & { label: string, shortLabel: string } => (
      option.label !== undefined && option.shortLabel !== undefined
    ))
    .map((option): EffortOption => ({ ...option, width: 'wide' }));
  const options: Array<Omit<EffortOption, 'label' | 'shortLabel'> & { label: string | undefined, shortLabel: string | undefined }> = [
    { label: props.defaultLabel ?? lazyStrings.ReasoningSettings__default(), shortLabel: props.defaultLabel ?? lazyStrings.ReasoningSettings__default(), testId: 'default', value: undefined, width: 'default' },
    { label: lazyStrings.ReasoningSettings__off(), shortLabel: lazyStrings.ReasoningSettings__off(), testId: 'off', value: 'none' as const, width: 'normal' },
    { label: lazyStrings.ReasoningSettings__low(), shortLabel: lazyStrings.ReasoningSettings__low(), testId: 'low', value: 'low' as const, width: 'normal' },
    { label: lazyStrings.ReasoningSettings__medium(), shortLabel: lazyStrings.ReasoningSettings__med(), testId: 'medium', value: 'medium' as const, width: 'normal' },
    { label: lazyStrings.ReasoningSettings__high(), shortLabel: lazyStrings.ReasoningSettings__high(), testId: 'high', value: 'high' as const, width: 'normal' },
  ];
  const resolvedOptions = options.filter((option): option is EffortOption => (
    option.label !== undefined && option.shortLabel !== undefined
  ));
  return [...leading, ...resolvedOptions];
});

const buttonRefs = ref<(HTMLElement | null)[]>([]);
const containerRef = ref<HTMLElement>();
const isInitialized = ref(false);
let resizeObserver: ResizeObserver | undefined;
let initializationTimer: ReturnType<typeof setTimeout> | undefined;
let isUnmounted = false;
const sliderStyle = ref({
  left: '0px',
  width: '0px',
  opacity: 0,
  transitionDuration: '0ms',
});

function updateSlider({ immediate }: { immediate?: boolean }) {
  if (isUnmounted) {
    return;
  }
  const index = effortOptions.value.findIndex(o => o.value === selectedValue.value);
  const el = buttonRefs.value[index];
  if (el) {
    const left = el.offsetLeft;
    const width = el.offsetWidth;
    sliderStyle.value = {
      left: `${left}px`,
      width: `${width}px`,
      opacity: 1,
      transitionDuration: (immediate || !isInitialized.value) ? '0ms' : '300ms',
    };
    const container = containerRef.value;
    if (surface.value === 'plain' && container && container.clientWidth > 0) {
      if (left < container.scrollLeft) {
        container.scrollLeft = left;
      } else if (left + width > container.scrollLeft + container.clientWidth) {
        container.scrollLeft = left + width - container.clientWidth;
      }
    }
  }
}

function setValue({ value }: { value: ReasoningSettingsValue }) {
  if (props.disabled) {
    return;
  }
  emit('update:value', value);
  if (isReasoningEffort(value)) {
    emit('update:effort', value);
  }
}

onMounted(() => {
  // First measurement: immediate without animation
  updateSlider({ immediate: true });

  if (typeof ResizeObserver !== 'undefined' && containerRef.value) {
    resizeObserver = new ResizeObserver(() => updateSlider({ immediate: true }));
    resizeObserver.observe(containerRef.value);
    for (const button of buttonRefs.value) {
      if (button) {
        resizeObserver.observe(button);
      }
    }
  }

  // Mark as initialized after a short delay to ensure next changes are animated
  initializationTimer = setTimeout(() => {
    isInitialized.value = true;
  }, 50);
});

onBeforeUnmount(() => {
  isUnmounted = true;
  resizeObserver?.disconnect();
  if (initializationTimer !== undefined) {
    clearTimeout(initializationTimer);
  }
});

watch(selectedValue, () => {
  nextTick(() => updateSlider({}));
});

// Label and layout changes should align immediately rather than slide between geometries.
watch([effortOptions, surface], () => {
  nextTick(() => updateSlider({ immediate: true }));
});


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div
    :class="{ 'reasoning-settings-plain': surface === 'plain' }"
    :tw-class="[
      surface === 'card'
        ? 'p-4 bg-gray-50/50 dark:bg-gray-800/20 border border-gray-100 dark:border-gray-700/50 rounded-2xl'
        : surface === 'plain' ? '' : 'px-3 py-2 border-b dark:border-gray-700',
      disabled && surface !== 'plain' ? 'opacity-50' : ''
    ]"
  >
    <div :tw-class="['flex items-center gap-2', surface === 'plain' ? 'mb-0.5' : 'mb-2']">
      <BrainIcon tw-class="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
      <span :tw-class="[surface === 'plain' ? 'text-xs font-medium text-gray-500 dark:text-gray-400' : 'text-[9px] font-bold text-gray-400 uppercase tracking-wider']">{{ headingLabel }}</span>
      <ReasoningSettingsHelp v-if="notice === 'inline-help'" />
    </div>

    <!-- Segmented Control Container -->
    <div ref="containerRef" data-testid="reasoning-effort-options" class="reasoning-effort-options" :tw-class="['relative flex p-0.5 rounded-lg border', surface === 'plain' ? 'items-center bg-gray-100/60 dark:bg-gray-800/50 border-gray-200/60 dark:border-gray-700/50' : 'bg-gray-100 dark:bg-gray-800 border-gray-200/50 dark:border-gray-700/50']">

      <!-- Animated Slider Background -->
      <div
        data-testid="reasoning-effort-slider"
        :tw-class="[
          'absolute top-0.5 bottom-0.5 rounded-md transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]',
          surface === 'plain' ? 'bg-blue-50 dark:bg-blue-500/15' : 'bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600'
        ]"
        :style="sliderStyle"
      ></div>

      <!-- Buttons -->
      <button
        v-for="(opt, idx) in effortOptions"
        :key="String(opt.value)"
        :ref="el => buttonRefs[idx] = el as HTMLElement"
        :disabled="disabled"
        :aria-pressed="selectedValue === opt.value"
        @click="setValue({ value: opt.value })"
        :class="{
          'reasoning-effort-source': surface === 'plain' && opt.width !== 'normal',
          'reasoning-effort-explicit': surface === 'plain' && opt.width === 'normal'
        }"
        :tw-class="['relative z-10 font-medium transition-colors disabled:cursor-not-allowed',
                    surface === 'plain'
                      ? 'min-h-7 min-w-8 rounded-md px-2 py-1.5 text-xs leading-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/30'
                      : 'min-w-0 py-1 text-[10px] px-0.5',
                    selectedValue === opt.value
                      ? surface === 'plain' ? 'text-blue-600 dark:text-blue-400' : 'text-blue-600 dark:text-blue-400 font-bold'
                      : surface === 'plain' ? 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/40 hover:text-gray-700 dark:hover:text-gray-200' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300',
                    surface === 'plain' ? '' : opt.width === 'wide'
                      ? 'flex-[2.2]'
                      : opt.width === 'default'
                        ? 'flex-[1.4]'
                        : 'flex-1'
        ]"
        :data-testid="`reasoning-effort-${opt.testId}`"
        :title="opt.label"
      >
        <span tw-class="block min-w-0 truncate">{{ opt.shortLabel }}</span>
      </button>
    </div>

    <div v-if="notice !== 'inline-help'" tw-class="mt-2 text-[8px] text-gray-400 dark:text-gray-500 leading-tight italic px-0.5">
      {{ lazyStrings.ReasoningSettings__effort_levels_may_be_ignored_by_some_models() }}
    </div>
  </div>
</template>

<style scoped>
.reasoning-settings-plain .reasoning-effort-options {
  min-width: 0;
  overflow-x: auto;
}

.reasoning-settings-plain .reasoning-effort-source {
  flex: 1.4 1 auto;
  min-width: 2rem;
  max-width: 40%;
}

.reasoning-settings-plain .reasoning-effort-explicit {
  flex: 1 0 auto;
}

/* Prevent jitter or incorrect positioning before slider initialization (opacity 0) */
.transition-all {
  will-change: left, width;
}
</style>
