import { ref, inject, provide, type InjectionKey, type Ref } from 'vue';
import type { BinaryObject } from '../models/types';

interface PreviewState {
  objects: BinaryObject[];
  initialId: string;
}

const PREVIEW_KEY: InjectionKey<{
  state: Ref<PreviewState | null>;
  openPreview: (payload: PreviewState) => void;
  closePreview: () => void;
}> = Symbol('ImagePreview');

/**
 * Image Preview Composable
 *
 * Can be used either as a singleton or as a scoped instance via provide/inject.
 */
export function useImagePreview(scoped = false) {
  if (scoped) {
    const state = ref<PreviewState | null>(null);
    const api = {
      state,
      openPreview: (payload: PreviewState) => {
        state.value = payload;
      },
      closePreview: () => {
        state.value = null;
      },
    };
    provide(PREVIEW_KEY, api);
    return api;
  }

  const injected = inject(PREVIEW_KEY, null);
  if (injected) return injected;

  // Fallback to local ref if not provided (allows simple local use in a component)
  const state = ref<PreviewState | null>(null);
  return {
    state,
    openPreview: (payload: PreviewState) => {
      state.value = payload;
    },
    closePreview: () => {
      state.value = null;
    },
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
