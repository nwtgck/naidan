import type { ImageGenerationRecord } from '@/01-models/image-generation-history';
import type { HistoryBinaryFile, ImageGenerationSnapshot } from './history/snapshot';

export type ImageGenerationCompletion =
  | { type: 'completed' }
  | { type: 'cancelled' }
  | { type: 'failed', message: string };

/** A logical run owns a frozen request and consumes outputs incrementally. The
 * consumer must retain failed saves; retrying persistence must not rerun inference.
 * This contract is not a native batch, a Chat tool protocol, or a stored DTO. */
export type ImageGenerationSubmission = {
  count: number,
  accepted({ snapshot, seeds }: { snapshot: ImageGenerationSnapshot, seeds: string[] }): Promise<void>,
  output({ index, record, files }: { index: number, record: ImageGenerationRecord, files: HistoryBinaryFile[] }): Promise<void>,
  retry?(): Promise<void>,
  finished({ completion }: { completion: ImageGenerationCompletion }): Promise<void>,
};

export const TEST_ONLY = {
};
