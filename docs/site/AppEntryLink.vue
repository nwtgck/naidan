<script setup lang="ts">
import { computed } from 'vue';
import { appDestinationPath, appEntryFallbackUrl } from './app-entry';
import type { AppDestination } from './app-entry';
import type { DocsLocale } from './routes';

const props = defineProps<{ destination: AppDestination; locale: DocsLocale; display: 'path' | 'label' }>();
const path = computed(() => appDestinationPath({ destination: props.destination }));
const fallbackUrl = computed(() => appEntryFallbackUrl({ destination: props.destination }));

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <a :href="fallbackUrl" :data-docs-app-entry-path="path">
    <span v-if="display === 'path'" data-docs-app-entry-path-text>{{ path }}</span>
    <slot v-else />
  </a>
</template>

<style scoped>
[data-docs-app-entry-path-text] { overflow-wrap:anywhere; }
</style>
