import { z } from 'zod';
import { toVolumeId, type VolumeId } from './ids';
import type { Volume } from './types';

/** A page-local managed volume reference, never a persisted format. */
export type ManagedVolumeReference = { volumeId: VolumeId };

export const managedVolumeReferenceSchema = z.object({
  volumeId: z.string().min(1).transform(raw => toVolumeId({ raw })),
});

export type StoredVolumeAccess =
  | { kind: 'native', volume: Volume, handle: FileSystemDirectoryHandle }
  | { kind: 'incomplete', volumeId: VolumeId, handle: FileSystemDirectoryHandle }
  | { kind: 'missing', volumeId: VolumeId };

export type VolumeAccess = StoredVolumeAccess
  | { kind: 'managed', volume: Volume, reference: ManagedVolumeReference };

export type LazyVolumeState = Readonly<{
  volume: Volume,
  phase: 'copying' | 'paused' | 'saved' | 'failed',
  progress: Readonly<{ processed: number, total: number }>,
  error: string | undefined,
}>;

export const TEST_ONLY = {
};
