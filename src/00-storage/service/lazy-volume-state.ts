import type { VolumeId } from '@/01-models/ids';
import type { LazyVolumeState } from '@/01-models/volume-access';

// Observation stays independent of the filesystem implementation. Rendering a
// composer must not import the managed filesystem or initialize its storage.
const states = new Map<VolumeId, LazyVolumeState>();
const listeners = new Set<({ volumeId }: { volumeId: VolumeId }) => void>();

export function readLazyVolumeState({ volumeId }: { volumeId: VolumeId }): LazyVolumeState | undefined {
  return states.get(volumeId);
}

export function listLazyVolumeStates(): readonly LazyVolumeState[] {
  return [...states.values()];
}

export function subscribeLazyVolumeState({ listener }: { listener({ volumeId }: { volumeId: VolumeId }): void }): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Storage-owned publication; listeners cannot undo completed filesystem I/O. */
export function publishLazyVolumeState({ state }: { state: LazyVolumeState }): void {
  states.set(state.volume.id, state);
  for (const listener of listeners) {
    try {
      listener({ volumeId: state.volume.id });
    } catch { /* State observers do not own the volume operation. */ }
  }
}

export function removeLazyVolumeState({ volumeId }: { volumeId: VolumeId }): void {
  states.delete(volumeId);
  for (const listener of listeners) {
    try {
      listener({ volumeId });
    } catch { /* State observers do not own the volume operation. */ }
  }
}

export const TEST_ONLY = {
};
