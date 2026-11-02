/** Output playback and inference have separate lifetimes. Backpressure limits
 * scheduled audio, while stop() invalidates callbacks before native cancellation. */
export function createLivePlayback({ onPlaying }: { onPlaying: ({ playing }: { playing: boolean }) => void }) {
  let context: AudioContext | undefined;
  let gain: GainNode | undefined;
  const sources = new Set<AudioBufferSourceNode>();
  let nextTime = 0;
  let epoch = 0;
  let disposed = false;
  let audible: 'on' | 'off' = 'on';
  let enabled = false;
  return {
    async activate(): Promise<void> {
      if (disposed) {
        throw new Error('Live playback is closed');
      }
      context ??= new AudioContext();
      if (!gain) {
        gain = context.createGain();
        gain.connect(context.destination);
      }
      gain.gain.value = outputGain({ value: audible });
      await context.resume();
    },
    begin(): void {
      enabled = true;
      epoch++;
      nextTime = context?.currentTime ?? 0;
    },
    async append({ pcm, sampleRate }: { pcm: Float32Array, sampleRate: number }): Promise<void> {
      const current = context;
      const output = gain;
      const accepted = epoch;
      if (!enabled || disposed) {
        return;
      }
      if (!current || !output || current.state !== 'running') {
        throw new Error('Live playback requires an active audio device');
      }
      while (nextTime - current.currentTime > 1.5) {
        await new Promise<void>(resolve => setTimeout(resolve, 20));
        if (disposed || !enabled || accepted !== epoch) {
          return;
        }
        if (current.state !== 'running') {
          throw new Error('Live playback was suspended');
        }
      }
      if (disposed || !enabled || accepted !== epoch) {
        return;
      }
      const buffer = current.createBuffer(1, pcm.length, sampleRate);
      buffer.copyToChannel(Float32Array.from(pcm), 0);
      const source = current.createBufferSource();
      source.buffer = buffer;
      source.connect(output);
      sources.add(source);
      source.onended = () => {
        source.disconnect();
        sources.delete(source);
        if (!sources.size) {
          onPlaying({ playing: false });
        }
      };
      const start = Math.max(current.currentTime + 0.015, nextTime);
      source.start(start);
      onPlaying({ playing: true });
      nextTime = start + buffer.duration;
    },
    mute({ value }: { value: 'on' | 'off' }): void {
      audible = value;
      if (gain) {
        gain.gain.value = outputGain({ value });
      }
    },
    stop(): void {
      enabled = false;
      epoch++;
      for (const source of sources) {
        source.onended = null;
        try {
          source.stop();
        } catch { /* Already ended. */ }
        source.disconnect();
      }
      sources.clear();
      onPlaying({ playing: false });
      nextTime = context?.currentTime ?? 0;
    },
    async close(): Promise<void> {
      disposed = true;
      enabled = false;
      epoch++;
      for (const source of sources) {
        source.onended = null;
        try {
          source.stop();
        } catch { /* Already ended. */ }
        source.disconnect();
      }
      sources.clear();
      onPlaying({ playing: false });
      gain?.disconnect();
      if (context && context.state !== 'closed') {
        await context.close();
      }
      context = undefined;
      gain = undefined;
    },
  };
}

function outputGain({ value }: { value: 'on' | 'off' }): number {
  switch (value) {
  case 'on': return 1;
  case 'off': return 0;
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
