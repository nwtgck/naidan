import { createLiveAudioMeter, type LiveAudioStatistics } from './audio-file';
import { applyConstantInputGain } from './audio-level';

export type LiveSpeechInputLevelWindow = {
  gain: number,
  before: LiveAudioStatistics,
  after: LiveAudioStatistics,
  clippedSamples: number,
};

/** Sample-count windows retain only scalar aggregates, with no PCM history or
 * wall clock. Observation off performs only the explicitly requested gain. */
export function createLiveSpeechInputLevel({ sampleRate }: { sampleRate: number }) {
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 2) {
    throw new Error('Input level sample rate must be a positive integer of at least two');
  }
  const windowSamples = Math.round(sampleRate / 2);
  let samples = 0, clippedSamples = 0;
  let before: ReturnType<typeof createLiveAudioMeter> | undefined;
  let after: ReturnType<typeof createLiveAudioMeter> | undefined;
  function reset(): void {
    samples = 0;
    clippedSamples = 0;
    before = undefined;
    after = undefined;
  }
  return {
    reset,
    process({ pcm, gain, observe }: { pcm: Float32Array, gain: number, observe: boolean }): LiveSpeechInputLevelWindow | undefined {
      if (!observe) {
        applyConstantInputGain({ pcm, gain });
        return undefined;
      }
      let completed: LiveSpeechInputLevelWindow | undefined;
      for (let offset = 0; offset < pcm.length;) {
        before ??= createLiveAudioMeter({ sampleRate });
        after ??= createLiveAudioMeter({ sampleRate });
        const size = Math.min(windowSamples - samples, pcm.length - offset);
        const segment = pcm.subarray(offset, offset + size);
        before.append({ pcm: segment });
        clippedSamples += applyConstantInputGain({ pcm: segment, gain });
        after.append({ pcm: segment });
        samples += size;
        offset += size;
        if (samples === windowSamples) {
          completed = { gain, before: before.read(), after: after.read(), clippedSamples };
          reset();
        }
      }
      return completed;
    },
  };
}

export const TEST_ONLY = {
};
