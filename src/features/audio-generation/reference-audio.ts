import { MAX_REFERENCE_BYTES, MAX_REFERENCE_SECONDS } from './types';

export const REFERENCE_SAMPLE_RATE = 24000;
export const MAX_REFERENCE_SAMPLES = REFERENCE_SAMPLE_RATE * MAX_REFERENCE_SECONDS;
export type ReferenceAudioErrorCode = 'empty' | 'too-large' | 'too-long' | 'decode' | 'unavailable' | 'library-full' | 'permission' | 'microphone' | 'recording';
export class ReferenceAudioError extends Error {
  constructor({ code }: { code: ReferenceAudioErrorCode }) {
    super(`Reference audio: ${code}`); this.name = 'ReferenceAudioError'; this.code = code;
  }
  readonly code: ReferenceAudioErrorCode;
}
export function checkReferenceFile({ file }: { file: Blob }): void {
  if (!file.size) throw new ReferenceAudioError({ code: 'empty' });
  if (file.size > MAX_REFERENCE_BYTES) throw new ReferenceAudioError({ code: 'too-large' });
}
function checkCancelled({ signal }: { signal: AbortSignal | undefined }): void {
  signal?.throwIfAborted();
}
function wavHeader({ samples }: { samples: number }): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44); const view = new DataView(bytes.buffer);
  const text = ({ offset, value }: { offset: number, value: string }) => bytes.set(new TextEncoder().encode(value), offset);
  text({ offset: 0, value: 'RIFF' }); view.setUint32(4, 36 + samples * 2, true);
  text({ offset: 8, value: 'WAVE' }); text({ offset: 12, value: 'fmt ' }); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, REFERENCE_SAMPLE_RATE, true);
  view.setUint32(28, REFERENCE_SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text({ offset: 36, value: 'data' }); view.setUint32(40, samples * 2, true); return bytes;
}
/** Browser decoding supports recording containers that miniaudio cannot read.
 * OfflineAudioContext resamples to 24 kHz without opening an audio output device.
 * Decode one file at a time. Browser decoding allocates before duration can be
 * checked: the compressed-byte limit is not a hard decoder peak-memory bound.
 */
export async function normalizeReferenceAudio({ source, signal, durationPolicy }: { source: Blob, signal: AbortSignal | undefined, durationPolicy: 'reject' | 'limit-recording' }): Promise<{ wav: Blob, samples: number, trimmed: boolean }> {
  checkReferenceFile({ file: source }); checkCancelled({ signal });
  if (typeof OfflineAudioContext !== 'function') throw new ReferenceAudioError({ code: 'unavailable' });
  const bytes = await source.arrayBuffer(); checkCancelled({ signal });
  let decoded: AudioBuffer;
  try {
    const context = new OfflineAudioContext(1, 1, REFERENCE_SAMPLE_RATE);
    decoded = await context.decodeAudioData(bytes);
  } catch {
    checkCancelled({ signal }); throw new ReferenceAudioError({ code: 'decode' });
  }
  checkCancelled({ signal });
  const length = decoded.length;
  const samples = Math.min(length, MAX_REFERENCE_SAMPLES);
  if (!Number.isSafeInteger(length) || length <= 0) throw new ReferenceAudioError({ code: 'empty' });
  if (length > MAX_REFERENCE_SAMPLES && durationPolicy === 'reject') throw new ReferenceAudioError({ code: 'too-long' });
  if (decoded.sampleRate !== REFERENCE_SAMPLE_RATE || !Number.isInteger(decoded.numberOfChannels) || decoded.numberOfChannels < 1 || decoded.numberOfChannels > 32) throw new ReferenceAudioError({ code: 'decode' });
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
  const pcm = new Uint8Array(samples * 2); const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples; i++) {
    let sample = 0;
    for (const channel of channels) sample += channel[i]! / channels.length;
    if (!Number.isFinite(sample)) throw new ReferenceAudioError({ code: 'decode' });
    view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true);
  }
  checkCancelled({ signal });
  return { wav: new Blob([wavHeader({ samples }), pcm], { type: 'audio/wav' }), samples, trimmed: length > samples };
}
/** Concatenate in the displayed selection order, never mix speakers on top of
 * each other or silently trim. The native helper accepts ONE speaker bitmap.
 * A single native-format file retains the old path/quality and does not require
 * browser decoding. Its actual format/duration are still validated natively.
 */
export async function prepareReferenceAudio({ sources, signal }: { sources: readonly File[], signal: AbortSignal | undefined }): Promise<Blob | undefined> {
  checkCancelled({ signal });
  for (const file of sources) checkReferenceFile({ file });
  if (sources.length === 0) return undefined;
  const single = sources[0]!;
  if (sources.length === 1 && /\.(wav|mp3|flac)$/i.test(single.name)) return single;
  const parts: Blob[] = []; let samples = 0;
  for (const source of sources) {
    const part = await normalizeReferenceAudio({ source, signal, durationPolicy: 'reject' });
    samples += part.samples;
    if (samples > MAX_REFERENCE_SAMPLES) throw new ReferenceAudioError({ code: 'too-long' });
    parts.push(part.wav.slice(44));
  }
  checkCancelled({ signal });
  return new Blob([wavHeader({ samples }), ...parts], { type: 'audio/wav' });
}
export const TEST_ONLY = {
};
