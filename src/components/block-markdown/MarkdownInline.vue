<script setup lang="ts">
import { computed } from 'vue';
import { marked } from './useMarkdown';
import ExternalImage from './ExternalImage.vue';
import AllowedHtmlView from '@/components/common/AllowedHtmlView.vue';
import { sanitizeMarkdownHtml, splitMarkdownHtmlByExternalImages } from '@/lib/security/allowedHtml';
import type { MarkdownInlinePart } from '@/lib/security/allowedHtml';

const props = defineProps<{
  text: string,
  mode: 'markdown' | 'html',
}>();

const parts = computed<MarkdownInlinePart[]>(() => {
  if (!props.text) return [];

  const rawHtml = (() => {
    const m = props.mode;
    switch (m) {
    case 'html': return props.text;
    case 'markdown': return marked.parseInline(props.text) as string;
    default: {
      const _ex: never = m;
      return _ex;
    }
    }
  })();

  return splitMarkdownHtmlByExternalImages({
    html: sanitizeMarkdownHtml({ html: rawHtml }),
  });
});

defineExpose({
  TEST_ONLY: {
    parts,
  },
});
</script>

<template>
  <template v-for="(part, idx) in parts" :key="idx">
    <AllowedHtmlView v-if="part.type === 'html'" as="span" :html="part.html" />
    <ExternalImage
      v-else-if="part.type === 'image'"
      :src="part.payload.href"
      :alt="part.payload.text"
      :title="part.payload.title || undefined"
    />
  </template>
</template>
