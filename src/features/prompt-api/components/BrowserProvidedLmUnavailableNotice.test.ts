import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureAllStringsForTest } from '@/strings/test-utils';
import { PromptApiError } from '@/features/prompt-api/errors';

import BrowserProvidedLmUnavailableNotice from './BrowserProvidedLmUnavailableNotice.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function useUserAgent({ userAgent }: { userAgent: string }): void {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(userAgent);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BrowserProvidedLmUnavailableNotice', () => {
  it('shows Chrome-specific common reasons when the model is unavailable', () => {
    useUserAgent({
      userAgent: 'Mozilla/5.0 AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36',
    });

    const wrapper = mount(BrowserProvidedLmUnavailableNotice, {
      props: {
        state: { status: 'model_unavailable' },
      },
    });

    const reasons = wrapper.get('[data-testid="prompt-api-common-reasons"]').text();
    expect(reasons).toContain('Less than 22 GB of free space');
    expect(reasons).toContain('Less than 16 GB of RAM');
    expect(reasons).toContain('4 CPU cores');
    expect(reasons).toContain('4 GB of VRAM or less');
    expect(reasons).not.toContain('20 GB of free space');
    expect(wrapper.text()).toContain(
      'The browser-provided model is not currently available on this device.',
    );
    expect(wrapper.text()).toContain('The browser does not report the exact reason.');
    expect(
      wrapper.get('[data-testid="prompt-api-supported-browsers-details"]').attributes('open'),
    ).toBeUndefined();
  });

  it('shows Edge-specific common reasons when the model is unavailable', () => {
    useUserAgent({
      userAgent: 'Mozilla/5.0 AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0',
    });

    const wrapper = mount(BrowserProvidedLmUnavailableNotice, {
      props: {
        state: { status: 'model_unavailable' },
      },
    });

    const reasons = wrapper.get('[data-testid="prompt-api-common-reasons"]').text();
    expect(reasons).toContain('Less than 20 GB of free space');
    expect(reasons).toContain('less than 5.5 GB of VRAM');
    expect(reasons).toContain('device performance class');
    expect(reasons).toContain('required Edge experimental flags');
    expect(reasons).not.toContain('22 GB of free space');
  });

  it('shows generic common reasons when the browser cannot be identified', () => {
    useUserAgent({
      userAgent: 'Mozilla/5.0 Firefox/147.0',
    });

    const wrapper = mount(BrowserProvidedLmUnavailableNotice, {
      props: {
        state: { status: 'model_unavailable' },
      },
    });

    const reasons = wrapper.get('[data-testid="prompt-api-common-reasons"]').text();
    expect(reasons).toContain('There may not be enough free storage');
    expect(reasons).toContain('operating system or hardware requirements');
    expect(reasons).toContain('browser settings, experimental flags, or organization policy');
    expect(reasons).toContain('current network connection');
  });

  it('shows supported browsers and a synthetic diagnostic when the API is missing', () => {
    const wrapper = mount(BrowserProvidedLmUnavailableNotice, {
      props: {
        state: { status: 'api_unavailable' },
      },
    });

    expect(wrapper.text()).toContain('Google Chrome 148 or later');
    expect(wrapper.text()).toContain('Microsoft Edge Canary or Dev 138.0.3309.2 or later');
    expect(wrapper.get('[data-testid="prompt-api-technical-detail"]').text()).toContain(
      'LanguageModel API was not detected.',
    );
  });

  it('shows the raw browser error message for diagnosis', () => {
    const rawError = new DOMException(
      'The model cannot be created because the device does not meet the model requirements.',
      'NotSupportedError',
    );
    const wrapper = mount(BrowserProvidedLmUnavailableNotice, {
      props: {
        state: {
          status: 'error',
          phase: 'preparation',
          error: new PromptApiError({
            code: 'unsupported_input',
            message: 'Prompt API does not support this request.',
            cause: rawError,
          }),
        },
      },
    });

    expect(wrapper.get('[data-testid="prompt-api-technical-detail"]').text()).toBe(
      'NotSupportedError: The model cannot be created because the device does not meet the model requirements.',
    );
    expect(wrapper.get('details[open]').attributes('open')).toBeDefined();
  });
});
