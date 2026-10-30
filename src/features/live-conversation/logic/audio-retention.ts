export type LiveAudioClip = {
  url: string,
  sampleRate: number,
  seconds: number,
  status: 'complete' | 'partial',
};
type Slot = { sampleRate: number, chunks: Float32Array[], samples: number, url: string | undefined, bytes: number };

/** Opt-in, page-owned audio only: no storage service, IndexedDB or sessionStorage.
 * Each slot switches from PCM chunks to a WAV Blob URL on completion. Turning
 * retention off releases both unfinished chunks and completed URLs immediately. */
export function createLiveAudioRetention({ maximumBytes }: { maximumBytes: number }) {
  const slots = new Map<string, Slot>();
  let enabled = false;
  let bytes = 0;
  const unavailable = new Set<string>();
  function drop({ key }: { key: string }): void {
    const slot = slots.get(key);
    if (slot) {
      bytes -= slot.bytes;
      if (slot.url) {
        URL.revokeObjectURL(slot.url);
      }
      slots.delete(key);
    }
  }
  function clear(): void {
    for (const key of slots.keys()) {
      drop({ key });
    }
    unavailable.clear();
  }
  return {
    setEnabled({ value }: { value: 'on' | 'off' }): void {
      enabled = value === 'on';
      if (!enabled) {
        clear();
      }
    },
    isEnabled: () => enabled,
    append({ key, sampleRate, pcm }: { key: string, sampleRate: number, pcm: Float32Array }): 'kept' | 'skipped' | 'limit' {
      if (!enabled || !pcm.length) {
        return 'skipped';
      }
      if (unavailable.has(key)) {
        return 'limit';
      }
      let slot = slots.get(key);
      if (slot?.url || (slot && slot.sampleRate !== sampleRate)) {
        throw new Error('Invalid retained audio sequence');
      }
      // Account for a WAV header too; no truncated recording is presented as a
      // complete one when the budget is exhausted.
      const addition = pcm.byteLength + (slot ? 0 : 44);
      if (bytes + addition > maximumBytes) {
        drop({ key });
        unavailable.add(key);
        return 'limit';
      }
      if (!slot) {
        slot = { sampleRate, chunks: [], samples: 0, url: undefined, bytes: 44 };
        slots.set(key, slot);
        bytes += 44;
      }
      slot.chunks.push(Float32Array.from(pcm));
      slot.samples += pcm.length;
      slot.bytes += pcm.byteLength;
      bytes += pcm.byteLength;
      return 'kept';
    },
    finish({ key, status }: { key: string, status: LiveAudioClip['status'] }): LiveAudioClip | undefined {
      const slot = slots.get(key);
      if (!slot || !slot.samples || !enabled) {
        return undefined;
      }
      if (!slot.url) {
        // IEEE float WAV preserves the exact PCM sent to/received from the model.
        const header = new Uint8Array(44);
        const view = new DataView(header.buffer);
        for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) {
          header.set(new TextEncoder().encode(text), offset);
        }
        view.setUint32(4, slot.samples * 4 + 36, true);
        view.setUint32(16, 16, true);
        view.setUint16(20, 3, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, slot.sampleRate, true);
        view.setUint32(28, slot.sampleRate * 4, true);
        view.setUint16(32, 4, true);
        view.setUint16(34, 32, true);
        view.setUint32(40, slot.samples * 4, true);
        const parts: BlobPart[] = [header];
        for (const chunk of slot.chunks) {
          const data = new Uint8Array(chunk.length * 4);
          const samples = new DataView(data.buffer);
          for (let i = 0; i < chunk.length; i++) {
            samples.setFloat32(i * 4, chunk[i]!, true);
          }
          parts.push(data);
        }
        slot.url = URL.createObjectURL(new Blob(parts, { type: 'audio/wav' }));
        slot.chunks = [];
      }
      return { url: slot.url, sampleRate: slot.sampleRate, seconds: slot.samples / slot.sampleRate, status };
    },
    drop,
    clear,
  };
}

export const TEST_ONLY = {
};
