<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue';
import Sidebar from '@/components/Sidebar.vue';
import MainLayoutFrame from '@/components/layout/MainLayoutFrame.vue';
import { useApplicationPresentation } from '@/composables/useApplicationPresentation';
import { useLayout } from '@/composables/useLayout';

const ApplicationCommandRuntime = defineAsyncComponent(
  () => import('@/components/ApplicationCommandRuntime.vue'),
);
const ApplicationAuxiliaryUi = defineAsyncComponent(
  () => import('@/components/ApplicationAuxiliaryUi.vue'),
);
const DebugPanel = defineAsyncComponent(() => import('@/components/DebugPanel.vue'));

const { applicationInteraction } = useApplicationPresentation();
const { isSidebarOpen, isDebugOpen } = useLayout();
const sidebarWidth = computed(() => isSidebarOpen.value
  ? 'expanded' as const
  : 'collapsed' as const);

const renderPostStartupRuntime = computed(() => {
  const interaction = applicationInteraction.value;
  switch (interaction) {
  case 'blocked-by-startup':
  case 'blocked-by-onboarding':
    return false;
  case 'enabled':
    return true;
  default: {
    const _ex: never = interaction;
    return _ex;
  }
  }
});


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <MainLayoutFrame :sidebar-width="sidebarWidth">
    <template #sidebar>
      <Sidebar />
    </template>

    <template #main>
      <div class="flex-1 relative min-h-0">
        <router-view v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
      </div>
      <Transition name="debug-panel">
        <DebugPanel v-if="renderPostStartupRuntime && isDebugOpen" />
      </Transition>
    </template>
  </MainLayoutFrame>

  <ApplicationCommandRuntime v-if="renderPostStartupRuntime" />
  <ApplicationAuxiliaryUi v-if="renderPostStartupRuntime" />
</template>

<style scoped>
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.debug-panel-enter-active,
.debug-panel-leave-active {
  transition: all 0.3s ease-in-out;
  overflow: hidden;
}

.debug-panel-enter-from,
.debug-panel-leave-to {
  height: 0 !important;
  opacity: 0;
  border-top-width: 0;
}
</style>
