<script setup lang="ts">
import { useRoute } from 'vue-router';
import LlamaCppBrowserModelLaunchEntry from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelLaunchEntry.vue';
const route = useRoute();
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
  <LlamaCppBrowserModelLaunchEntry v-if="route.query['llama-cpp-browser-model'] !== undefined" :input="route.query['llama-cpp-browser-model']" />
  <CurrentChatPane v-else />
</template>
