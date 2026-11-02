/** Limits apply to the source and decoded samples. As in reference-audio,
 * browser decoders allocate before reporting duration; source size is not a
 * guarantee of peak decoder memory. No audio leaves this browser. */
export const liveAudioFileLimit = 16 * 1024 * 1024;
export const liveAudioSecondsLimit = 180;

export type LiveAudioStatistics = {
  sampleRate: number,
  samples: number,
  seconds: number,
  peak: number,
  rms: number,
  clippedSamples: number,
};

export function createLiveAudioMeter({ sampleRate }: { sampleRate: number }) {
  let samples = 0;
  let squares = 0;
  let peak = 0;
  let clippedSamples = 0;
  return {
    append({ pcm }: { pcm: Float32Array }): void {
      for (const sample of pcm) {
        if (!Number.isFinite(sample)) {
          throw new Error('Invalid live audio sample');
        }
        samples++;
        squares += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
        if (Math.abs(sample) >= 0.9999) {
          clippedSamples++;
        }
      }
    },
    read(): LiveAudioStatistics {
      return { sampleRate, samples, seconds: samples / sampleRate, peak, rms: samples ? Math.sqrt(squares / samples) : 0, clippedSamples };
    },
  };
}

/** Decode/resample on the browser's offline audio context, not an output device.
 * Do not normalize loudness or trim silence: this path is also a diagnostic
 * comparison with microphone PCM. The caller sends exactly these samples. */
export async function decodeLiveAudioFile({ file, sampleRate, signal }: {
  file: Blob, sampleRate: number, signal: AbortSignal,
}): Promise<Float32Array> {
  signal.throwIfAborted();
  if (file.size === 0 || file.size > liveAudioFileLimit) {
    throw new Error('Choose an audio file between 1 byte and 16 MiB');
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000 || typeof OfflineAudioContext !== 'function') {
    throw new Error('Audio file decoding is unavailable');
  }
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  const context = new OfflineAudioContext(1, 1, sampleRate);
  const decoded = await context.decodeAudioData(bytes);
  signal.throwIfAborted();
  if (!Number.isSafeInteger(decoded.length) || decoded.length <= 0 || decoded.length > sampleRate * liveAudioSecondsLimit || decoded.sampleRate !== sampleRate || !Number.isInteger(decoded.numberOfChannels) || decoded.numberOfChannels < 1 || decoded.numberOfChannels > 32) {
    throw new Error('Audio must be non-empty and at most 180 seconds long');
  }
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
  const pcm = new Float32Array(decoded.length);
  for (let i = 0; i < pcm.length; i++) {
    let sample = 0;
    for (const channel of channels) {
      sample += channel[i]! / channels.length;
    }
    if (!Number.isFinite(sample)) {
      throw new Error('Invalid audio file samples');
    }
    pcm[i] = Math.max(-1, Math.min(1, sample));
  }
  signal.throwIfAborted();
  return pcm;
}

export const TEST_ONLY = {
};
