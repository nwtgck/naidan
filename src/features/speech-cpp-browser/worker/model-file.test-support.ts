import { ggufFixture, ggufInteger, textMetadata } from '@/features/audio-generation/test-utils/gguf.test-support';
import { vi } from 'vitest';
import { createSpeechFileSource } from './model-file';

export function speechFileBytes({ offset, length }: { offset: number, length: number }): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (offset + index) % 251);
}

/** A sparse immutable source makes large-offset reads testable without a model. */
export function speechFileSourceFixture({ size, maxReadBytes }: { size: number, maxReadBytes: number }) {
  const file = new Blob([]);
  Object.defineProperty(file, 'size', { value: size });
  const ranges = new WeakMap<Blob, { offset: number, length: number }>();
  const slices = vi.spyOn(file, 'slice').mockImplementation((start, end) => {
    const blob = new Blob([]), offset = start ?? 0, length = (end ?? size) - offset;
    Object.defineProperty(blob, 'size', { value: length });
    ranges.set(blob, { offset, length });
    return blob;
  });
  const readBlob = vi.fn(({ blob }: { blob: Blob }): ArrayBuffer => {
    const range = ranges.get(blob);
    if (range === undefined) {
      throw new Error('Expected a source-owned Blob slice');
    }
    return Uint8Array.from(speechFileBytes(range)).buffer;
  });
  const onRead = vi.fn();
  return { source: createSpeechFileSource({ file, maxReadBytes, readBlob, onRead }), readBlob, slices, onRead };
}

export function speechModelHeader({ architecture, frameSamples }: { architecture: string, frameSamples: number }) {
  return ggufFixture({
    entries: [
      textMetadata({ key: 'general.architecture', value: architecture }),
      textMetadata({ key: 'speech.task', value: 'dialogue' }),
      textMetadata({ key: 'speech.requires', value: '0.11.0' }),
      { key: 'speech.sample_rate', type: 4, value: ggufInteger({ value: 24000, bytes: 4 }) },
      { key: 'haru.frame_samples', type: 4, value: ggufInteger({ value: frameSamples, bytes: 4 }) },
      { key: 'speech.layout', type: 4, value: ggufInteger({ value: 1, bytes: 4 }) },
    ],
  });
}

export async function speechModelFile({ architecture, name, frameSamples }: { architecture: string, name: string, frameSamples: number }): Promise<File> {
  const blob = speechModelHeader({ architecture, frameSamples });
  return new File([await blob.arrayBuffer()], name);
}

export const TEST_ONLY = {
};
