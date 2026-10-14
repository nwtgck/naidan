<script setup lang="ts">
import { computed, useAttrs, useSlots } from 'vue';
import { readDocsIslandEntry } from '../islands/core';
import type { DocsIslandEntry } from '../islands/core';

defineOptions({ inheritAttrs: false });

const props = defineProps<{ entry: DocsIslandEntry }>();
if (Object.keys(useAttrs()).length || Object.keys(useSlots()).length) {
  throw new Error('DocsIsland accepts only its entry prop');
}
const data = computed(() => readDocsIslandEntry({ entry: props.entry }));

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
  <div :data-docs-island="data.id" :data-docs-props="data.serialized">
    <component :is="data.component" v-bind="data.canonical" />
  </div>
</template>
