<script setup lang="ts">
import type { CommonMessages } from './messages';
import type { DocsLocale, DocsPageId } from './routes';
import DocsGuideTree from './DocsGuideTree.vue';

defineProps<{ locale: DocsLocale; page: DocsPageId; copy: CommonMessages['navigation'] }>();

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <details class="docs-guide-menu" data-testid="docs-guide-menu">
    <summary class="control docs-guide-trigger">
      {{ copy.title }}<svg class="docs-guide-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m2 4 4 4 4-4" /></svg>
    </summary>
    <div class="docs-guide-panel">
      <DocsGuideTree :locale="locale" :page="page" :copy="copy" :label="copy.title" id-prefix="header" group-mode="expanded" />
    </div>
  </details>
</template>
