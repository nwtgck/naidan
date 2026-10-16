<script setup lang="ts">
import { computed } from 'vue';
import { appDestinationPath, appEntryFallbackUrl } from '../navigation/app-entry';
import type { AppDestination } from '../navigation/app-entry';
import type { DocsLocale } from '../navigation/routes';

const props = defineProps<{ destination: AppDestination; locale: DocsLocale; display: 'path' | 'label'; href?: never }>();
const path = computed(() => appDestinationPath({ destination: props.destination }));
const fallbackUrl = computed(() => appEntryFallbackUrl({ destination: props.destination }));
const pathText = computed(() => {
  const destination = props.destination;
  switch (destination.kind) {
  case 'screen': {
    switch (destination.screen) {
    case 'home': return 'Naidan';
    case 'gguf-manager':
    case 'transformers-js-manager':
    case 'connection':
    case 'files-settings':
    case 'folders-settings':
    case 'image-generation':
    case 'audio-generation': return path.value;
    default: { const unreachable: never = destination.screen; throw new Error(`Unknown app screen: ${String(unreachable)}`); }
    }
  }
  case 'model': return path.value;
  default: { const unreachable: never = destination; throw new Error(`Unknown app destination: ${String(unreachable)}`); }
  }
});

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <a :href="fallbackUrl" :data-docs-app-entry-path="path">
    <span v-if="display === 'path'" data-docs-app-entry-path-text>{{ pathText }}</span>
    <slot v-else />
  </a>
</template>

<style scoped>
[data-docs-app-entry-path-text] {
  overflow-wrap: anywhere;
}
</style>
