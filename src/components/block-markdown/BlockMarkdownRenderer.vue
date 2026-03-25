<script setup lang="ts">
import { computed } from 'vue';
import type { Component } from 'vue';
import { marked } from './useMarkdown'; // Re-use the configured instance
import BlockMarkdownItem from './BlockMarkdownItem.vue';

const props = defineProps<{
  content: string;
  trailingInline?: Component;
}>();

const tokens = computed(() => {
  // Use marked.lexer to break content into blocks.
  // We use the configured instance just in case extensions affect lexing,
  // although usually extensions affect parsing/rendering.
  return marked.lexer(props.content);
});

// Index of the last token that actually renders visible content.
// Skips trailing tokens like 'space' and 'def' that produce no output.
const NON_RENDERING_TYPES = new Set(['space', 'def']);
const lastRenderableIndex = computed(() => {
  for (let i = tokens.value.length - 1; i >= 0; i--) {
    if (!NON_RENDERING_TYPES.has(tokens.value[i]!.type)) return i;
  }
  return tokens.value.length - 1;
});


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="prose prose-sm dark:prose-invert max-w-none text-gray-800 dark:text-gray-200 overflow-x-auto leading-relaxed">
    <BlockMarkdownItem
      v-for="(token, index) in tokens"
      :key="index"
      :token="token"
      :trailing-inline="index === lastRenderableIndex ? trailingInline : undefined"
    />
  </div>
</template>
