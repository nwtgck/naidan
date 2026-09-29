/** Validate the native helper's mono PCM16 output without assuming a 44-byte
 * header: additional RIFF chunks are permitted, but inconsistent sizes are not. */
export function validateAudioWav({ wav, sampleRate, samples }: { wav: Uint8Array, sampleRate: number, samples: number }): void {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const text = ({ offset }: { offset: number }): string => new TextDecoder('ascii').decode(wav.subarray(offset, offset + 4));
  if (wav.length < 44 || text({ offset: 0 }) !== 'RIFF' || text({ offset: 8 }) !== 'WAVE' || view.getUint32(4, true) + 8 !== wav.length) throw new Error('Invalid WAV container');
  let format = false; let data = false;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const tag = text({ offset }); const length = view.getUint32(offset + 4, true); const body = offset + 8;
    if (length > wav.length - body) throw new Error('Truncated WAV chunk');
    if (tag === 'fmt ') {
      if (format || length < 16 || view.getUint16(body, true) !== 1 || view.getUint16(body + 2, true) !== 1 || view.getUint32(body + 4, true) !== sampleRate || view.getUint32(body + 8, true) !== sampleRate * 2 || view.getUint16(body + 12, true) !== 2 || view.getUint16(body + 14, true) !== 16) throw new Error('Unexpected WAV format');
      format = true;
    } else if (tag === 'data') {
      if (data || length !== samples * 2) throw new Error('Unexpected WAV sample count');
      data = true;
    }
    offset = body + length + (length % 2);
  }
  if (!format || !data || offset !== wav.length) throw new Error('Incomplete WAV output');
}
export const TEST_ONLY = {
};
