<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue';
import MainAppSurface from '@/components/MainAppSurface.vue';
import { useAppPresentation } from '@/composables/useAppPresentation';

const AppCommandRuntime = defineAsyncComponent(
  () => import('@/components/AppCommandRuntime.vue'),
);
const AppAuxiliaryUi = defineAsyncComponent(
  () => import('@/components/AppAuxiliaryUi.vue'),
);

const emit = defineEmits<{
  initialShellRendered: [],
  initialShellRenderFailed: [payload: { error: unknown }],
}>();

const { appInteraction } = useAppPresentation();
const postStartupFeatures = computed(() => {
  const interaction = appInteraction.value;
  switch (interaction) {
  case 'blocked-by-startup':
  case 'blocked-by-onboarding':
  case 'blocked-by-operation':
    return 'inactive' as const;
  case 'enabled':
    return 'active' as const;
  default: {
    const _ex: never = interaction;
    return _ex;
  }
  }
});
const auxiliaryUiMode = computed(() => {
  const interaction = appInteraction.value;
  switch (interaction) {
  case 'blocked-by-startup':
    // Prepare route-driven presentation, especially Settings Modal, behind the
    // encrypted lock without starting post-startup tools or runtimes.
    return 'preparing' as const;
  case 'blocked-by-operation':
  case 'enabled':
    // Keep the operation's initiating modal mounted while the generic overlay
    // makes the application inert. Unmounting it would discard local UI state
    // and reveal a second lazy render after the operation completes.
    return 'active' as const;
  case 'blocked-by-onboarding':
    return undefined;
  default: {
    const _ex: never = interaction;
    return _ex;
  }
  }
});

let mainSurfaceRendered = false;
let auxiliaryPresentationRendered = false;
let initialShellSettlement: 'pending' | 'rendered' | 'failed' = 'pending';

function reportInitialShellWhenReady(): void {
  if (!mainSurfaceRendered || !auxiliaryPresentationRendered) {
    return;
  }
  switch (initialShellSettlement) {
  case 'pending':
    initialShellSettlement = 'rendered';
    emit('initialShellRendered');
    return;
  case 'rendered':
  case 'failed':
    return;
  default: {
    const _ex: never = initialShellSettlement;
    return _ex;
  }
  }
}

function reportMainSurfaceRendered(): void {
  mainSurfaceRendered = true;
  reportInitialShellWhenReady();
}

function reportAuxiliaryPresentationRendered(): void {
  auxiliaryPresentationRendered = true;
  reportInitialShellWhenReady();
}

function reportInitialShellFailure({ error }: { error: unknown }): void {
  switch (initialShellSettlement) {
  case 'pending':
    initialShellSettlement = 'failed';
    emit('initialShellRenderFailed', { error });
    return;
  case 'rendered':
  case 'failed':
    return;
  default: {
    const _ex: never = initialShellSettlement;
    return _ex;
  }
  }
}


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {})
});
</script>

<template>
  <MainAppSurface
    :post-startup-features="postStartupFeatures"
    @initial-shell-rendered="reportMainSurfaceRendered"
    @initial-shell-render-failed="reportInitialShellFailure"
  />
  <AppCommandRuntime v-if="postStartupFeatures === 'active'" />
  <AppAuxiliaryUi
    v-if="auxiliaryUiMode !== undefined"
    :mode="auxiliaryUiMode"
    @initial-presentation-rendered="reportAuxiliaryPresentationRendered"
    @initial-presentation-render-failed="reportInitialShellFailure"
  />
</template>
