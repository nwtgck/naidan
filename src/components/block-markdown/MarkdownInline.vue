<script setup lang="ts">
import { computed, shallowRef, type VNodeRef } from 'vue';
import { marked } from './useMarkdown';
import ExternalImage from './ExternalImage.vue';
import AllowedHtmlView from '@/components/common/AllowedHtmlView.vue';
import { sanitizeMarkdownHtml, splitMarkdownHtmlByExternalImages } from '@/logic/security/allowedHtml';
import type { MarkdownInlinePart } from '@/logic/security/allowedHtml';
import MarkdownResourceCspHints from './MarkdownResourceCspHints.vue';

const props = defineProps<{
  text: string,
  mode: 'markdown' | 'html',
}>();

const htmlElements = shallowRef<ReadonlyMap<number, Element>>(new Map());
const elementRefs = new Map<number, VNodeRef>();

function mayHaveResourceHints({ html, index }: { html: string, index: number }): boolean {
  // Ordinary text fragments do not need observers or diagnostic components.
  return index < 128 && html.length <= 65_536 && (/<(?:audio|video|source|track|svg|input|table|td|th|form|style)\b/i.test(html) || /\sstyle\s*=/i.test(html));
}

function htmlElementRef({ index }: { index: number }): VNodeRef | undefined {
  // Only a bounded number of existing fragments are observed for optional hints.
  if (index >= 128) {
    return undefined;
  }
  const existing = elementRefs.get(index);
  if (existing !== undefined) {
    return existing;
  }
  const callback: VNodeRef = value => {
    try {
      const node: unknown = value instanceof Element ? value : value?.$el;
      const element = node instanceof Element ? node : undefined;
      if (htmlElements.value.get(index) === element) {
        return;
      }
      const updated = new Map(htmlElements.value);
      if (element === undefined) {
        updated.delete(index);
      } else {
        updated.set(index, element);
      }
      htmlElements.value = updated;
    } catch {
      // A failed diagnostic ref must not interrupt Markdown's normal render.
    }
  };
  elementRefs.set(index, callback);
  return callback;
}

const parts = computed<MarkdownInlinePart[]>(() => {
  if (!props.text) {
    return [];
  }

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
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      parts,
    },
  }) || {}),
});
</script>

<template>
  <template v-for="(part, idx) in parts" :key="idx">
    <template v-if="part.type === 'html'">
      <AllowedHtmlView :ref="mayHaveResourceHints({ html: part.html, index: idx }) ? htmlElementRef({ index: idx }) : undefined" as="span" :html="part.html" />
      <MarkdownResourceCspHints v-if="mayHaveResourceHints({ html: part.html, index: idx })" :element="htmlElements.get(idx)" :revision="part.html" presentation="compact" />
    </template>
    <ExternalImage
      v-else-if="part.type === 'image'"
      :src="part.payload.href"
      :alt="part.payload.text"
      :title="part.payload.title || undefined"
    />
  </template>
</template>
