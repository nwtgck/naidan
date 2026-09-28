import type { Ref } from 'vue';
import type { BinaryObjectId, ImageGenerationId } from '@/01-models/ids';
import type { ImageGenerationRecord, ImageGenerationSummary } from '@/01-models/image-generation-history';

/** Passive UI contract; storage and Worker ownership remain in the hosted controller. */
export type ImageGenerationHistoryView = {
  available: Ref<boolean>;
  items: Ref<ImageGenerationSummary[]>;
  total: Ref<number>;
  currentPage: Ref<number>;
  pageCount: Ref<number>;
  loading: Ref<boolean>;
  error: Ref<string>;
  warnings: Ref<{ path: string, message: string }[]>;
  warningCount: Ref<number>;
  selected: Ref<ImageGenerationRecord | undefined>;
  detailLoading: Ref<boolean>;
  detailError: Ref<string>;
  imageInvalidation: Ref<{ binaryObjectId: BinaryObjectId, revision: number } | undefined>;
  setQuery({ text }: { text: string }): void;
  reload(): Promise<void>;
  goToPage({ page }: { page: number }): Promise<void>;
  select({ id }: { id: ImageGenerationId }): Promise<void>;
  remove({ id }: { id: ImageGenerationId }): Promise<void>;
  removeImage({ id, binaryObjectId }: { id: ImageGenerationId, binaryObjectId: BinaryObjectId }): Promise<void>;
  getImage({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<Blob | undefined>;
  clearSelection(): void;
  dispose(): void;
};
export const TEST_ONLY = {
};
