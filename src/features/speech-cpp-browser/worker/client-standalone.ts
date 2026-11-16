import { createUnavailableSpeechClient } from './client-unavailable';
import type { SpeechClient, SpeechObservers } from './types';

export function createSpeechClient({ observers }: { observers: SpeechObservers }): SpeechClient {
  return createUnavailableSpeechClient({ reason: 'standalone', observers });
}

export const TEST_ONLY = {
};
