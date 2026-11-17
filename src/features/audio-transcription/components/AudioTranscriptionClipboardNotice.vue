<script setup lang="ts">
import { CircleAlertIcon } from 'lucide-vue-next';

defineProps<{ message: string }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <span role="status" :title="message" tw-class="inline-flex max-w-full items-center gap-1.5 rounded-md bg-amber-50 px-1.5 py-0.5 font-medium leading-5 text-amber-800 dark:bg-amber-400/10 dark:text-amber-200">
    <CircleAlertIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />
    <span tw-class="truncate">{{ message }}</span>
  </span>
</template>
