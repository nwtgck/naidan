import { generationRunFixture } from '@/00-storage/service/image-generation/index.test-support';
import { toImageGenerationSessionId } from '@/01-models/ids';
import type { ImageGenerationDraft } from '@/features/image-generation/generation-draft';

export function compositionDraftFixture(): ImageGenerationDraft {
  const request = generationRunFixture({ id: 'run-aa', sessionId: toImageGenerationSessionId({ raw: 'session-aa' }), count: 1, seed: '42' }).request;
  request.imageInputs = { initImage: undefined, referenceImages: [], strength: 0.75 };
  return {
    request,
    inferenceLocation: { kind: 'local' },
    layout: 'components',
    modelSelection: undefined,
    remoteModelEditor: undefined,
    seedMode: 'fixed',
    stepsPreference: 9,
    guidancePreference: 1,
    vaeTileSizePreference: 32,
    loraStates: [{ enabled: false, strength: 0 }],
    debug: 'off',
    retainModel: true,
    keepPreviews: false,
    maxPreviews: 4,
    maxResults: 8,
    files: [],
    modelFiles: [],
  };
}

export const TEST_ONLY = {
};
