import { createUnavailableSpeechRecognitionClient } from './client-unavailable';
import type { SpeechRecognitionClient, SpeechRecognitionObservers } from '@/features/speech-cpp-browser/recognition/types';

export function createSpeechRecognitionClient({ observers }: { observers: SpeechRecognitionObservers }): SpeechRecognitionClient {
  return createUnavailableSpeechRecognitionClient({ reason: 'standalone', observers });
}

export const TEST_ONLY = {
};
