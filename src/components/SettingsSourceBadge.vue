<script lang="ts">
export type SettingsSourcePresentation = { label: string | undefined, description: string | undefined };
</script>
<script setup lang="ts">
const props = defineProps<{ source: SettingsSourcePresentation | undefined }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <span v-if="props.source" :title="props.source.description" tw-class="inline-flex h-4 max-w-[70%] shrink-0 items-center rounded border border-gray-200/80 bg-gray-100/70 px-1.5 text-[11px] font-medium leading-none text-gray-500 dark:border-gray-700/70 dark:bg-gray-800/80 dark:text-gray-400"><span tw-class="truncate">{{ props.source.label }}</span></span>
</template>
