<script setup lang="ts">
import { markRaw, onErrorCaptured, onMounted, onScopeDispose, shallowRef, type Component } from 'vue';

defineProps<{ element: Element | undefined, revision: string | number, presentation: 'compact' | 'error' }>();
const content = shallowRef<Component>();
let disposed = false;
onScopeDispose(() => {
  disposed = true;
});
onErrorCaptured(() => {
  content.value = undefined;
  return false;
});
onMounted(() => {
  void import('./MarkdownResourceCspHintsContent.vue').then(module => {
    if (!disposed) {
      content.value = markRaw(module.default);
    }
  }).catch(() => { /* The existing Markdown remains usable without diagnostics. */ });
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
  <component :is="content" v-if="content !== undefined" :element="element" :revision="revision" :presentation="presentation" />
</template>
