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

  it('attaches a download monitor and replaces indeterminate progress with a percentage', async () => {
    let downloadProgressListener: ((event: ProgressEvent) => void) | undefined;
    const create = vi.fn((options: {
      monitor?: (monitor: {
        addEventListener: (
          type: 'downloadprogress',
          listener: (event: ProgressEvent) => void,
        ) => void,
      }) => void,
    }) => {
      options.monitor?.({
        addEventListener: (_type, listener) => {
          downloadProgressListener = listener;
        },
      });
      return new Promise<unknown>(() => {});
    });
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue('downloading'),
      create,
    });

    const wrapper = mount(PromptApiStatus);
    await flushPromises();

    expect(create).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('Downloading browser-provided model');
    expect(wrapper.get('[data-testid="prompt-api-download-progress-track"]')
      .attributes('aria-valuenow')).toBeUndefined();
    expect(wrapper.find('[data-testid="prompt-api-download-progress-indeterminate"]')
      .exists()).toBe(true);

    downloadProgressListener?.({ loaded: 0.35 } as ProgressEvent);
    await nextTick();

    expect(wrapper.text()).toContain('35%');
    expect(wrapper.get('[data-testid="prompt-api-download-progress-track"]')
      .attributes('aria-valuenow')).toBe('35');
    expect(wrapper.find('[data-testid="prompt-api-download-progress-determinate"]')
      .exists()).toBe(true);
    expect(wrapper.find('[data-testid="prompt-api-download-progress-indeterminate"]')
      .exists()).toBe(false);

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
    const keeper = {
      promptStreaming: () => new ReadableStream<string>(),
      destroy: vi.fn(),
    };
    const create = vi.fn((options: {
      monitor?: (monitor: {
        addEventListener: (
          type: 'downloadprogress',
          listener: (event: ProgressEvent) => void,
        ) => void,
      }) => void,
    }) => {
      if (create.mock.calls.length === 1) {
        options.monitor?.({
          addEventListener: (_type, listener) => {
            listener({ loaded: 0.4 } as ProgressEvent);
          },
        });
        return sessionPromise;
      }
      return Promise.resolve(keeper);
    });

    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue('downloadable'),
      create,
    });

    const wrapper = mount(PromptApiStatus);
    await flushPromises();

    await wrapper.get('[data-testid="prompt-api-prepare-button"]').trigger('click');
    await nextTick();
    expect(wrapper.text()).toContain('40%');
    expect(wrapper.get('[data-testid="prompt-api-download-progress-track"]')
      .attributes('aria-valuenow')).toBe('40');
    expect(wrapper.get('[data-testid="prompt-api-download-progress-determinate"]')
      .attributes('style')).toContain('width: 40%');
    expect(wrapper.find('[data-testid="prompt-api-download-progress-indeterminate"]')
      .exists()).toBe(false);

    resolveSession({
      promptStreaming: () => new ReadableStream<string>(),
      destroy: vi.fn(),
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="prompt-api-status"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
