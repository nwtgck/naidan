<script setup lang="ts">
import { capitalize } from '@/utils/string';
import type { Settings } from '@/models/types';
import { isHttpEndpoint } from '@/models/endpoint';
import { lazyStrings } from '@/strings';

defineProps<{
  form: Settings,
}>();


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <div class="mt-2 pt-4 border-t border-gray-50 dark:border-gray-800/50">
    <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3 opacity-70">
      {{ lazyStrings.ProviderProfilePreview__configuration_preview() }}
    </p>

    <div class="space-y-2 px-1">
      <!-- Provider & Model -->
      <div class="flex items-center justify-between text-[11px]">
        <span class="text-gray-400 font-medium">{{ lazyStrings.ProviderProfilePreview__provider_and_model() }}</span>
        <span class="font-bold text-gray-500 dark:text-gray-400">
          {{ capitalize({ value: form.endpoint.type }) }} / {{ form.defaultModelId || lazyStrings.ProviderProfilePreview__none() }}
        </span>
      </div>

      <!-- Endpoint URL -->
      <div class="flex items-center justify-between text-[11px]">
        <span class="text-gray-400 font-medium">{{ lazyStrings.ProviderProfilePreview__endpoint_url() }}</span>
        <span class="font-bold text-gray-500 dark:text-gray-400 truncate max-w-[180px]">
          {{ isHttpEndpoint(form.endpoint) ? form.endpoint.url : '' }}
        </span>
      </div>

      <!-- Optional Features (Badges) -->
      <div v-if="(isHttpEndpoint(form.endpoint) && form.endpoint.httpHeaders?.length) || form.systemPrompt || form.lmParameters"
           class="flex items-center gap-2 pt-1">
        <span v-if="isHttpEndpoint(form.endpoint) && form.endpoint.httpHeaders?.length"
              class="text-[9px] font-bold text-gray-400 flex items-center gap-1">
          <span class="w-1 h-1 rounded-full bg-gray-300 dark:bg-gray-600"></span>
          {{ lazyStrings.ProviderProfilePreview__headers() }}
        </span>
        <span v-if="form.systemPrompt"
              class="text-[9px] font-bold text-gray-400 flex items-center gap-1">
          <span class="w-1 h-1 rounded-full bg-gray-300 dark:bg-gray-600"></span>
          {{ lazyStrings.ProviderProfilePreview__system_prompt() }}
        </span>
        <span v-if="form.lmParameters"
              class="text-[9px] font-bold text-gray-400 flex items-center gap-1">
          <span class="w-1 h-1 rounded-full bg-gray-300 dark:bg-gray-600"></span>
          {{ lazyStrings.ProviderProfilePreview__lm_params() }}
        </span>
      </div>
    </div>
  </div>
</template>
