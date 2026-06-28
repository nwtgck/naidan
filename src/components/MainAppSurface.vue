<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue';
import Sidebar from '@/components/Sidebar.vue';
import MainLayoutFrame from '@/components/layout/MainLayoutFrame.vue';
import { useLayout } from '@/composables/useLayout';

type PostStartupFeatureActivation = 'inactive' | 'active';

const props = defineProps<{
  postStartupFeatures: PostStartupFeatureActivation,
}>();

const DebugPanel = defineAsyncComponent(() => import('@/components/DebugPanel.vue'));

const { isSidebarOpen, isDebugOpen } = useLayout();
const sidebarWidth = computed(() => isSidebarOpen.value
  ? 'expanded' as const
  : 'collapsed' as const);
const renderDebugPanel = computed(() => {
  const activation = props.postStartupFeatures;
  switch (activation) {
  case 'inactive':
    return false;
  case 'active':
    return isDebugOpen.value;
  default: {
    const _ex: never = activation;
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
        <DebugPanel v-if="renderDebugPanel" />
      </Transition>
    </template>
  </MainLayoutFrame>
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
