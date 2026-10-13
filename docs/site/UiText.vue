<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ text: string }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });

// Only copy passed through this component treats full-width brackets as UI-label annotations.
// Commands, paths, demo copy, and document metadata remain ordinary text.
const runs = computed(() => {
  const parts: { text: string; kind: 'text' | 'label' }[] = [];
  const pattern = /［([^［］]+)］/g;
  let start = 0;
  for (const match of props.text.matchAll(pattern)) {
    const index = match.index;
    if (index > start) parts.push({ text: props.text.slice(start, index), kind: 'text' });
    parts.push({ text: match[1] ?? '', kind: 'label' });
    start = index + match[0].length;
  }
  if (start < props.text.length) parts.push({ text: props.text.slice(start), kind: 'text' });
  return parts;
});
</script>

<template>
  <template v-for="(run, index) in runs" :key="index">
    <span v-if="run.kind === 'label'" class="ui-label">{{ run.text }}</span>
    <template v-else>{{ run.text }}</template>
  </template>
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
