<script setup lang="ts">
import { provide, ref, computed, inject, watch, type Ref } from 'vue';
const props = defineProps<{ open: boolean, returnFocus?: HTMLElement }>();
const body = ref<HTMLElement | null>(null);
const parentOpen = inject<Readonly<Ref<boolean>> | undefined>('settings-disclosure-open', undefined);
const parentFocus = inject<(() => HTMLElement | undefined) | undefined>('settings-disclosure-focus-return', undefined);
const effectiveOpen = computed(() => props.open && parentOpen?.value !== false);

function focusReturnTarget(): HTMLElement | undefined {
  return parentOpen?.value === false ? parentFocus?.() : props.returnFocus;
}

provide('settings-disclosure-open', effectiveOpen);
provide('settings-disclosure-focus-return', focusReturnTarget);
watch(effectiveOpen, open => {
  if (!open && document.activeElement instanceof Node && body.value?.contains(document.activeElement)) {
    focusReturnTarget()?.focus();
  }
}, { flush: 'sync' });
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div class="settings-collapse" :data-open="effectiveOpen" :aria-hidden="!effectiveOpen" :inert="!effectiveOpen"><div ref="body" class="settings-collapse-inner"><slot /></div></div>
</template>
<style scoped>
.settings-collapse {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  visibility: hidden;
  transition: grid-template-rows 200ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 140ms, visibility 0s 200ms;
}
.settings-collapse[data-open='true'] {
  grid-template-rows: 1fr;
  opacity: 1;
  visibility: visible;
  transition-delay: 0s;
}
.settings-collapse-inner {
  min-height: 0;
  overflow: hidden;
}
.settings-collapse[data-open='true'] > .settings-collapse-inner {
  animation: reveal-settings-overflow 200ms step-end forwards;
}
@keyframes reveal-settings-overflow {
  to {
    overflow: visible;
  }
}
@media (prefers-reduced-motion: reduce) {
  .settings-collapse {
    transition: none;
  }
  .settings-collapse[data-open='true'] > .settings-collapse-inner {
    animation: none;
    overflow: visible;
  }
}
</style>
