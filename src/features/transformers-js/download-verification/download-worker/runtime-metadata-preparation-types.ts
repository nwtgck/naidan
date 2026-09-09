import { z } from 'zod';

// Execution stages belong to the shared preparation path, not the observer.
// They carry no metadata content and are never persisted in the model cache.
export const runtimeMetadataPreparationStageSchema = z.enum([
  'configuration', 'resource-selection', 'tokenizer', 'processor', 'storage-finalization', 'complete',
]);
export type RuntimeMetadataPreparationStage = z.infer<typeof runtimeMetadataPreparationStageSchema>;

export const TEST_ONLY = {
};
