<script setup lang="ts">
import { computed } from 'vue';
import { marked, sanitizeHtml } from './useMarkdown';

const props = defineProps<{
  text: string;
}>();

const html = computed(() => {
  if (!props.text) return '';
  // parseInline processes inline elements like bold, italic, links without wrapping in <p>
  const rawHtml = marked.parseInline(props.text) as string;
  return sanitizeHtml({ html: rawHtml });
});


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <span v-html="html"></span>
</template>
