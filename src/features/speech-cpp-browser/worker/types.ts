import type { SpeechCapability, SpeechFrame, SpeechPushResult, SpeechStartOptions, SpeechState } from '@/features/speech-cpp-browser/types';

/** Input recording and output playback can both remain active during running.
 * Mute/playback controls belong to the caller, independently of session phase. */
export interface SpeechClient {
  capability: SpeechCapability;
  getState(): SpeechState;
  loadModel({ file }: { file: File }): Promise<void>;
  start({ options }: { options: SpeechStartOptions }): Promise<void>;
  push({ samples, sampleRate }: { samples: Float32Array, sampleRate: number }): SpeechPushResult;
  stop({ mode }: { mode: 'finish' | 'cancel' }): Promise<void>;
  releaseModel(): Promise<void>;
  dispose(): Promise<void>;
}
export type SpeechObservers = {
  onFrame: ({ frame }: { frame: SpeechFrame }) => void;
  onState: ({ state }: { state: SpeechState }) => void;
};

export const TEST_ONLY = {
};
