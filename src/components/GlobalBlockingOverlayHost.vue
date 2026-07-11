<script setup lang="ts">
import { useGlobalBlockingOverlay } from '@/composables/useGlobalBlockingOverlay';

const { overlay } = useGlobalBlockingOverlay();

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
  <component
    :is="overlay.component"
    v-if="overlay !== undefined"
  />
</template>
