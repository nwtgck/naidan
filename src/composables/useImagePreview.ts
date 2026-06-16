import { ref, inject, provide, type InjectionKey, type Ref } from 'vue';
import type { BinaryObject } from '@/models/types';
import type { BinaryObjectId } from '@/models/ids';

interface PreviewState {
  objects: BinaryObject[];
  initialId: BinaryObjectId;
}

interface ImagePreviewApi {
  state: Ref<PreviewState | null>;
  openPreview: ({ objects, initialId }: PreviewState) => void;
  closePreview: () => void;
  TEST_ONLY: Record<never, never>;
}

export type ContextualPreviewHandler = ({ id }: { id: BinaryObjectId }) => Promise<void>;

export const MESSAGE_CONTEXTUAL_PREVIEW_KEY: InjectionKey<ContextualPreviewHandler> = Symbol('MessageContextualPreview');

const PREVIEW_KEY: InjectionKey<{
  state: Ref<PreviewState | null>;
  openPreview: ({ objects, initialId }: PreviewState) => void;
  closePreview: () => void;
}> = Symbol('ImagePreview');

/**
 * Image Preview Composable
 *
 * Can be used either as a singleton or as a scoped instance via provide/inject.
 */
export function useImagePreview({ scoped = false }: { scoped?: boolean } = {}): ImagePreviewApi {
  if (scoped) {
    const state = ref<PreviewState | null>(null);
    const api = {
      state,
      openPreview: ({ objects, initialId }: PreviewState) => {
        state.value = { objects, initialId };
      },
      closePreview: () => {
        state.value = null;
      },
      TEST_ONLY: {},
    };
    provide(PREVIEW_KEY, api);
    return api;
  }

  const injected = inject(PREVIEW_KEY, null);
  if (injected) return { ...injected, TEST_ONLY: {} };

  // Fallback to local ref if not provided (allows simple local use in a component)
  const state = ref<PreviewState | null>(null);
  return {
    state,
    openPreview: ({ objects, initialId }: PreviewState) => {
      state.value = { objects, initialId };
    },
    closePreview: () => {
      state.value = null;
    },
    TEST_ONLY: {},
  };
}
