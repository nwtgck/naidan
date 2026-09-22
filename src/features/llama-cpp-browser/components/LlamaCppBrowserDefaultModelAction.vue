<script setup lang="ts">
import { computed } from 'vue';
import { CheckIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { isDefaultLocalModel, type DefaultModelContext } from '@/features/llama-cpp-browser/default-model';
const props = defineProps<{ model: LocalModel, current: DefaultModelContext | undefined, disabled: boolean }>();
const emit = defineEmits<{ select: [model: LocalModel] }>();
const selected = computed(() => isDefaultLocalModel({ model: props.model, current: props.current }));
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <button type="button" data-testid="llama-default-model-action" :disabled="disabled || selected" :aria-pressed="selected" :tw-class="['inline-flex max-w-full items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 disabled:cursor-not-allowed', selected ? 'border-transparent text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/20' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 disabled:opacity-50']" @click="emit('select', model)">
    <CheckIcon v-if="selected" tw-class="w-3.5 h-3.5 shrink-0" />{{ selected ? lazyStrings.llamaCppBrowserDownloads__in_use() : lazyStrings.llamaCppBrowserDownloads__set_as_default() }}
  </button>
</template>
