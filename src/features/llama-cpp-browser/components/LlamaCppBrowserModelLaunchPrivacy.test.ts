import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import LlamaCppBrowserModelLaunchPrivacy from './LlamaCppBrowserModelLaunchPrivacy.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('browser model privacy disclosure', () => {
  it('uses a native, initially collapsed disclosure rather than hover-only text', () => {
    const wrapper = mount(LlamaCppBrowserModelLaunchPrivacy);
    const details = wrapper.get('details').element;
    expect(details.open).toBe(false);
    expect(wrapper.get('summary').text()).toContain('Private, in your browser');
    const explanation = wrapper.get('[data-testid="model-launch-privacy-explanation"]');
    expect(wrapper.get('summary').attributes('aria-controls')).toBe(explanation.attributes('id'));
    expect(explanation.text()).toContain('not in the cloud');
    expect(explanation.findAll('li')).toHaveLength(3);
    expect(explanation.findAll('li').every(item => item.findAll('p').length === 2)).toBe(true);
    expect(explanation.text()).toContain('Hugging Face');
    expect(explanation.text()).toContain('Tools and other model connections');
    wrapper.unmount();
  });

  it('closes on Escape and returns focus to the disclosure control', async () => {
    const wrapper = mount(LlamaCppBrowserModelLaunchPrivacy, { attachTo: document.body });
    const details = wrapper.get('details').element;
    details.open = true;
    await wrapper.get('summary').trigger('keydown', { key: 'Escape' });
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('summary').element);
    wrapper.unmount();
  });

  it('does not reuse a controls id between disclosures in split views', () => {
    const first = mount(LlamaCppBrowserModelLaunchPrivacy);
    const second = mount({ components: { LlamaCppBrowserModelLaunchPrivacy }, template: '<div><LlamaCppBrowserModelLaunchPrivacy /><LlamaCppBrowserModelLaunchPrivacy /></div>' });
    const controls = second.findAll('summary').map(summary => summary.attributes('aria-controls'));
    expect(new Set(controls).size).toBe(2);
    first.unmount(); second.unmount();
  });
});
