import type { ImageCompositionDraft } from '@/01-models/image-generation';
import { imageCompositionToDto, imageCompositionToDomain } from '@/00-storage/mapper/image-generation-composition';
import { ExperimentalImageGenerationCompositionSchemaDto, type ExperimentalImageGenerationCompositionDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import { imageGenerationRawIdSchema, readImageGenerationText, writeImageGenerationText } from './files';
import { imageGenerationSessionDirectory } from './tables';
import { assertImageGenerationReplacement, withImageGenerationStore, type ImageGenerationStoreAccess } from './context';
import { idToRaw, type ImageGenerationSessionId } from '@/01-models/ids';

function validateComposition({ dto, sessionId }: { dto: ExperimentalImageGenerationCompositionDto, sessionId: string }): void {
  if (dto.sessionId !== sessionId || dto.jobs.length > 128 || dto.slots.length > 128 || new Set(dto.jobs.map(job => job.id)).size !== dto.jobs.length || new Set(dto.slots.map(slot => slot.name)).size !== dto.slots.length || !Number.isSafeInteger(dto.revision) || dto.revision < 0 || !Number.isFinite(dto.updatedAt)) {
    throw new Error('Invalid image generation composition draft.');
  }
  for (const job of dto.jobs) {
    imageGenerationRawIdSchema.parse(job.id);
  }
  for (const slot of dto.slots) {
    if (!slot.name.trim() || slot.name.length > 128 || /[\p{Cc}\p{Cs}]/u.test(slot.name)) {
      throw new Error('Invalid model configuration slot name.');
    }
  }
}

export async function loadImageGenerationComposition({ store, sessionId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId }): Promise<ImageCompositionDraft | undefined> {
  const raw = imageGenerationRawIdSchema.parse(idToRaw({ id: sessionId }));
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await imageGenerationSessionDirectory({ directory, sessionId: raw });
      if (!session) {
        throw new Error('The composition session no longer exists.');
      }
      const text = await readImageGenerationText({ directory: session, name: 'composition-draft.json' });
      if (text === undefined) {
        return undefined;
      }
      const dto = ExperimentalImageGenerationCompositionSchemaDto.parse(JSON.parse(text));
      validateComposition({ dto, sessionId: raw });
      return imageCompositionToDomain({ dto });
    },
  });
}

/** Independent from the single-form draft. Invalid/incomplete prompts can be
 * edited and checkpointed; acceptance performs stricter domain validation. */
export async function saveImageGenerationComposition({ store, draft, expectedRevision }: { store: ImageGenerationStoreAccess, draft: ImageCompositionDraft, expectedRevision: number | undefined }): Promise<void> {
  const next = ExperimentalImageGenerationCompositionSchemaDto.parse(imageCompositionToDto({ draft }));
  imageGenerationRawIdSchema.parse(next.sessionId);
  validateComposition({ dto: next, sessionId: next.sessionId });
  const serialized = JSON.stringify(next);
  // This state contains no binary handles or input images. Shared input-image
  // persistence continues to use the existing draft writer.
  await withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await imageGenerationSessionDirectory({ directory, sessionId: next.sessionId });
      if (!session) {
        throw new Error('The composition session no longer exists.');
      }
      const text = await readImageGenerationText({ directory: session, name: 'composition-draft.json' });
      const current = text === undefined ? undefined : ExperimentalImageGenerationCompositionSchemaDto.parse(JSON.parse(text));
      if (current) {
        validateComposition({ dto: current, sessionId: next.sessionId });
      }
      assertImageGenerationReplacement({ current, next, expectedRevision });
      await writeImageGenerationText({ directory: session, name: 'composition-draft.json', text: serialized });
    },
  });
}

export const TEST_ONLY = {
};
