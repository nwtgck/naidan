<script setup lang="ts">
import { useId } from 'vue';
import { lazyStrings } from '@/strings';
defineProps<{ repository: string, headingId?: string }>();
const fallbackId = useId();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <header v-if="repository" data-testid="model-launch-heading" tw-class="min-w-0 text-center space-y-2 sm:space-y-3">
    <p tw-class="text-xs sm:text-sm font-medium text-gray-500 dark:text-gray-400 break-all">{{ repository.split('/')[0] }}</p>
    <h2 :id="headingId ?? fallbackId" tw-class="text-2xl sm:text-4xl font-bold tracking-tight leading-tight text-gray-900 dark:text-gray-100 break-words">{{ repository.split('/').slice(1).join('/') }}</h2>
    <p tw-class="text-sm leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserModelLaunch__no_installation_or_environment_setup() }}</p>
  </header>
</template>
