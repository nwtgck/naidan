import { speechError, speechFrameSamples, speechSampleRate, type SpeechFrame } from '@/features/speech-cpp-browser/types';

/** The native callback's views expire on return and after Wasm heap growth.
 * Copy while inside that callback, before invoking application observers. */
export function copySpeechFrame({ samples, text, sequence }: { samples: Float32Array, text: string, sequence: number }): SpeechFrame {
  if (samples.length !== speechFrameSamples || text.length > 16384) {
    throw speechError({ code: 'runtime_failed', message: 'Invalid speech output frame' });
  }
  const owned = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index++) {
    const value = samples[index]!;
    if (!Number.isFinite(value) || value < -1 || value > 1) {
      throw speechError({ code: 'runtime_failed', message: 'Invalid speech output sample' });
    }
    owned[index] = value;
  }
  return { samples: owned, sampleRate: speechSampleRate, text, sequence };
}

export const TEST_ONLY = {
};
