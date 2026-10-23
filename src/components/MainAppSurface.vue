<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue';
import HomeWelcome from '@/components/HomeWelcome.vue';
import Sidebar from '@/components/Sidebar.vue';
import { useImageGenerationWorkspaceNavigation } from '@/features/image-generation/session/navigation';
import MainLayoutFrame from '@/components/layout/MainLayoutFrame.vue';
import { useLayout } from '@/composables/useLayout';
import { useAppEntry } from '@/composables/useAppEntry';

type PostStartupFeatureActivation = 'inactive' | 'active';

const props = defineProps<{
  postStartupFeatures: PostStartupFeatureActivation,
}>();

const { active: generationNavigation } = useImageGenerationWorkspaceNavigation();
const ImageGenerationSidebar = defineAsyncComponent(() => import('@/features/image-generation/components/ImageGenerationSidebar.vue'));
const DebugPanel = defineAsyncComponent(() => import('@/components/DebugPanel.vue'));
const AppEntrySurface = defineAsyncComponent(() => import('@/components/AppEntrySurface.vue'));
const entry = useAppEntry();
const renderEntry = computed(() => {
  const kind = entry.intent.value.kind;
  switch (kind) {
  case 'home':
  case 'model-preview':
    return true;
  case 'pending':
  case 'ordinary':
    return false;
  default: {
    const _ex: never = kind;
    return _ex;
  }
  }
});

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
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <MainLayoutFrame :sidebar-width="sidebarWidth">
    <template #sidebar>
      <ImageGenerationSidebar v-if="generationNavigation && !renderEntry" :navigation="generationNavigation" />
      <Sidebar v-else />
    </template>

    <template #main>
      <div tw-class="flex-1 relative min-h-0">
        <HomeWelcome v-if="entry.intent.value.kind === 'home'" />
        <AppEntrySurface v-else-if="renderEntry" />
        <router-view v-else v-slot="{ Component }">
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
