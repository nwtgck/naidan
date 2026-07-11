<script setup lang="ts">
import { computed, defineAsyncComponent, type Component, type ShallowRef } from 'vue';
import GlobalBlockingOverlayHost from '@/components/GlobalBlockingOverlayHost.vue';
import GlobalDialogHost from '@/components/GlobalDialogHost.vue';
import OnboardingModal from '@/components/OnboardingModal.vue';
import ToastContainer from '@/components/ToastContainer.vue';
import StartupErrorView from '@/components/startup/StartupErrorView.vue';
import { provideAppPresentation } from '@/composables/useAppPresentation';
import type { StartupState } from '@/logic/startup/types';
const OpfsEncryptionUnlockView = defineAsyncComponent(
  () => import('@/features/opfs-encryption/components/OpfsEncryptionUnlockView.vue'),
);

const props = defineProps<{
  startupState: ShallowRef<StartupState>,
}>();

const startup = computed(() => props.startupState.value);

/**
 * WHY: During encrypted startup, MainApp is mounted only after the passphrase
 * has unlocked storage, but the lock presentation intentionally remains in
 * front. Keeping the real app mounted and inert behind that presentation lets
 * Sidebar, ChatPane, and the current route finish their first render before
 * the user sees them, without making normal components support locked storage.
 */
const mainApp = computed<Component | undefined>(() => {
  const state = startup.value;
  switch (state.kind) {
  case 'rendering-main':
  case 'rendering-main-after-opfs-unlock':
  case 'ready':
    return state.mainApp;
  case 'opfs-encryption-main-failed':
    return state.mainApp;
  case 'initializing-foundation':
  case 'opfs-encryption-required':
  case 'starting-main-after-opfs-unlock':
  case 'starting-main':
  case 'foundation-failed':
  case 'main-failed':
    return undefined;
  default: {
    const _ex: never = state;
    return _ex;
  }
  }
});
function reportMainAppInitialShellRendered(): void {
  const state = startup.value;
  switch (state.kind) {
  case 'rendering-main-after-opfs-unlock':
    state.renderGate.reportInitialRender();
    return;
  case 'rendering-main':
  case 'ready':
  case 'opfs-encryption-main-failed':
    return;
  case 'initializing-foundation':
  case 'opfs-encryption-required':
  case 'starting-main-after-opfs-unlock':
  case 'starting-main':
  case 'foundation-failed':
  case 'main-failed':
    throw new Error(`MainApp reported its initial shell from invalid startup state: ${state.kind}`);
  default: {
    const _ex: never = state;
    return _ex;
  }
  }
}

function reportMainAppInitialShellRenderFailed({ error }: { error: unknown }): void {
  const state = startup.value;
  switch (state.kind) {
  case 'rendering-main-after-opfs-unlock':
    state.renderGate.reportInitialRenderFailure({ error });
    return;
  case 'rendering-main':
  case 'ready':
  case 'opfs-encryption-main-failed':
    // The route itself also reports this error through Vue's normal lifecycle
    // error handling. Only encrypted startup has a lock presentation waiting
    // on this explicit gate, so plain/ready states need no second transition.
    return;
  case 'initializing-foundation':
  case 'opfs-encryption-required':
  case 'starting-main-after-opfs-unlock':
  case 'starting-main':
  case 'foundation-failed':
  case 'main-failed':
    throw new Error(`MainApp reported an initial shell failure from invalid startup state: ${state.kind}`, {
      cause: error,
    });
  default: {
    const _ex: never = state;
    return _ex;
  }
  }
}

const opfsEncryptionStartupGate = computed(() => {
  const state = startup.value;
  switch (state.kind) {
  case 'opfs-encryption-required':
  case 'starting-main-after-opfs-unlock':
  case 'rendering-main-after-opfs-unlock':
  case 'opfs-encryption-main-failed':
    return state.gate;
  case 'initializing-foundation':
  case 'starting-main':
  case 'rendering-main':
  case 'ready':
  case 'foundation-failed':
  case 'main-failed':
    return undefined;
  default: {
    const _ex: never = state;
    return _ex;
  }
  }
});
const {
  onboardingPresentation,
  appInteraction,
} = provideAppPresentation({ startupState: props.startupState });

const appContentInert = computed(() => {
  const interaction = appInteraction.value;
  switch (interaction) {
  case 'blocked-by-startup':
  case 'blocked-by-onboarding':
  case 'blocked-by-operation':
    return true;
  case 'enabled':
    return undefined;
  default: {
    const _ex: never = interaction;
    return _ex;
  }
  }
});

const appContentAriaHidden = computed(() => appContentInert.value === true
  ? 'true'
  : undefined);

const renderOnboarding = computed(() => {
  const presentation = onboardingPresentation.value;
  switch (presentation) {
  case 'hidden':
    return false;
  case 'visible':
    return true;
  default: {
    const _ex: never = presentation;
    return _ex;
  }
  }
});


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {})
});
</script>

<template>
  <div
    data-testid="app-content-host"
    :inert="appContentInert"
    :aria-hidden="appContentAriaHidden"
  >
    <component
      :is="mainApp"
      v-if="mainApp !== undefined"
      @initial-shell-rendered="reportMainAppInitialShellRendered"
      @initial-shell-render-failed="reportMainAppInitialShellRenderFailed"
    />

    <StartupErrorView
      v-else-if="startup.kind === 'foundation-failed' || startup.kind === 'main-failed'"
      :error="startup.error"
    />

    <div
      v-else
      data-testid="startup-background"
      tw-class="h-dvh bg-gray-50 dark:bg-gray-950"
    />
  </div>

  <GlobalBlockingOverlayHost />

  <OpfsEncryptionUnlockView
    v-if="opfsEncryptionStartupGate !== undefined"
    :gate="opfsEncryptionStartupGate"
  />

  <Transition name="modal">
    <OnboardingModal v-if="renderOnboarding" />
  </Transition>

  <GlobalDialogHost />
  <ToastContainer />
</template>
