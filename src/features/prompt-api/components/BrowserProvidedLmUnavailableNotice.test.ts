import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';

import { ensureAllStringsForTest } from '@/strings/test-utils';
import { PromptApiError } from '@/features/prompt-api/errors';

import BrowserProvidedLmUnavailableNotice from './BrowserProvidedLmUnavailableNotice.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('BrowserProvidedLmUnavailableNotice', () => {
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
