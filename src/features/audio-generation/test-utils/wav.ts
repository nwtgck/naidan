import type { AudioGenerationResult } from '@/features/audio-generation/types';

export function audioResult(): AudioGenerationResult {
  const samples = 4; const sampleRate = 24000;
  const wav = new Uint8Array(44 + samples * 2); const view = new DataView(wav.buffer);
  wav.set(new TextEncoder().encode('RIFF'), 0); view.setUint32(4, wav.length - 8, true);
  wav.set(new TextEncoder().encode('WAVEfmt '), 8); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  wav.set(new TextEncoder().encode('data'), 36); view.setUint32(40, samples * 2, true);
  view.setInt16(44, -1000, true); view.setInt16(46, 1000, true);
  return { wav, samples, sampleRate, frames: 2, finishReason: 'stop', pipeline: 'qwen3-tts' };
}
export const TEST_ONLY = {
};
