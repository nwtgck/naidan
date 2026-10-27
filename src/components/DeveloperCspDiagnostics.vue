<script setup lang="ts">
import { markRaw, onErrorCaptured, onMounted, onScopeDispose, shallowRef, type Component } from 'vue';

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
  void import('./csp/DeveloperCspDiagnosticsContent.vue').then(module => {
    if (!disposed) {
      content.value = markRaw(module.default);
    }
  }).catch(() => { /* Optional diagnostics must not break the Developer tab. */ });
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
  <component :is="content" v-if="content !== undefined" />
</template>
