<script setup lang="ts">
import { lazyStrings } from '@/strings';
defineProps<{ show: boolean }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div v-if="show" tw-class="mt-4 rounded-xl border border-blue-200 dark:border-blue-900 p-4 space-y-2" data-testid="llama-cpp-browser-upsell">
    <p tw-class="text-xs text-gray-600 dark:text-gray-300">{{ lazyStrings.llamaCppBrowser__import_downloaded_gguf() }}</p>
    <router-link :to="{ query: { ...$route.query, settings: 'llama-cpp-browser' } }" tw-class="text-sm font-bold text-blue-600 dark:text-blue-400">
      {{ lazyStrings.llamaCppBrowser__manage_gguf_models() }}
    </router-link>
  </div>
</template>
