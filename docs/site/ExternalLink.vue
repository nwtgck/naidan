<script setup lang="ts">
import { computed } from 'vue';
import type { DocsLocale } from './routes';
import { EXTERNAL_LINK_PATH, EXTERNAL_LINK_LABEL, isGitHubUrl } from './external-link';

const props = defineProps<{ href: string; locale: DocsLocale }>();
const externalHref = computed(() => {
  let url: URL;
  try {
    url = new URL(props.href);
  } catch {
    throw new Error(`ExternalLink requires an absolute HTTP(S) URL: ${props.href}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`ExternalLink requires an absolute HTTP(S) URL: ${props.href}`);
  }
  return url.href;
});


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
  <a :href="externalHref" :target="isGitHubUrl({ href: externalHref }) ? '_blank' : undefined" rel="noopener noreferrer" referrerpolicy="no-referrer" data-docs-external>
    <slot />
    <svg viewBox="0 0 24 24" data-docs-external-icon aria-hidden="true" focusable="false">
      <path :d="EXTERNAL_LINK_PATH" />
    </svg>
    <span class="sr-only">{{ EXTERNAL_LINK_LABEL[locale] }}</span>
  </a>
</template>
