<script setup lang="ts">
import { watch } from 'vue';
import { useRegisterSW } from 'virtual:pwa-register/vue';
import { useToast } from '../composables/useToast';
import { usePWAUpdate } from '../composables/usePWAUpdate';

const {
  offlineReady,
  needRefresh,
  updateServiceWorker,
} = useRegisterSW();

const { addToast } = useToast();
const { setNeedRefresh } = usePWAUpdate();

watch(offlineReady, (ready) => {
  if (ready) {
    addToast({
      message: 'App ready to work offline',
      duration: 5000,
    });
  }
});

watch(needRefresh, (refresh) => {
  setNeedRefresh({
    refresh,
    handler: refresh ? async () => {
      await updateServiceWorker();
    } : undefined
  });
});


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div v-if="false" />
</template>
