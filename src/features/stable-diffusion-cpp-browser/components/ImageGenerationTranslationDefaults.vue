<script setup lang="ts">
import { useImageGenerationWorkspaceNavigation } from '@/features/stable-diffusion-cpp-browser/session/navigation';
import { lazyStrings } from '@/strings';
import ImageSettingsSection from './ImageSettingsSection.vue';
import ImageGenerationTranslationSettings from './ImageGenerationTranslationSettings.vue';
const { active } = useImageGenerationWorkspaceNavigation();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <ImageSettingsSection :title="lazyStrings.imageGeneration__translation_default_settings()" :summary="lazyStrings.imageGeneration__translation_defaults_help()" data-testid="translation-default-settings"><ImageGenerationTranslationSettings v-if="active?.view" :workspace="active.view" scope="workspace" /></ImageSettingsSection>
</template>
