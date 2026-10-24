<script setup lang="ts">
import { CheckIcon, MinusIcon } from 'lucide-vue-next';

// Keep the native input at the call site: checked values, change events,
// fieldset disabling, labels and form semantics remain owned by the form.
defineProps<{ presentation: 'checkbox' | 'switch' }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <span class="settings-choice-control" :data-presentation="presentation">
    <slot />
    <CheckIcon v-if="presentation === 'checkbox'" aria-hidden="true" class="settings-choice-check" />
    <MinusIcon v-if="presentation === 'checkbox'" aria-hidden="true" class="settings-choice-mixed" />
    <span v-if="presentation === 'switch'" aria-hidden="true" class="settings-choice-thumb" />
  </span>
</template>
<style scoped>
.settings-choice-control {
  --choice-border: #cbd5e1;
  --choice-surface: #fff;
  --choice-track-border: #d1d5db;
  --choice-track: #e5e7eb;
  --choice-selected-border: #93c5fd;
  --choice-selected-track: #dbeafe;
  --choice-thumb: #fff;
  --choice-selected-thumb: #3b82f6;
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  vertical-align: middle;
}

:global(.dark .settings-choice-control) {
  --choice-border: #4b5563;
  --choice-surface: #1f2937;
  --choice-track-border: #4b5563;
  --choice-track: #374151;
  --choice-selected-border: #3b82f680;
  --choice-selected-track: #1e3a5f;
  --choice-thumb: #9ca3af;
  --choice-selected-thumb: #60a5fa;
}

.settings-choice-control :deep(input[type='checkbox']) {
  appearance: none;
  display: block;
  width: 1.125rem;
  height: 1.125rem;
  margin: 0;
  border: 1px solid var(--choice-border);
  border-radius: 0.3rem;
  background: var(--choice-surface);
  cursor: pointer;
  transition: background-color 160ms ease, border-color 160ms ease;
}

.settings-choice-control :deep(input[type='checkbox']:hover:not(:disabled)) {
  border-color: #60a5fa;
}

.settings-choice-control :deep(input[type='checkbox']:focus-visible) {
  outline: 2px solid #60a5fa80;
  outline-offset: 3px;
}

.settings-choice-control :deep(input[type='checkbox']:checked),
.settings-choice-control :deep(input[type='checkbox']:indeterminate) {
  border-color: #3b82f6;
  background: #3b82f6;
}

.settings-choice-check,
.settings-choice-mixed {
  position: absolute;
  inset: 0;
  width: 1.125rem;
  height: 1.125rem;
  padding: 0.125rem;
  color: white;
  opacity: 0;
  pointer-events: none;
  stroke-width: 2.5;
}

.settings-choice-control:has(:checked:not(:indeterminate)) .settings-choice-check,
.settings-choice-control:has(:indeterminate) .settings-choice-mixed {
  opacity: 1;
}

.settings-choice-control[data-presentation='switch'] :deep(input[type='checkbox']) {
  width: 2.125rem;
  height: 1.25rem;
  border-radius: 1rem;
  border-color: var(--choice-track-border);
  background: var(--choice-track);
}

.settings-choice-control[data-presentation='switch'] :deep(input[type='checkbox']:checked) {
  border-color: var(--choice-selected-border);
  background: var(--choice-selected-track);
}

.settings-choice-thumb {
  position: absolute;
  left: 0.1875rem;
  width: 0.875rem;
  height: 0.875rem;
  border-radius: 50%;
  background: var(--choice-thumb);
  box-shadow: 0 1px 2px #0002;
  pointer-events: none;
  transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1), background-color 160ms ease;
}

.settings-choice-control:has(:checked) .settings-choice-thumb {
  transform: translateX(0.875rem);
  background: var(--choice-selected-thumb);
}

.settings-choice-control:has(:disabled) {
  opacity: 0.4;
}

.settings-choice-control :deep(input:disabled) {
  cursor: not-allowed;
}

@media (prefers-reduced-motion: reduce) {
  .settings-choice-control :deep(input),
  .settings-choice-thumb {
    transition: none;
  }
}

@media (forced-colors: active) {
  .settings-choice-control :deep(input[type='checkbox']) {
    appearance: auto;
  }

  .settings-choice-check,
  .settings-choice-mixed,
  .settings-choice-thumb {
    display: none;
  }
}
</style>
