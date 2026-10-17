<script setup lang="ts">
import type { Endpoint } from '@/01-models/types';
import { isHttpEndpoint } from '@/01-models/endpoint';
import { ENDPOINT_PRESETS } from '@/constants';
import { lazyStrings } from '@/strings';

defineProps<{ endpoint: Endpoint, disabled?: boolean, testIdPrefix: string }>();
const emit = defineEmits<{ (e: 'apply', preset: typeof ENDPOINT_PRESETS[number]): void }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div role="group" :aria-label="lazyStrings.EndpointPresetButtons__connection_presets()" tw-class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
    <button v-for="preset in ENDPOINT_PRESETS" :key="preset.name" type="button" :disabled="disabled" :aria-pressed="isHttpEndpoint(endpoint) && endpoint.type === preset.type && endpoint.url === preset.url" :data-testid="`${testIdPrefix}-${preset.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`" class="endpoint-preset-button" tw-class="min-h-8 rounded-md text-xs text-blue-600 transition-colors hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50 dark:text-blue-400 dark:hover:text-blue-300" @click="emit('apply', preset)">{{ preset.name }}</button>
  </div>
</template>
<style scoped>
.endpoint-preset-button[aria-pressed='true'] {
  color: #1d4ed8;
  text-decoration: underline;
  text-underline-offset: 0.25rem;
}
.dark .endpoint-preset-button[aria-pressed='true'] {
  color: #93c5fd;
}
@media (prefers-reduced-motion: reduce) {
  .endpoint-preset-button {
    transition: none;
  }
}
</style>
