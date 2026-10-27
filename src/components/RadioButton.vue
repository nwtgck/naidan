<script setup lang="ts">
// Native radio attributes and events fall through to the input. Callers own
// the label, group name, selected value, disabled rules and persistence.
defineProps<{ tone: 'blue' | 'amber' }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <input type="radio" class="radio-button" :data-tone="tone" />
</template>

<style scoped>
.radio-button {
  --radio-selected: #3b82f6;
  --radio-hover: #60a5fa;
  --radio-focus: #60a5fa80;
  appearance: none;
  box-sizing: border-box;
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin: 0;
  border: 1.5px solid #cbd5e1;
  border-radius: 50%;
  background: #fff;
  cursor: pointer;
  vertical-align: middle;
  transition: border-color 150ms ease, background-color 150ms ease;
}

:global(.dark .radio-button) {
  border-color: #64748b;
  background: #1f2937;
}

.radio-button[data-tone='amber'] {
  --radio-selected: #f59e0b;
  --radio-hover: #fbbf24;
  --radio-focus: #f59e0b66;
}

:global(.dark .radio-button[data-tone='amber']) {
  --radio-selected: #fbbf24;
}

.radio-button:enabled:hover {
  border-color: var(--radio-hover);
}

.radio-button:checked {
  border: 5px solid var(--radio-selected);
  background: #fff;
}

.radio-button:checked:enabled:hover {
  border-color: var(--radio-hover);
}

.radio-button:focus-visible {
  outline: 2px solid var(--radio-focus);
  outline-offset: 3px;
}

.radio-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

@media (prefers-reduced-motion: reduce) {
  .radio-button,
  .radio-button:checked {
    transition: none;
  }
}

@media (forced-colors: active) {
  .radio-button,
  .radio-button:checked {
    appearance: auto;
    border: revert;
    background: revert;
  }
}
</style>
