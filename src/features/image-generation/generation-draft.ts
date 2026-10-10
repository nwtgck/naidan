import type { Ref } from 'vue';
import type { ImageGenerationSessionDraft } from '@/01-models/image-generation';
import type { ImageGenerationModelFile } from '@/01-models/image-generation-history';
import type { BinaryObjectId } from '@/01-models/ids';
import type { HistoryBinaryFile } from './history/snapshot';

/** Files stay in memory; only settings and local locators cross persistence. */
export type ImageGenerationDraft = Omit<ImageGenerationSessionDraft, 'sessionId' | 'revision' | 'updatedAt' | 'count'> & {
  files: HistoryBinaryFile[],
  modelFiles: { location: ImageGenerationModelFile, file: File }[],
};
export type ImageGenerationDraftAccess = {
  draftRestoreDisabled: Readonly<Ref<boolean>>,
  captureDraft(): ImageGenerationDraft | undefined,
  restoreDraft({ draft }: { draft: ImageGenerationDraft }): Promise<void>,
  resetDraft(): void,
};

export function findDraftModelFile({ entries, location }: { entries: ImageGenerationDraft['modelFiles'], location: ImageGenerationModelFile }): File | undefined {
  return entries.find(entry => JSON.stringify(entry.location) === JSON.stringify(location))?.file;
}

export function findDraftImage({ files, binaryObjectId }: { files: HistoryBinaryFile[], binaryObjectId: BinaryObjectId }): Blob | undefined {
  return files.find(file => file.binaryObjectId === binaryObjectId)?.blob;
}

export const TEST_ONLY = {
};
