import { ggufFixture, ggufInteger, textMetadata } from '@/features/audio-generation/test-utils/gguf.test-support';

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
