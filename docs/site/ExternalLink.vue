<script setup lang="ts">
import type { DocsLocale } from './routes';
import { EXTERNAL_LINK_PATH, EXTERNAL_LINK_LABEL, isGitHubUrl } from './external-link';

defineProps<{ href: string; locale: DocsLocale }>();


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
  <a :href="href" :target="isGitHubUrl({ href }) ? '_blank' : undefined" rel="noopener noreferrer" referrerpolicy="no-referrer" data-docs-external>
    <slot />
    <svg viewBox="0 0 24 24" data-docs-external-icon aria-hidden="true" focusable="false">
      <path :d="EXTERNAL_LINK_PATH" />
    </svg>
    <span class="sr-only">{{ EXTERNAL_LINK_LABEL[locale] }}</span>
  </a>
</template>
