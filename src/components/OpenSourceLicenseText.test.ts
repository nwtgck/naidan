import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import OpenSourceLicenseText from './OpenSourceLicenseText.vue';

function createBody({ text }: { text: string | null }) {
  const readLicenseText = vi.fn(() => text);
  const wrapper = mount(OpenSourceLicenseText, { props: { index: 3, readLicenseText } });
  return {
    readLicenseText,
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('OpenSourceLicenseText', () => {
  it('reads once per input and clears its ref before unmount even if the test retains the instance', async () => {
    using body = createBody({ text: 'Original complete body' });
    const text = body.wrapper.vm.TEST_ONLY.licenseText;
    expect(body.readLicenseText).toHaveBeenCalledExactlyOnceWith({ index: 3 });
    expect(text.value).toBe('Original complete body');
    const replacement = vi.fn(({ index }: { index: number }) => `Replacement ${index}`);
    await body.wrapper.setProps({ index: 4, readLicenseText: replacement });
    expect(replacement).toHaveBeenCalledExactlyOnceWith({ index: 4 });
    expect(text.value).toBe('Replacement 4');
    await body.wrapper.setProps({ index: 4 });
    expect(replacement).toHaveBeenCalledTimes(1);
    body.wrapper.unmount();
    expect(text.value).toBeUndefined();
  });

  it('renders legal text as text, never HTML, while preserving original code units in state', () => {
    const raw = '<script>throw "never execute"</script>\r\n<a href="bad">not a link</a>\r\n😀\u0000';
    using body = createBody({ text: raw });
    expect(body.wrapper.vm.TEST_ONLY.licenseText.value).toBe(raw);
    expect(body.wrapper.find('script').exists()).toBe(false);
    expect(body.wrapper.find('a').exists()).toBe(false);
    expect(body.wrapper.get('[data-testid="oss-license-text"]').element.textContent).toBe(raw);
  });
});
