import { createLiveAudioMeter, type LiveAudioStatistics } from './audio-file';

export type SpeechInputLevelSettings = { kind: 'gain', gain: number } | { kind: 'peak', targetPeak: number };
export type SpeechInputLevel = { requested: SpeechInputLevelSettings, appliedGain: number | undefined, before: LiveAudioStatistics | undefined, after: LiveAudioStatistics | undefined, clippedSamples: number | undefined };

export function snapshotInputLevel({ requested }: { requested: SpeechInputLevelSettings }): SpeechInputLevelSettings {
  switch (requested.kind) {
  case 'gain': {
    const { kind, gain, ...unhandled } = requested;
    unhandled satisfies Record<PropertyKey, never>;
    return { kind, gain };
  }
  case 'peak': {
    const { kind, targetPeak, ...unhandled } = requested;
    unhandled satisfies Record<PropertyKey, never>;
    return { kind, targetPeak };
  }
  default: {
    const exhaustive: never = requested;
    throw new Error(String(exhaustive));
  }
  }
}

export function validateInputLevel({ requested }: { requested: SpeechInputLevelSettings }): void {
  switch (requested.kind) {
  case 'gain':
    validateConstantInputGain({ gain: requested.gain });
    return;
  case 'peak':
    if (!Number.isFinite(requested.targetPeak) || requested.targetPeak <= 0 || requested.targetPeak > 1) {
      throw new Error('Input target peak must be finite, positive and at most one');
    }
    return;
  default: {
    const exhaustive: never = requested;
    throw new Error(String(exhaustive));
  }
  }
}

export function validateConstantInputGain({ gain }: { gain: number }): void {
  if (!Number.isFinite(gain) || gain <= 0) {
    throw new Error('Input gain must be a finite positive number');
  }
}

/** PCM is already validated at the capture/decode boundary. Mutate its owned
 * buffer once; exact endpoints are distinct from actual clipped products. */
export function applyConstantInputGain({ pcm, gain }: { pcm: Float32Array, gain: number }): number {
  validateConstantInputGain({ gain });
  if (gain === 1) {
    return 0;
  }
  let clippedSamples = 0;
  for (let index = 0; index < pcm.length; index++) {
    const amplified = pcm[index]! * gain;
    if (amplified < -1 || amplified > 1) {
      clippedSamples++;
    }
    pcm[index] = Math.max(-1, Math.min(1, amplified));
  }
  return clippedSamples;
}

/** Apply one constant gain to caller-owned decoded PCM. Unity stays bit-exact;
 * other gains mutate this buffer once without copying the original source File. */
export function applyInputLevel({ pcm, sampleRate, requested }: { pcm: Float32Array, sampleRate: number, requested: SpeechInputLevelSettings }): SpeechInputLevel {
  validateInputLevel({ requested });
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0 || pcm.length === 0) {
    throw new Error('Input audio needs non-empty PCM and a positive integer sample rate');
  }
  const meter = createLiveAudioMeter({ sampleRate });
  meter.append({ pcm });
  const before = meter.read();
  if (before.peak > 1) {
    throw new Error('Input audio samples must be within [-1, 1]');
  }
  const gain = (() => {
    switch (requested.kind) {
    case 'gain': return requested.gain;
    case 'peak': return before.peak === 0 ? 1 : requested.targetPeak / before.peak;
    default: {
      const exhaustive: never = requested;
      throw new Error(String(exhaustive));
    }
    }
  })();
  if (!Number.isFinite(gain) || gain <= 0) {
    throw new Error('Calculated input gain must be a finite positive number');
  }
  const accepted = snapshotInputLevel({ requested });
  if (gain === 1) {
    return { requested: accepted, appliedGain: gain, before, after: before, clippedSamples: 0 };
  }
  const clippedSamples = applyConstantInputGain({ pcm, gain });
  const adjusted = createLiveAudioMeter({ sampleRate });
  adjusted.append({ pcm });
  return { requested: accepted, appliedGain: gain, before, after: adjusted.read(), clippedSamples };
}

export const TEST_ONLY = {
};
