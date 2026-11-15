import { readGgufMetadata, type GgufMetadataFile } from '@/utils/gguf-metadata';
import { speechError, type SpeechModelInfo } from '@/features/speech-cpp-browser/types';

/** Header-only selection. Tensor layout and model options remain the native
 * speech runtime's authority when an actual SDK adapter opens the file. */
export async function inspectSpeechCandidate({ file, name, signal }: { file: GgufMetadataFile, name: string, signal: AbortSignal | undefined }): Promise<{ kind: 'speech', info: SpeechModelInfo } | { kind: 'other' }> {
  // Most inventory entries belong to another runtime; finish their detection
  // after the architecture key instead of scanning tokenizer metadata.
  const architecture = await readGgufMetadata({ file, keys: ['general.architecture'], signal, maxStringBytes: 4096 });
  if (architecture.get('general.architecture') !== 'haru') {
    return { kind: 'other' };
  }
  const values = await readGgufMetadata({ file, keys: ['general.architecture', 'speech.task', 'speech.sample_rate', 'haru.frame_samples', 'speech.requires', 'speech.layout', 'split.count'], signal, maxStringBytes: 4096 });
  const requiredVersion = values.get('speech.requires');
  if (values.get('general.architecture') !== 'haru' || values.get('speech.task') !== 'dialogue') {
    return { kind: 'other' };
  }
  if (values.get('general.architecture') !== 'haru' || values.get('speech.task') !== 'dialogue' || values.get('speech.sample_rate') !== 24000 || values.get('haru.frame_samples') !== 3200 || typeof requiredVersion !== 'string' || values.get('speech.layout') !== 1 || (values.get('split.count') !== undefined && values.get('split.count') !== 1)) {
    throw speechError({ code: 'invalid_model', message: 'This session requires a Haru dialogue GGUF with 24 kHz, 3200-sample frames' });
  }
  return { kind: 'speech', info: { name, bytes: file.size, architecture: 'haru', task: 'dialogue', sampleRate: 24000, frameSamples: 3200, requiredVersion } };
}

export type SpeechFileSource = {
  size: number;
  read({ destination, offset }: { destination: Uint8Array, offset: number }): number;
};

/** Synchronous worker I/O is injected so no whole-model arrayBuffer is needed.
 * Keep offsets as safe JS numbers, including source positions above 4 GiB. */
export function createSpeechFileSource({ file, readBlob, maxReadBytes, onRead }: {
  file: Blob, readBlob: ({ blob }: { blob: Blob }) => ArrayBuffer, maxReadBytes: number,
  onRead: (({ offset, length }: { offset: number, length: number }) => void) | undefined,
}): SpeechFileSource {
  if (!Number.isSafeInteger(file.size) || file.size < 24 || !Number.isSafeInteger(maxReadBytes) || maxReadBytes < 24 || maxReadBytes > 8 * 1024 * 1024) {
    throw speechError({ code: 'invalid_model', message: 'Invalid speech model range-reader limits' });
  }
  const windowBytes = Math.min(1024 * 1024, maxReadBytes);
  let window: { offset: number, bytes: Uint8Array } | undefined;
  function readRange({ offset, length }: { offset: number, length: number }): Uint8Array {
    const bytes = new Uint8Array(readBlob({ blob: file.slice(offset, offset + length) }));
    if (bytes.length !== length) {
      throw speechError({ code: 'invalid_model', message: 'Speech model file could not be read completely' });
    }
    return bytes;
  }
  return {
    size: file.size,
    read({ destination, offset }) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size) {
        throw speechError({ code: 'invalid_model', message: 'Invalid speech model file offset' });
      }
      const length = Math.min(destination.byteLength, file.size - offset, maxReadBytes);
      if (length === 0) {
        return 0;
      }
      let bytes: Uint8Array;
      if (length >= windowBytes) {
        // Weight reads retain their existing range limit and avoid cache copies.
        bytes = readRange({ offset, length });
      } else {
        if (window === undefined || offset < window.offset || offset - window.offset + length > window.bytes.length) {
          // This window belongs to one immutable Blob and stays outside Wasm.
          const replacement = readRange({ offset, length: Math.min(windowBytes, file.size - offset) });
          window = { offset, bytes: replacement };
        }
        bytes = window.bytes.subarray(offset - window.offset, offset - window.offset + length);
      }
      destination.set(bytes);
      // Prefetched bytes do not count as native reads or load progress.
      onRead?.({ offset, length });
      return length;
    },
  };
}

export const TEST_ONLY = {
};
