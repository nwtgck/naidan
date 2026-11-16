import { speechError, type SpeechUnavailableReason } from '@/features/speech-cpp-browser/types';
import { initialSpeechRecognitionState, type SpeechRecognitionClient, type SpeechRecognitionObservers } from '@/features/speech-cpp-browser/recognition/types';

export function createUnavailableSpeechRecognitionClient({ reason, observers }: { reason: SpeechUnavailableReason, observers: SpeechRecognitionObservers }): SpeechRecognitionClient {
  let disposed = false;
  function getState() {
    return { ...initialSpeechRecognitionState(), phase: disposed ? 'disposed' as const : 'unloaded' as const };
  }
  function unavailable(): never {
    throw speechError({ code: 'unavailable', message: `Speech recognition unavailable: ${reason}` });
  }
  return {
    capability: { kind: 'unavailable', reason },
    getState,
    async loadModel() {
      unavailable();
    },
    async transcribe() {
      return unavailable();
    },
    async cancel() {},
    async releaseModel() {},
    async dispose() {
      disposed = true;
      observers.onState({ state: getState() });
    },
  };
}

export const TEST_ONLY = {
};
