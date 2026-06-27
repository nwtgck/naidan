<script setup lang="ts">
import { computed, type ShallowRef } from 'vue';
import GlobalDialogHost from '@/components/GlobalDialogHost.vue';
import OnboardingModal from '@/components/OnboardingModal.vue';
import ToastContainer from '@/components/ToastContainer.vue';
import MainLayoutPreview from '@/components/startup/MainLayoutPreview.vue';
import StartupErrorView from '@/components/startup/StartupErrorView.vue';
import { useSettings } from '@/composables/useSettings';
import type { StartupState } from '@/models/startup';

const props = defineProps<{
  startupState: ShallowRef<StartupState>,
}>();

const settingsStore = useSettings();
const startup = computed(() => props.startupState.value);

const renderMainLayoutPreview = computed(() => {
  const state = startup.value;
  switch (state.kind) {
  case 'waiting-for-onboarding':
  case 'starting-main':
    switch (state.mainLayout) {
    case 'preview-not-rendered':
      return false;
    case 'preview-rendered':
      return true;
    default: {
      const _ex: never = state.mainLayout;
      return _ex;
    }
    }
  case 'initializing':
  case 'ready':
  case 'error':
    return false;
  default: {
    const _ex: never = state;
    return _ex;
  }
  }
});

/**
 * WHY: Onboarding can also be reopened after the application is ready. Derive
 * visibility from the existing settings state instead of introducing a second
 * startup-only flag that could disagree with the persisted configuration.
 */
const renderOnboarding = computed(() => {
  if (!settingsStore.initialized.value || settingsStore.isOnboardingDismissed.value) {
    return false;
  }

  const state = startup.value;
  switch (state.kind) {
  case 'waiting-for-onboarding':
  case 'ready':
    return true;
  case 'initializing':
  case 'starting-main':
  case 'error':
    return false;
  default: {
    const _ex: never = state;
    return _ex;
  }
  }
});


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
    // ESLint-required for defineExpose.
  }
});
</script>

<template>
  <MainLayoutPreview v-if="renderMainLayoutPreview" />

  <component
    :is="startup.mainApplication"
    v-else-if="startup.kind === 'ready'"
  />

  <StartupErrorView
    v-else-if="startup.kind === 'error'"
    :error="startup.error"
  />

  <div
    v-else
    data-testid="startup-background"
    class="h-dvh bg-gray-50 dark:bg-gray-950"
  />

  <Transition name="modal">
    <OnboardingModal v-if="renderOnboarding" />
  </Transition>

  <GlobalDialogHost />
  <ToastContainer />
</template>
