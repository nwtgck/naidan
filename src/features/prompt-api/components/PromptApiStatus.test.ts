import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { ensureAllStringsForTest } from '@/strings/test-utils';
import { TEST_ONLY } from '@/features/prompt-api/runtime';

import PromptApiStatus from './PromptApiStatus.vue';

beforeEach(async () => {
  TEST_ONLY.reset();
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  TEST_ONLY.reset();
  vi.unstubAllGlobals();
});

describe('PromptApiStatus', () => {
  it('keeps the feature visible when LanguageModel is unavailable', async () => {
    vi.stubGlobal('LanguageModel', undefined);

    const wrapper = mount(PromptApiStatus);
    await flushPromises();

    const notice = wrapper.get('[data-testid="browser-provided-lm-unavailable-notice"]');
    expect(notice.text()).toContain(
      'Browser-provided language models are not available in this browser.',
    );
    expect(notice.text()).toContain('Google Chrome 148 or later');
    expect(wrapper.classes()).toContain('md:col-span-2');

    wrapper.unmount();
  });

  it('shows download progress and hides after preparation completes', async () => {
    let resolveSession!: (session: {
      promptStreaming: () => ReadableStream<string>,
      destroy: () => void,
    }) => void;
    const sessionPromise = new Promise<{
      promptStreaming: () => ReadableStream<string>,
      destroy: () => void,
        }>(resolve => {
          resolveSession = resolve;
        });

    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue('downloadable'),
      create: vi.fn((options: {
        monitor?: (monitor: {
          addEventListener: (
            type: 'downloadprogress',
            listener: (event: ProgressEvent) => void,
          ) => void,
        }) => void,
      }) => {
        options.monitor?.({
          addEventListener: (_type, listener) => {
            listener({ loaded: 0.4 } as ProgressEvent);
          },
        });
        return sessionPromise;
      }),
    });

    const wrapper = mount(PromptApiStatus);
    await flushPromises();

    await wrapper.get('[data-testid="prompt-api-prepare-button"]').trigger('click');
    await nextTick();
    expect(wrapper.text()).toContain('40%');

    resolveSession({
      promptStreaming: () => new ReadableStream<string>(),
      destroy: vi.fn(),
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="prompt-api-status"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
