import { opfsFormat } from '@/00-format/01-layout/layout';
import { validateImageGenerationId } from '@/00-format/image-generation-record';
import type { ImageCompositionDraft } from '@/01-models/image-generation';
import { imageGenerationIo } from './files';
import { imageGenerationSessionDirectory } from './tables';
import { assertImageGenerationReplacement, withImageGenerationStore, type ImageGenerationStoreAccess } from './context';
import { idToRaw, type ImageGenerationSessionId } from '@/01-models/ids';

export async function loadImageGenerationComposition({ store, sessionId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId }): Promise<ImageCompositionDraft | undefined> {
  validateImageGenerationId({ id: sessionId });
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await imageGenerationSessionDirectory({ directory, sessionId });
      if (!session) {
        throw new Error('The composition session no longer exists.');
      }
      const definition = opfsFormat.storage.experimental.imageGeneration.sessions.root({ rawId: idToRaw({ id: sessionId }) });
      const io = imageGenerationIo({ directory: session, path: definition.path });
      return (await definition.compositionDraft.read({ io }))?.value;
    },
  });
}

/** Independent from the single-form draft. Acceptance may require more than a
 * checkpoint being editable. */
export async function saveImageGenerationComposition({ store, draft, expectedRevision }: { store: ImageGenerationStoreAccess, draft: ImageCompositionDraft, expectedRevision: number | undefined }): Promise<void> {
  const definition = opfsFormat.storage.experimental.imageGeneration.sessions.root({ rawId: idToRaw({ id: draft.sessionId }) });
  const prepared = definition.compositionDraft.prepareWrite({ value: draft });
  await withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await imageGenerationSessionDirectory({ directory, sessionId: prepared.snapshot.value.sessionId });
      if (!session) {
        throw new Error('The composition session no longer exists.');
      }
      const io = imageGenerationIo({ directory: session, path: definition.path });
      const current = await definition.compositionDraft.read({ io });
      assertImageGenerationReplacement({ current, next: prepared.snapshot, expectedRevision });
      await prepared.write({ io });
    },
  });
}

export const TEST_ONLY = {
};
