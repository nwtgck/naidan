<script setup lang="ts">
import { ChevronDownIcon } from 'lucide-vue-next';
import { computed, inject, provide, ref, type Ref } from 'vue';
defineProps<{ title: string | undefined, summary: string | undefined, embedded?: boolean, compact?: boolean }>();
const open = defineModel<boolean>('open', { default: false });
const trigger = ref<HTMLElement>();
const parentOpen = inject<Readonly<Ref<boolean>> | undefined>('settings-disclosure-open', undefined);
const parentFocus = inject<(() => HTMLElement | undefined) | undefined>('settings-disclosure-focus-return', undefined);
provide('settings-disclosure-open', computed(() => open.value && parentOpen?.value !== false));
provide('settings-disclosure-focus-return', () => parentOpen?.value === false ? parentFocus?.() : trigger.value);

function toggle({ event }: { event: Event }): void {
  if (event.target instanceof HTMLDetailsElement) {
    open.value = event.target.open;
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <details :open="open" @toggle="toggle({ event: $event })" class="image-settings-section" :tw-class="['min-w-0 max-w-full overflow-hidden', embedded ? 'rounded-xl bg-gray-50/60 dark:bg-gray-800/25' : 'rounded-xl border border-gray-200/70 bg-white/70 dark:border-gray-700/60 dark:bg-gray-900/30']">
    <summary ref="trigger" :tw-class="[compact ? 'min-h-9 px-3 py-2' : 'min-h-12 px-4 py-3', 'flex min-w-0 items-center gap-3 cursor-pointer list-none select-none hover:bg-gray-50 dark:hover:bg-gray-800/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 transition-colors [&::-webkit-details-marker]:hidden']">
      <span :tw-class="['min-w-0 [overflow-wrap:anywhere] font-medium text-gray-700 dark:text-gray-200', compact ? 'text-xs' : 'text-sm']">{{ title }}</span>
      <span :title="summary" tw-class="ml-auto min-w-0 flex-1 truncate text-right text-xs text-gray-500 dark:text-gray-400"><slot name="summary">{{ summary }}</slot></span>
      <span :tw-class="['flex h-6 w-6 shrink-0 items-center justify-center rounded-lg transition-colors', open ? 'bg-blue-50 text-blue-500 dark:bg-blue-500/10 dark:text-blue-400' : 'bg-gray-100/70 text-gray-400 dark:bg-gray-800/80']"><ChevronDownIcon aria-hidden="true" :tw-class="['h-3 w-3 transition-transform duration-200 motion-reduce:transition-none', open && 'rotate-180']" /></span>
    </summary>
    <div :tw-class="['min-w-0 border-t border-gray-100 dark:border-gray-800', compact ? 'p-3 space-y-2 text-xs' : 'p-4 space-y-4']"><slot /></div>
  </details>
</template>
<style scoped>
@supports (interpolate-size: allow-keywords) {
  .image-settings-section::details-content {
    interpolate-size: allow-keywords;
    block-size: 0;
    opacity: 0;
    overflow: clip;
    transition: block-size 200ms ease, opacity 180ms ease, content-visibility 200ms allow-discrete;
  }

  .image-settings-section[open]::details-content {
    block-size: auto;
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .image-settings-section::details-content {
    transition: none;
  }
}
</style>
