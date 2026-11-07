<script setup lang="ts">
import { ref, watch } from 'vue';
import type { WorkflowResultSource } from '@/features/workflow/logic/result-view';
import { lazyStrings } from '@/strings';
import WorkflowResultViewer from './WorkflowResultViewer.vue';
const props = defineProps<{ sources: WorkflowResultSource[] }>();
const count = ref(20);
watch(() => props.sources, () => {
  count.value = 20;
});


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
  <section v-if="sources.length" tw-class="space-y-3">
    <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__result_view_limit() }}</p>
    <WorkflowResultViewer v-for="source in sources.slice(0, count)" :key="source.id" :source="source" />
    <button v-if="count < sources.length" type="button" @click="count += 20" tw-class="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-xs">{{ lazyStrings.workflow__more_results() }}</button>
  </section>
</template>
