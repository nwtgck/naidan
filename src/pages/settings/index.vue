<script setup lang="ts">
import { useRouter } from 'vue-router';
import {
  useInitialRouteRenderReadinessClaim,
} from '@/logic/startup/initial-route-render-readiness';
import { onMounted, onUnmounted } from 'vue';
const router = useRouter();
const initialRouteRenderReadiness = useInitialRouteRenderReadinessClaim();

onMounted(async () => {
  try {
    // This component is only a redirect and must never release the encrypted
    // startup lock while its blank placeholder is mounted. The destination
    // route owns readiness after navigation replaces this component.
    await router.replace('/settings/connection');
  } catch (error) {
    initialRouteRenderReadiness.reportFailure({ error });
    throw error;
  }
});
onUnmounted(() => {
  initialRouteRenderReadiness.cancel();
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
  <div />
</template>
