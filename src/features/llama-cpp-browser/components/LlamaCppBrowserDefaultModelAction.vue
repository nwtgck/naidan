<script setup lang="ts">
import LlamaCppBrowserModelActionButton from './LlamaCppBrowserModelActionButton.vue';
import { computed } from 'vue';
import { CheckIcon, GlobeIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { isDefaultLocalModel, type DefaultModelContext } from '@/features/llama-cpp-browser/default-model';
const props = defineProps<{ model: LocalModel, current: DefaultModelContext | undefined, disabled: boolean }>();
const emit = defineEmits<{ select: [model: LocalModel] }>();
const selected = computed(() => isDefaultLocalModel({ model: props.model, current: props.current }));
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <LlamaCppBrowserModelActionButton data-testid="llama-default-model-action" :disabled="disabled || selected" :aria-pressed="selected" @click="emit('select', model)">
    <CheckIcon v-if="selected" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" /><GlobeIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400 transition-colors duration-200 group-hover:text-blue-500 dark:text-gray-500 dark:group-hover:text-blue-400 motion-reduce:transition-none" />{{ selected ? lazyStrings.llamaCppBrowserDownloads__in_use() : lazyStrings.llamaCppBrowserDownloads__set_as_default() }}
  </LlamaCppBrowserModelActionButton>
</template>
