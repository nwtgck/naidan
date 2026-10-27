<script setup lang="ts">
import { useId } from 'vue';
import { ArrowRightIcon, GaugeIcon, Loader2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import LlamaCppBrowserModelActionButton from './LlamaCppBrowserModelActionButton.vue';

defineProps<{ loading: boolean, error: string | undefined }>();
const emit = defineEmits<{ open: [] }>();
const id = useId();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section :aria-labelledby="`${id}-heading`" tw-class="rounded-xl border border-gray-200/70 bg-white/60 p-4 dark:border-gray-800/80 dark:bg-gray-900/20">
    <div tw-class="flex flex-wrap items-start gap-3">
      <span tw-class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50/80 text-blue-500 dark:bg-blue-500/10 dark:text-blue-400"><GaugeIcon aria-hidden="true" tw-class="h-4 w-4" /></span>
      <div tw-class="min-w-0 flex-[1_1_14rem] space-y-1">
        <h3 :id="`${id}-heading`" tw-class="text-sm font-semibold leading-5 text-gray-700 dark:text-gray-300">{{ lazyStrings.llamaCppPerformance__speed_investigation() }}</h3>
        <p tw-class="text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppPerformance__measure_saved_models() }}</p>
      </div>
      <LlamaCppBrowserModelActionButton :disabled="loading" :aria-busy="loading" data-testid="open-llama-cpp-performance" tw-class="ml-auto text-sm!" @click="emit('open')">{{ lazyStrings.llamaCppPerformance__open_speed_investigation() }}<Loader2Icon v-if="loading" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500 dark:text-blue-400 motion-reduce:animate-none" /><ArrowRightIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 transition-transform duration-200 group-hover:translate-x-0.5 dark:text-blue-400 motion-reduce:transform-none" /></LlamaCppBrowserModelActionButton>
    </div>
    <p v-if="error" role="alert" tw-class="ml-11 mt-2 break-words text-xs leading-5 text-red-600 dark:text-red-400">{{ error }}</p>
  </section>
</template>
