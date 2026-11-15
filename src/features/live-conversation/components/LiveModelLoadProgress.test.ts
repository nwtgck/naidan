import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { SpeechLoadProgress } from '@/features/speech-cpp-browser/types';
import LiveModelLoadProgress from './LiveModelLoadProgress.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function fixture({ progress }: { progress: SpeechLoadProgress | undefined }) {
  const wrapper = mount(LiveModelLoadProgress, { props: { progress } });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('model loading progress identifies what the bar measures', () => {
  it('uses Wasm decompressed bytes for runtime progress and labels fetched bytes separately', () => {
    using f = fixture({ progress: { stage: 'loading_runtime', fetchedBytes: 1024 * 1024, decompressedBytes: 4 * 1024 * 1024, totalDecompressedBytes: 16 * 1024 * 1024 } });
    expect(f.wrapper.get('[data-testid="live-load-stage"]').text()).toContain('Wasm');
    expect(f.wrapper.get('[data-testid="live-load-percent"]').text()).toBe('25%');
    expect(f.wrapper.get('[data-testid="live-load-bytes"]').text()).toBe('Fetched 1 MiB · Wasm 4 / 16 MiB');
    expect(f.wrapper.get('[data-testid="live-load-bar"]').attributes('aria-valuenow')).toBe('25');
  });

  it('uses actual model-file reads for model progress and returns to indeterminate preparation afterward', async () => {
    using f = fixture({ progress: { stage: 'reading_model', readBytes: 8 * 1024 * 1024, totalBytes: 8 * 1024 * 1024 } });
    expect(f.wrapper.get('[data-testid="live-load-percent"]').text()).toBe('100%');
    expect(f.wrapper.get('[data-testid="live-load-stage"]').text()).toContain('model file');
    expect(f.wrapper.get('[data-testid="live-load-bytes"]').text()).toBe('Read 8 / 8 MiB');
    await f.wrapper.setProps({ progress: { stage: 'preparing_model' } });
    expect(f.wrapper.get('[data-testid="live-load-stage"]').text()).toBe('Preparing the model…');
    expect(f.wrapper.get('[data-testid="live-load-bar"]').attributes('aria-valuenow')).toBeUndefined();
    expect(f.wrapper.find('[data-testid="live-load-percent"]').exists()).toBe(false);
  });

  it.each([undefined, { stage: 'preparing_runtime' }, { stage: 'preparing_model' }] as const)('keeps a bar without inventing a percentage for %j', progress => {
    using f = fixture({ progress });
    expect(f.wrapper.get('[data-testid="live-load-bar"]').attributes('aria-valuenow')).toBeUndefined();
    expect(f.wrapper.find('[data-testid="live-load-percent"]').exists()).toBe(false);
  });
});
