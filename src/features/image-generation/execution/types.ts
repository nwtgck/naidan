import type { ImageGenerationRecord } from '@/01-models/image-generation-history';
import type { ImageGenerationSnapshot } from '@/features/image-generation/history/snapshot';

/** Image execution carries pixels and progress, never a native artifact, model
 * File handle, persistence service or Vue view. Those belong to the adapter. */
export type ImageExecutionProgress = {
  phase: 'runtime' | 'model' | 'sampling' | 'decoding' | 'encoding',
  step: number,
  steps: number,
};
export type ImageExecutionPreview = {
  type: 'naidan-image-preview-v1',
  runId: number,
  revision: number,
  step: number,
  steps: number,
  width: number,
  height: number,
  mode: 'projection' | 'vae',
  png: Blob,
};
export type ImageExecutionOutput = {
  png: Blob,
  width: number,
  height: number,
  modelVersion: string,
  uniformOutput?: boolean,
};
/** Pixels can survive an interrupted delivery without execution metadata.
 * This is not a normal output and must never count toward a successful run. */
export type RecoverableImageExecutionOutput = {
  png: Blob,
  width: number,
  height: number,
  reported: { seed: string, modelVersion: string, uniformOutput: boolean } | undefined,
};
export type ImageExecutionOutcome =
  | { status: 'completed', output: ImageExecutionOutput }
  | { status: 'cancelled' }
  | { status: 'failed', message: string }
  | { status: 'interrupted', recoverable: RecoverableImageExecutionOutput | undefined, message: string };

export type ImageExecutionJob = {
  result: Promise<ImageExecutionOutcome>,
  cancel(): void,
  // Undefined means that the backend fixes preview settings at submission.
  updatePreview: (({ settings }: { settings: ImageGenerationRecord['request']['preview'] }) => void) | undefined,
};

/** A plan is an in-memory capability owned by its creating adapter. It must not
 * be serialized or retargeted while a run is executing. Seed is the only
 * per-image change allowed within an accepted multi-image submission. */
export type PreparedImageExecution<Snapshot = ImageGenerationSnapshot> = {
  readonly snapshot: Snapshot,
  reserve?({ signal }: { signal: AbortSignal }): { release(): void },
  start({ seed, signal, onProgress, onPreview }: {
    seed: string,
    signal: AbortSignal,
    onProgress: ({ event }: { event: ImageExecutionProgress }) => void,
    onPreview: ({ frame }: { frame: ImageExecutionPreview }) => void,
  }): ImageExecutionJob,
};
export const TEST_ONLY = {
};
