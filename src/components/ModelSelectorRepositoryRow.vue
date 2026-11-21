<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { ChevronDownIcon } from 'lucide-vue-next';

defineProps<{ rowId: string, disabled: boolean, expanded: boolean, testId?: string, chooseLabel?: string, checked?: boolean, downloadStatus?: string, as?: 'li' | 'div', configurationId?: string }>();
const emit = defineEmits<{ toggle: [event: MouseEvent], choose: [] }>();


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <component :is="as ?? 'li'" tw-class="min-w-0">
    <slot name="before" />
    <div :tw-class="['flex min-w-0 items-center gap-0.5 rounded-lg', checked && 'bg-gray-100 ring-1 ring-inset ring-gray-300 dark:bg-gray-700/50 dark:ring-gray-600']">
      <button type="button" :disabled="disabled" :data-repository="chooseLabel ? undefined : rowId" :aria-pressed="chooseLabel ? checked === true : undefined" :aria-expanded="chooseLabel ? undefined : expanded" :aria-controls="!chooseLabel && expanded ? configurationId : undefined" :aria-label="chooseLabel" :data-testid="chooseLabel && testId ? testId + '-choose' : testId" :tw-class="['flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-40 motion-reduce:transition-none', checked ? 'text-blue-600 dark:text-blue-400' : 'text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700/50']" @click="chooseLabel ? emit('choose') : emit('toggle', $event)">
        <span tw-class="min-w-0 flex-1"><slot /></span>
        <span v-if="downloadStatus" tw-class="shrink-0 whitespace-nowrap text-[10px] tabular-nums text-gray-500 dark:text-gray-400">{{ downloadStatus }}</span>
        <ChevronDownIcon v-if="!chooseLabel" aria-hidden="true" :tw-class="['h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform motion-reduce:transition-none', expanded && 'rotate-180']" />
      </button>
      <slot name="actions" />
      <button v-if="chooseLabel" type="button" :disabled="disabled" :data-repository="rowId" :aria-expanded="expanded" :aria-controls="expanded ? configurationId : undefined" :aria-label="lazyStrings.ModelSelectorRepositoryRow__configuration_for_model({ model: chooseLabel })" :data-testid="testId" tw-class="me-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-40 dark:hover:bg-gray-800" @click="emit('toggle', $event)">
        <ChevronDownIcon aria-hidden="true" :tw-class="['h-3.5 w-3.5 transition-transform motion-reduce:transition-none', expanded && 'rotate-180']" />
      </button>
    </div>
    <Transition name="repository-row-disclosure">
      <div v-if="expanded" :id="configurationId" class="repository-row-disclosure">
        <div tw-class="min-h-0 overflow-hidden"><slot name="configuration" /></div>
      </div>
    </Transition>
  </component>
</template>

<style scoped>
.repository-row-disclosure {
  display: grid;
  grid-template-rows: 1fr;
}
.repository-row-disclosure-enter-active,
.repository-row-disclosure-leave-active {
  transition: grid-template-rows 160ms ease, opacity 140ms ease;
}
.repository-row-disclosure-enter-from,
.repository-row-disclosure-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .repository-row-disclosure-enter-active,
  .repository-row-disclosure-leave-active {
    transition: none;
  }
}
</style>
