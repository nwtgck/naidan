<script setup lang="ts">
// Share the appearance while callers retain their native input or button,
// accessible name, state, disabled rules and events.
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <span class="toggle-switch">
    <slot />
    <span aria-hidden="true" class="toggle-switch-thumb" />
  </span>
</template>
<style scoped>
.toggle-switch {
  --toggle-track: #d1d5db;
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  width: 46px;
  height: 22px;
  border-radius: 999px;
  vertical-align: middle;
  transition: transform 200ms ease;
}

:global(.dark .toggle-switch) {
  --toggle-track: #4b5563;
}

.toggle-switch:has(:checked, [aria-checked='true']) {
  --toggle-track: #3b82f6;
}

.toggle-switch:has(:checked, [aria-checked='true']):hover:not(:has(:disabled)) {
  --toggle-track: #60a5fa;
}

.toggle-switch :deep(input[type='checkbox']),
.toggle-switch :deep(button[role='switch']) {
  appearance: none;
  display: block;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  border: 1px solid rgb(255 255 255 / 0.1);
  border-radius: inherit;
  background: var(--toggle-track);
  cursor: pointer;
  transition: background-color 200ms ease;
}

.toggle-switch :deep(:focus-visible) {
  outline: 2px solid #60a5fa80;
  outline-offset: 3px;
}

.toggle-switch:has(:active:enabled) {
  transform: scale(0.95);
}

.toggle-switch:has(:disabled) {
  opacity: 0.5;
}

.toggle-switch :deep(:disabled) {
  cursor: not-allowed;
}

.toggle-switch-thumb {
  position: absolute;
  left: 2px;
  top: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: white;
  box-shadow: 0 1px 2px #0002;
  pointer-events: none;
  transition: left 200ms ease-out;
}

.toggle-switch:has(:checked, [aria-checked='true']) .toggle-switch-thumb {
  left: calc(100% - 20px);
}

@media (prefers-reduced-motion: reduce) {
  .toggle-switch,
  .toggle-switch :deep(input),
  .toggle-switch :deep(button),
  .toggle-switch-thumb {
    transition: none;
  }

  .toggle-switch:has(:active:enabled) {
    transform: none;
  }
}

@media (forced-colors: active) {
  .toggle-switch :deep(input[type='checkbox']) {
    appearance: auto;
  }

  .toggle-switch:has(input) .toggle-switch-thumb {
    visibility: hidden;
  }

  .toggle-switch :deep(button) {
    border-color: ButtonText;
    background: Canvas;
  }

  .toggle-switch-thumb {
    background: ButtonText;
  }
}
</style>
