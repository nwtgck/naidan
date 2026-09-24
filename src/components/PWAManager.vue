<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted } from 'vue';
import { waitForPresentationPaint } from '@/logic/startup/presentation-frame';

let disposed = false;
onBeforeUnmount(() => {
  disposed = true;
});

onMounted(async () => {
  /**
   * WHY: AppAuxiliaryUi mounts only after startup and onboarding release the
   * real Sidebar and routed chat surface. Their first paint has priority over
   * PWA checks. Flush Vue's DOM work and give that surface a paint opportunity
   * BEFORE importing the registration client. Do not move this to main.ts or
   * the lightweight startup shell: faster update UI must not slow first paint.
   * This optional work never gates normal startup, navigation or interaction.
   */
  try {
    await nextTick();
    if (disposed) return;
    await waitForPresentationPaint({ window });
    if (disposed) return;
    const { startPWAUpdateRuntime } = await import('@/composables/pwa-update-runtime');
    if (!disposed) startPWAUpdateRuntime();
  } catch (error) {
    console.error('[PWA] Failed to start post-paint update checks.', error);
  }
});

// Once started, registration belongs to the page rather than this component:
// closing/reopening onboarding must not lose an update or register twice.
defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
});
</script>

<template>
  <div v-if="false" />
</template>
