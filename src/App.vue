<script setup lang="ts">
import { computed, defineAsyncComponent, type ShallowRef } from 'vue';
import GlobalDialogHost from '@/components/GlobalDialogHost.vue';
import OnboardingModal from '@/components/OnboardingModal.vue';
import ToastContainer from '@/components/ToastContainer.vue';
import StartupErrorView from '@/components/startup/StartupErrorView.vue';
import { provideAppPresentation } from '@/composables/useAppPresentation';
import type { StartupState } from '@/logic/startup/types';
import { useOpfsEncryptionTransition } from '@/features/opfs-encryption/composables/useOpfsEncryptionTransition';

const OpfsEncryptionTransitionView = defineAsyncComponent(
  () => import('@/features/opfs-encryption/components/OpfsEncryptionTransitionView.vue'),
);
const OpfsEncryptionUnlockView = defineAsyncComponent(
  () => import('@/features/opfs-encryption/components/OpfsEncryptionUnlockView.vue'),
);

const props = defineProps<{
  startupState: ShallowRef<StartupState>,
}>();

const startup = computed(() => props.startupState.value);
const { active: opfsEncryptionTransitionActive } = useOpfsEncryptionTransition();
const {
  onboardingPresentation,
  appInteraction,
} = provideAppPresentation({ startupState: props.startupState });

const appContentInert = computed(() => {
  if (opfsEncryptionTransitionActive.value) {
    return true;
  }
  const interaction = appInteraction.value;
  switch (interaction) {
  case 'blocked-by-startup':
  case 'blocked-by-onboarding':
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
      :is="startup.mainApp"
      v-if="startup.kind === 'rendering-main' || startup.kind === 'ready'"
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

  <OpfsEncryptionTransitionView v-if="opfsEncryptionTransitionActive" />

  <OpfsEncryptionUnlockView
    v-if="startup.kind === 'opfs-encryption-required'"
    :gate="startup.gate"
  />

  <Transition name="modal">
    <OnboardingModal v-if="renderOnboarding" />
  </Transition>

  <GlobalDialogHost />
  <ToastContainer />
</template>
