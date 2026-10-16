<script setup lang="ts">
import { docsHref } from '../navigation/routes';
import type { DocsLocale, DocsPageId } from '../navigation/routes';

defineProps<{ locale: DocsLocale; page: DocsPageId; href?: never }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <a :href="docsHref({ locale, page })"><slot /></a>
</template>
