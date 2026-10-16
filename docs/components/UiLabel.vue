<script setup lang="ts">
defineProps<{ text: string }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <span class="ui-label">{{ text }}</span>
</template>

<style scoped>
.ui-label {
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  padding: .08em .34em;
  border: 1px solid var(--line-strong);
  border-radius: .32em;
  background: var(--surface-2);
  color: var(--text);
  font-weight: 600;
  overflow-wrap: anywhere;
}
</style>
