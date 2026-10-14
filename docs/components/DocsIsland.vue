<script setup lang="ts">
import { computed, onServerPrefetch, shallowRef, useAttrs, useSlots } from 'vue';
import type { Component } from 'vue';
import { readDocsIslandEntry } from '../islands/core';
import type { DocsIslandEntry } from '../islands/core';

defineOptions({ inheritAttrs: false });

const props = defineProps<{ entry: DocsIslandEntry }>();
if (Object.keys(useAttrs()).length || Object.keys(useSlots()).length) {
  throw new Error('DocsIsland accepts only its entry prop');
}
const data = computed(() => readDocsIslandEntry({ entry: props.entry }));
const preparationFailure = shallowRef<{ reason: unknown } | undefined>(undefined);

onServerPrefetch(async () => {
  try {
    await data.value.prepare();
  } catch (reason) {
    preparationFailure.value = { reason };
  }
});

function preparedComponent(): Component {
  if (preparationFailure.value) {
    throw new Error('Docs island preparation failed', { cause: preparationFailure.value.reason });
  }
  return data.value.component;
}

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
    <component :is="preparedComponent()" v-bind="data.canonical" />
  </div>
</template>
