<script setup lang="ts">
import { docsHref } from './routes';
import type { DocsLocale, DocsPageId } from './routes';

defineProps<{ locale: DocsLocale; page: DocsPageId; href?: never }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <a :href="docsHref({ locale, page })"><slot /></a>
</template>
