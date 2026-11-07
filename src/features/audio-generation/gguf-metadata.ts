import { readGgufMetadata, GGUF_METADATA_SCAN_BYTES, type GgufMetadataFile, type GgufMetadataValue } from '@/utils/gguf-metadata';

export type { GgufMetadataFile, GgufMetadataValue } from '@/utils/gguf-metadata';
export const AUDIO_METADATA_SCAN_BYTES = GGUF_METADATA_SCAN_BYTES;

/** Retain the audio detector's original per-value allocation bound. */
export function readAudioGgufMetadata({ file, keys, signal }: { file: GgufMetadataFile, keys: readonly string[], signal: AbortSignal | undefined }): Promise<ReadonlyMap<string, GgufMetadataValue>> {
  return readGgufMetadata({ file, keys, signal, maxStringBytes: 4096 });
}

export const TEST_ONLY = {
};
