import { speechError, type SpeechUnavailableReason, type SpeechState } from '@/features/speech-cpp-browser/types';
import type { SpeechClient, SpeechObservers } from './types';

/** Preserve the client surface when this build or environment cannot run speech. */
export function createUnavailableSpeechClient({ reason, observers }: { reason: SpeechUnavailableReason, observers: SpeechObservers }): SpeechClient {
  let disposed = false;
  function getState(): SpeechState {
    return { phase: disposed ? 'disposed' : 'unloaded', model: undefined, queuedSamples: 0, completion: undefined, failure: undefined, loadProgress: undefined };
  }
  function unavailable(): never {
    throw speechError({ code: 'unavailable', message: `Speech runtime unavailable: ${reason}` });
  }
  return {
    capability: { kind: 'unavailable', reason },
    getState,
    async loadModel() {
      unavailable();
    },
    async start() {
      unavailable();
    },
    push() {
      return unavailable();
    },
    async stop() {},
    async releaseModel() {},
    async dispose() {
      if (!disposed) {
        disposed = true;
        observers.onState({ state: getState() });
      }
    },
  };
}

export const TEST_ONLY = {
};
