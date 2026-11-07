import { shallowRef } from 'vue';

export type TranslationNavigation = { openWorkspace: () => void, openModels: () => void };
const active = shallowRef<TranslationNavigation>();

export function useTranslationNavigation() {
  return { active, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export function registerTranslationNavigation({ navigation }: { navigation: TranslationNavigation }): () => void {
  if (active.value) {
    throw new Error('A Translation navigation owner is already mounted.');
  }
  active.value = navigation;
  return () => {
    if (active.value === navigation) {
      active.value = undefined;
    }
  };
}

export const TEST_ONLY = {
};
