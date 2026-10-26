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
  // Startup and ordinary auxiliary UI never wait for development instrumentation.
  void import('./DevelopmentMetaCspRecoveryContent.vue').then(module => {
    if (!disposed) {
      content.value = markRaw(module.default);
    }
  }).catch(() => { /* Without resident recovery, saved meta must not apply. */ });
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <component :is="content" v-if="content !== undefined" />
</template>
