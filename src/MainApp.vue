<script setup lang="ts">
import { computed, defineAsyncComponent, inject } from 'vue';
import { routerKey } from 'vue-router';
import MainAppSurface from '@/components/MainAppSurface.vue';
import { useAppPresentation } from '@/composables/useAppPresentation';
import { provideDocumentMetadata } from '@/composables/useDocumentMetadata';

const AppCommandRuntime = defineAsyncComponent(
  () => import('@/components/AppCommandRuntime.vue'),
);
const AppAuxiliaryUi = defineAsyncComponent(
  () => import('@/components/AppAuxiliaryUi.vue'),
);

const { appInteraction, homeIntroduction, continueHomeIntroduction, finishHomeIntroduction } = useAppPresentation();
// Head management belongs to the lazy main app; startup uses the generated HTML.
provideDocumentMetadata({ router: inject(routerKey, undefined), document, homeIntroduction, continueHomeIntroduction, finishHomeIntroduction });
const postStartupFeatures = computed(() => {
  const interaction = appInteraction.value;
  switch (interaction) {
  case 'blocked-by-startup':
  case 'blocked-by-onboarding':
    return 'inactive' as const;
  case 'enabled':
    return 'active' as const;
  default: {
    const _ex: never = interaction;
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
  <MainAppSurface :post-startup-features="postStartupFeatures" />
  <AppCommandRuntime v-if="postStartupFeatures === 'active'" />
  <AppAuxiliaryUi v-if="postStartupFeatures === 'active'" />
</template>
