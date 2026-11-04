import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import LlamaCppBrowserErrorDetails from './LlamaCppBrowserErrorDetails.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => vi.unstubAllGlobals());

describe('runtime error disclosure', () => {
  it('places summary and toggle in one row and copies exact escaped multiline details', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const details = `\
DataCloneError: The object can not be cloned.
postMessage@[native code]
<script>untrusted</script>`;
    const wrapper = mount(LlamaCppBrowserErrorDetails, { props: { summary: 'Could not prepare the model.', details } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const row = wrapper.get('[data-testid="llama-error-summary-row"]');
    expect(row.element.tagName).toBe('P');
    expect(row.get('[data-testid="llama-error-details-toggle"]').element.parentElement).toBe(row.element);
    expect(row.get('button').text()).toContain('Could not prepare the model.');
    expect(row.get('[data-testid="llama-error-details-label"]').text()).toBe('Details');
    expect(row.findAll('button')).toHaveLength(1);
    expect(row.text()).toContain('Could not prepare the model.');
    expect(row.find('[data-testid="llama-error-details-toggle"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="llama-error-details-text"]').exists()).toBe(false);
    await row.get('button').trigger('click');
    expect(wrapper.get('[data-testid="llama-error-details-text"]').text()).toBe(details);
    expect(wrapper.find('script').exists()).toBe(false);
    await wrapper.get('[data-testid="llama-error-details-copy"]').trigger('click');
    expect(writeText).toHaveBeenCalledExactlyOnceWith(details);
    expect(wrapper.text()).toContain('Copied');
    await wrapper.setProps({ details: 'A different operation failed' });
    expect(wrapper.get('[data-testid="llama-error-details-toggle"]').attributes('aria-expanded')).toBe('false');
    expect(wrapper.text()).not.toContain('Copied');
  });

  it('offers selectable error text when clipboard access fails', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('Clipboard denied');
        }),
      },
    });
    const wrapper = mount(LlamaCppBrowserErrorDetails, { props: { summary: 'Failed.', details: 'Native failure' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await wrapper.get('[data-testid="llama-error-details-toggle"]').trigger('click');
    await wrapper.get('[data-testid="llama-error-details-copy"]').trigger('click');
    expect(wrapper.get('[role="status"]').text()).toContain('Select the text');
    expect(wrapper.get('[data-testid="llama-error-details-text"]').text()).toBe('Native failure');
  });
});
