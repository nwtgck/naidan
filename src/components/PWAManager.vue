<script setup lang="ts">
import { watch } from 'vue';
import { useRegisterSW } from 'virtual:pwa-register/vue';
import { usePWAUpdate } from '@/composables/usePWAUpdate';
import { useGlobalEvents } from '@/composables/useGlobalEvents';

const {
  offlineReady,
  needRefresh,
  updateServiceWorker,
} = useRegisterSW();

const { setNeedRefresh } = usePWAUpdate();
const { addInfoEvent } = useGlobalEvents();

watch(offlineReady, (ready) => {
  if (ready) {
    addInfoEvent({
      source: 'PWA',
      message: 'App ready to work offline',
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
