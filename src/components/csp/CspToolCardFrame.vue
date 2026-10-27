<script setup lang="ts">
import type { BuiltinToolKey } from '@/01-models/tool';
import CspMessageHint from './CspMessageHint.vue';

defineOptions({ inheritAttrs: false });
defineProps<{ toolKey: BuiltinToolKey, enabled: boolean }>();


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
  <article
    v-bind="$attrs"
    :class="{ 'csp-tool-card-enabled': enabled }"
    :tw-class="['overflow-hidden rounded-xl border transition-all duration-300 active:scale-[0.995]',
                'h-[52px]',
                enabled
                  ? 'border-slate-300/80 bg-slate-50/70 shadow-sm dark:border-slate-600/60 dark:bg-slate-800/45'
                  : 'border-gray-100 bg-white/70 hover:border-gray-200 dark:border-gray-700/60 dark:bg-gray-800/40 dark:hover:border-gray-700',
    ]"
  >
    <slot />
    <CspMessageHint v-if="toolKey === 'builtin.wikipedia'" :target="{ kind: 'wikipedia' }" presentation="compact" activity-for-display-only="wikipedia" data-csp-tool-notice tw-class="border-t border-amber-200/60 bg-amber-50/70 px-3 py-1 dark:border-amber-700/25 dark:bg-amber-900/10" />
  </article>
</template>

<style scoped>
/* Only diagnostic DOM changes. Existing controls keep the same node, focus,
   and component instance when a hint loads, disappears, or fails. */
article:has(> [data-csp-tool-notice]) {
  height: auto;
}
article:has(> [data-csp-tool-notice]) > :first-child {
  height: 50px;
}
.csp-tool-card-enabled:has(> [data-csp-tool-notice]) {
  border-color: rgb(252 211 77 / 0.8);
  background-color: rgb(255 251 235 / 0.8);
}
.csp-tool-card-enabled:has(> [data-csp-tool-notice]) :deep(> div:first-child > div:first-child) {
  background-color: rgb(254 243 199 / 0.8);
  color: #b45309;
}
:global(.dark .csp-tool-card-enabled:has(> [data-csp-tool-notice])) {
  border-color: rgb(180 83 9 / 0.6);
  background-color: rgb(120 53 15 / 0.15);
}
:global(.dark .csp-tool-card-enabled:has(> [data-csp-tool-notice]) > div:first-child > div:first-child) {
  background-color: rgb(120 53 15 / 0.25);
  color: #fbbf24;
}
</style>
