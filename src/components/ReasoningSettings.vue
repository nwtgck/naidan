<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { computed, ref, onMounted, watch, nextTick } from 'vue';
import { BrainIcon } from 'lucide-vue-next';
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
  selectedEffort: Reasoning['effort'],
  selectedValue?: ReasoningSettingsValue,
  leadingOptions?: readonly LeadingOption[],
  heading?: string | undefined,
  disabled?: boolean,
  surface?: 'flat' | 'card',
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
    { label: lazyStrings.ReasoningSettings__default(), shortLabel: lazyStrings.ReasoningSettings__default(), testId: 'default', value: undefined, width: 'default' },
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
const isInitialized = ref(false);
const sliderStyle = ref({
  left: '0px',
  width: '0px',
  opacity: 0,
  transitionDuration: '0ms',
});

function updateSlider({ immediate }: { immediate?: boolean }) {
  const index = effortOptions.value.findIndex(o => o.value === selectedValue.value);
  const el = buttonRefs.value[index];
  if (el) {
    sliderStyle.value = {
      left: `${el.offsetLeft}px`,
      width: `${el.offsetWidth}px`,
      opacity: 1,
      transitionDuration: (immediate || !isInitialized.value) ? '0ms' : '300ms',
    };
  }
}

function setValue({ value }: { value: ReasoningSettingsValue }) {
  if (props.disabled) return;
  emit('update:value', value);
  if (isReasoningEffort(value)) emit('update:effort', value);
}

onMounted(() => {
  // First measurement: immediate without animation
  updateSlider({ immediate: true });

  // Mark as initialized after a short delay to ensure next changes are animated
  setTimeout(() => {
    isInitialized.value = true;
  }, 50);
});

// Monitor for selection changes or potential layout updates (e.g., resizing)
watch([selectedValue, effortOptions], () => {
  nextTick(() => updateSlider({}));
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
    :tw-class="[
      surface === 'card'
        ? 'p-4 bg-gray-50/50 dark:bg-gray-800/20 border border-gray-100 dark:border-gray-700/50 rounded-2xl'
        : 'px-3 py-2 border-b dark:border-gray-700',
      disabled ? 'opacity-50' : ''
    ]"
  >
    <div tw-class="flex items-center gap-2 mb-2">
      <BrainIcon tw-class="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
      <span tw-class="text-[9px] font-bold text-gray-400 uppercase tracking-wider">{{ headingLabel }}</span>
    </div>

    <!-- Segmented Control Container -->
    <div tw-class="relative flex p-0.5 bg-gray-100 dark:bg-gray-800 rounded-lg border border-gray-200/50 dark:border-gray-700/50">

      <!-- Animated Slider Background -->
      <div
        tw-class="absolute top-0.5 bottom-0.5 bg-white dark:bg-gray-700 rounded-md border border-gray-200 dark:border-gray-600 transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
        :style="sliderStyle"
      ></div>

      <!-- Buttons -->
      <button
        v-for="(opt, idx) in effortOptions"
        :key="String(opt.value)"
        :ref="el => buttonRefs[idx] = el as HTMLElement"
        :disabled="disabled"
        @click="setValue({ value: opt.value })"
        :tw-class="['relative z-10 py-1 text-[10px] font-medium transition-colors truncate px-0.5 disabled:cursor-not-allowed',
                    selectedValue === opt.value
                      ? 'text-blue-600 dark:text-blue-400 font-bold'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300',
                    opt.width === 'wide'
                      ? 'flex-[2.2]'
                      : opt.width === 'default'
                        ? 'flex-[1.4]'
                        : 'flex-1'
        ]"
        :data-testid="`reasoning-effort-${opt.testId}`"
        :title="opt.label"
      >
        {{ opt.shortLabel }}
      </button>
    </div>

    <div tw-class="mt-2 text-[8px] text-gray-400 dark:text-gray-500 leading-tight italic px-0.5">
      {{ lazyStrings.ReasoningSettings__effort_levels_may_be_ignored_by_some_models() }}
    </div>
  </div>
</template>

<style scoped>
/* Prevent jitter or incorrect positioning before slider initialization (opacity 0) */
.transition-all {
  will-change: left, width;
}
</style>
