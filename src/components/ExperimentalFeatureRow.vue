<script setup lang="ts">
import { computed, ref } from 'vue';
import { AlertTriangleIcon, ChevronDownIcon } from 'lucide-vue-next';

type FeatureStatus = 'disabled' | 'enabled';
type DetailsState = 'collapsed' | 'expanded';
type ToggleAvailability = 'available' | 'unavailable';

const props = defineProps<{
  id: string;
  title: string;
  summary: string;
  details: string;
  status: FeatureStatus;
  toggleAvailability: ToggleAvailability;
  toggleLabel: string;
  toggleTestId: string;
}>();

const emit = defineEmits<{
  (event: 'toggle'): void;
}>();

const detailsState = ref<DetailsState>('collapsed');
const isDetailsExpanded = computed(() => detailsState.value === 'expanded');

function toggleDetails() {
  switch (detailsState.value) {
  case 'collapsed':
    detailsState.value = 'expanded';
    return;
  case 'expanded':
    detailsState.value = 'collapsed';
    return;
  default: {
    const _ex: never = detailsState.value;
    throw new Error(`Unhandled details state: ${_ex}`);
  }
  }
}

defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
    // ESLint-required for defineExpose.
  }
});
</script>

<template>
  <div
    class="bg-white/70 dark:bg-gray-900/35"
    :data-testid="`${props.id}-row`"
  >
    <div class="flex flex-wrap items-center gap-x-3 gap-y-3 px-4 py-3.5 sm:px-5">
      <div class="flex h-9 w-9 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-500 shadow-sm dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
        <slot name="icon" />
      </div>

      <div class="min-w-[10rem] flex-1">
        <div class="flex min-w-0 items-center gap-2">
          <h4 class="text-sm font-bold leading-tight text-gray-900 dark:text-gray-100">
            {{ props.title }}
          </h4>
        </div>
        <p class="mt-0.5 text-[11px] font-medium leading-4 text-gray-500 dark:text-gray-400">
          {{ props.summary }}
        </p>
      </div>

      <div class="ml-auto flex shrink-0 items-center gap-3">
        <div
          class="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider"
          :class="props.status === 'enabled' ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500 dark:text-gray-400'"
        >
          <AlertTriangleIcon v-if="props.status === 'enabled'" class="h-3.5 w-3.5" />
          {{ props.status === 'enabled' ? 'Enabled' : 'Disabled' }}
        </div>

        <div class="flex shrink-0 items-center gap-2">
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400/40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
            :aria-expanded="isDetailsExpanded"
            :aria-controls="`${props.id}-details`"
            :data-testid="`${props.id}-details-toggle`"
            @click="toggleDetails"
          >
            Details
            <ChevronDownIcon
              class="h-3.5 w-3.5 transition-transform duration-200 motion-reduce:transition-none"
              :class="isDetailsExpanded ? 'rotate-180' : ''"
            />
          </button>

          <button
            type="button"
            role="switch"
            class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-offset-gray-950"
            :class="props.status === 'enabled' ? 'bg-amber-500 dark:bg-amber-400' : 'bg-gray-300 dark:bg-gray-700'"
            :disabled="props.toggleAvailability === 'unavailable'"
            :aria-checked="props.status === 'enabled'"
            :aria-label="props.toggleLabel"
            :data-testid="props.toggleTestId"
            @click="emit('toggle')"
          >
            <span
              class="block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 motion-reduce:transition-none"
              :class="props.status === 'enabled' ? 'translate-x-[18px]' : 'translate-x-[3px]'"
            />
          </button>
        </div>
      </div>
    </div>

    <div
      :id="`${props.id}-details`"
      class="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
      :class="isDetailsExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
      role="region"
      :aria-hidden="!isDetailsExpanded"
      :aria-label="`${props.title} details`"
      :data-testid="`${props.id}-details`"
    >
      <div class="overflow-hidden">
        <div
          class="px-4 pb-4 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none sm:px-5"
          :class="isDetailsExpanded ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'"
        >
          <p class="ml-12 rounded-lg border border-gray-200/80 bg-gray-50/80 px-3 py-2 text-[11px] font-medium leading-relaxed text-gray-600 dark:border-gray-800 dark:bg-gray-950/35 dark:text-gray-300">
            {{ props.details }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
