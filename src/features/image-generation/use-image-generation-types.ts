import type { ImageInferenceLocationView } from './composables/use-image-inference-location';
import type { ImageGenerationDraftAccess } from './generation-draft';
import type { ImageGenerationSubmission } from './generation-submission';
import type { ImageLibraryView } from '@/features/stable-diffusion-cpp-browser/library-view';
import type { Ref, ComputedRef } from 'vue';
import type { createImageForm } from './form';
import type { ModelSlot } from '@/features/stable-diffusion-cpp-browser/types';
import type { ImageGenerationRecommendation } from '@/features/stable-diffusion-cpp-browser/recommendations';
import type { ImageGenerationHistoryView } from './history-view';
import type { ImageGenerationRecord } from '@/01-models/image-generation-history';
import type { BinaryObjectId, ImageGenerationId } from '@/01-models/ids';
import type { ImageEngineSnapshot } from '@/features/stable-diffusion-cpp-browser/engine-state';

export type ImageDownloadFormat = 'png' | 'webp' | 'jpeg';
export type ImageDownloadPreferences = { format: ImageDownloadFormat, metadata: 'include' | 'omit' };
export type ImageDownloadResult =
  | { status: 'downloaded' }
  | { status: 'failed', message: string }
  | { status: 'cancelled' };

export type ImageEngineStateView = {
  opened: Ref<boolean>;
  status: Ref<'idle' | 'refreshing' | 'unavailable' | 'failed'>;
  snapshot: Ref<ImageEngineSnapshot | undefined>;
  reason: Ref<'not-loaded' | 'busy' | 'unsupported' | 'released' | undefined>;
  error: Ref<string>;
  canRefresh: ComputedRef<boolean>;
  setOpened({ opened }: { opened: boolean }): void;
  refresh(): Promise<void>;
};

export type ImageGenerationView = ReturnType<typeof createImageForm> & Partial<ImageGenerationDraftAccess> & {
  inferenceLocation?: ImageInferenceLocationView;
  engineState: ImageEngineStateView;
  seedMode: Ref<'random' | 'fixed'>;
  randomizeSeed(): void;
  library: ImageLibraryView;
  history: ImageGenerationHistoryView;
  historySaving: {
    enabled: Ref<boolean>;
    supported: ComputedRef<boolean>;
    status: Ref<'idle' | 'saving' | 'saved' | 'failed'>;
    error: Ref<string>;
    pendingCount: Ref<number>;
    retry(): Promise<void>;
  };
  historyActions: { busy: Ref<boolean>; error: Ref<string>; missingFiles: Ref<string[]>; missingInactiveFiles: Ref<string[]> };
  reuseHistory({ record }: { record: ImageGenerationRecord }): Promise<void>;
  useHistoryImage({ binaryObjectId, role }: { binaryObjectId: BinaryObjectId, role: 'initial' | 'reference' }): Promise<void>;
  savedHistoryId({ resultId }: { resultId: number }): ImageGenerationId | undefined;
  downloadHistory({ binaryObjectId, record, format, includeMetadata }: { binaryObjectId: BinaryObjectId, record: ImageGenerationRecord, format: ImageDownloadFormat, includeMetadata: boolean }): Promise<ImageDownloadResult>;
  downloadResult({ resultId, format, includeMetadata }: { resultId: number, format: ImageDownloadFormat, includeMetadata: boolean }): Promise<ImageDownloadResult>;
  downloadPreview({ previewId, format, includeMetadata }: { previewId: number, format: ImageDownloadFormat, includeMetadata: boolean }): Promise<ImageDownloadResult>;
  clearHistoryMissingFiles(): void;
  acquireBenchmark(): boolean;
  releaseBenchmark(): void;
  busy: ComputedRef<boolean>;
  supported: ComputedRef<boolean>;
  formDisabled: ComputedRef<boolean>;
  draftDisabled: ComputedRef<boolean>;
  unavailable: ComputedRef<string | undefined>;
  recommendation: ComputedRef<ImageGenerationRecommendation | undefined>;
  manualInspectionState: Ref<'idle' | 'scanning' | 'failed'>;
  inspectManualFiles(): Promise<void>;
  applyRecommendedSettings(): void;
  chooseFile({ slot, event }: { slot: ModelSlot, event: Event }): void;
  resetFiles(): void;
  removeResult({ resultId }: { resultId: number }): void;
  generate({ submission }: { submission: ImageGenerationSubmission | undefined }): Promise<void>;
  cancel(): void;
  forceCancel(): void;
  releaseModel(): void;
  setRetainModel?({ retain }: { retain: boolean }): void;
  clearResults(): void;
  removePreview({ previewId }: { previewId: number }): void;
  clearPreviews(): void;
  copyDiagnostics(): Promise<void>;
  saveDiagnostics(): void;
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
