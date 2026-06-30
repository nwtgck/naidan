<script setup lang="ts">
import { watch } from 'vue';
import { useRegisterSW } from 'virtual:pwa-register/vue';
import { usePWAUpdate } from '@/composables/usePWAUpdate';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { ensureStrings } from '@/strings';

const {
  offlineReady,
  needRefresh,
  updateServiceWorker,
} = useRegisterSW();

const { setNeedRefresh } = usePWAUpdate();
const { addInfoEvent } = useGlobalEvents();

watch(offlineReady, async (ready) => {
  if (!ready) return;
  const message = await ensureStrings.PWAManager__app_ready_to_work_offline();
  if (!offlineReady.value) return;
  addInfoEvent({
    source: 'PWA',
    message,
  });
});

watch(needRefresh, (refresh) => {
  setNeedRefresh({
    refresh,
    handler: refresh ? async () => {
      await updateServiceWorker();
    } : undefined,
  });
});


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div v-if="false" />
</template>
