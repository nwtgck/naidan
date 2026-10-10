import { shallowRef } from 'vue';
import type { ImageGenerationWorkspaceView } from '@/features/image-generation/composables/use-image-generation-workspace';

export type ImageGenerationNavigation = {
  view: ImageGenerationWorkspaceView | undefined,
  openModels: () => void,
  openDiagnostics: () => void,
  openGeneration: () => void,
};
const active = shallowRef<ImageGenerationNavigation>();

export function useImageGenerationWorkspaceNavigation() {
  return {
    active,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

export function registerImageGenerationNavigation({ navigation }: { navigation: ImageGenerationNavigation }): () => void {
  if (active.value) throw new Error('An Image Generation navigation owner is already mounted.');
  active.value = navigation;
  return () => {
    if (active.value === navigation) active.value = undefined;
  };
}

export const TEST_ONLY = {
};
