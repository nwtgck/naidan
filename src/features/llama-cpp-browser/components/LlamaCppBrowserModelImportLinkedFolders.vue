<script setup lang="ts">
import { useLlamaCppBrowserSettingsTypography } from '@/features/llama-cpp-browser/composables/useLlamaCppBrowserSettingsTypography';
import { watch } from 'vue';
import { useModelDownloadDestination } from '@/features/llama-cpp-browser/composables/useModelDownloadDestination';
import LinkedModelDirectories from '@/components/LinkedModelDirectories.vue';
import { lazyStrings } from '@/strings';

const props = defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ busy: [value: boolean], changed: [] }>();
const linked = useModelDownloadDestination({ blocked: () => props.disabled, changed: () => emit('changed') });
const failure = linked.failure;
watch(linked.view.busy, busy => emit('busy', busy));
const isSettingsTypography = useLlamaCppBrowserSettingsTypography();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <LinkedModelDirectories :tw-class="[isSettingsTypography && '[&_.linked-model-directory-caption]:text-xs [&_.linked-model-directory-entry]:text-sm']" :view="linked.view" :disabled="disabled" />
  <p v-if="failure" role="alert" tw-class="text-left text-xs text-red-600 dark:text-red-400">{{ lazyStrings.llamaCppBrowser__operation_failed() }}</p>
</template>
