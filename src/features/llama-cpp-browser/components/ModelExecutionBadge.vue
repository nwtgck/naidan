<script setup lang="ts">
import type { ModelExecution } from '@/features/llama-cpp-browser/performance/model-execution-schema';
import { lazyStrings } from '@/strings';
defineProps<{ execution: ModelExecution | undefined }>();


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <span data-testid="model-execution-badge" tw-class="inline-flex max-w-64 flex-col gap-0.5 rounded-md bg-gray-100 px-2 py-1 text-xs leading-4 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
    <template v-if="execution?.kind === 'registeredModelGraph'">
      <span tw-class="font-medium text-amber-800 dark:text-amber-300">{{ lazyStrings.ModelExecutionBadge__registered_model_graph() }}</span>
      <span tw-class="break-words">{{ execution.label }}</span>
      <code :title="execution.definitionSha256" tw-class="break-all text-[10px]">{{ execution.definitionSha256.slice(0, 12) }}</code>
    </template>
    <template v-else-if="execution?.kind === 'nativeArchitecture'">{{ lazyStrings.ModelExecutionBadge__native_architecture() }}</template>
    <template v-else>{{ lazyStrings.ModelExecutionBadge__execution_not_observed() }}</template>
  </span>
</template>
