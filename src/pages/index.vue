<script setup lang="ts">
import CurrentChatPane from '@/components/CurrentChatPane.vue';


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <CurrentChatPane />
</template>
