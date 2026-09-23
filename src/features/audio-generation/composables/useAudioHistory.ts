import { computed, onScopeDispose, shallowRef } from 'vue';
import type { AudioGenerationInput, AudioGenerationResult } from '@/features/audio-generation/types';

export type AudioHistorySettings = Omit<AudioGenerationInput, 'reference'> & { modelName: string };
export type AudioHistoryEntry = {
  id: number,
  createdAt: number,
  url: string,
  bytes: number,
  result: Omit<AudioGenerationResult, 'wav'>,
  settings: AudioHistorySettings,
};
/** Capture before awaiting generation. In particular, never retain a reference
 * Blob or read live form/service settings when a delayed result arrives.
 * Options and context are requested values, not the resolved native allocation.
 */
export function captureAudioSettings({ input, modelName }: { input: AudioGenerationInput, modelName: string }): AudioHistorySettings {
  const { reference: _reference, options, ...parameters } = input;
  return { ...parameters, options: { ...options }, modelName };
}
export function useAudioHistory() {
  const entries = shallowRef<readonly AudioHistoryEntry[]>([]);
  const totalBytes = computed(() => entries.value.reduce((sum, entry) => sum + entry.bytes, 0));
  let sequence = 0;
  function append({ result, settings }: { result: AudioGenerationResult, settings: AudioHistorySettings }): void {
    const { wav, ...metadata } = result;
    // The URL owns the Blob. Do not also retain a full WAV Uint8Array per entry.
    const url = URL.createObjectURL(new Blob([new Uint8Array(wav)], { type: 'audio/wav' }));
    entries.value = [{ id: ++sequence, createdAt: Date.now(), url, bytes: wav.byteLength, result: metadata, settings }, ...entries.value];
  }
  function remove({ id }: { id: number }): void {
    const entry = entries.value.find(entry => entry.id === id);
    if (!entry) return;
    entries.value = entries.value.filter(entry => entry.id !== id);
    URL.revokeObjectURL(entry.url);
  }
  function clear(): void {
    const previous = entries.value; entries.value = [];
    for (const entry of previous) URL.revokeObjectURL(entry.url);
  }
  onScopeDispose(clear);
  return { entries, totalBytes, append, remove, clear, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}
export const TEST_ONLY = {
};
