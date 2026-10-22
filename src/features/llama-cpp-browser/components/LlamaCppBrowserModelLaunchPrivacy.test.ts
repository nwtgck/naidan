import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import LlamaCppBrowserModelLaunchPrivacy from './LlamaCppBrowserModelLaunchPrivacy.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('browser model privacy disclosure', () => {
  it('describes local preparation without claiming files come from Hugging Face', async () => {
    const wrapper = mount(LlamaCppBrowserModelLaunchPrivacy, { props: { appearance: 'compact', fileSource: 'local' }, global: { stubs: { Teleport: true } } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await wrapper.get('[data-testid="model-launch-privacy-trigger"]').trigger('click');
    const explanation = wrapper.get('[data-testid="model-launch-privacy-explanation"]');
    expect(explanation.text()).not.toContain('Hugging Face');
    expect(explanation.findAll('li')).toHaveLength(2);
  });

  it('opens its initially collapsed explanation on an explicit click', async () => {
    const wrapper = mount(LlamaCppBrowserModelLaunchPrivacy, { attachTo: document.body, global: { stubs: { Teleport: true } } });
    const trigger = wrapper.get('[data-testid="model-launch-privacy-trigger"]');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('[data-testid="model-launch-privacy-explanation"]').exists()).toBe(false);
    expect(trigger.text()).toContain('Private, in your browser');
    await trigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('true');
    const explanation = wrapper.get('[data-testid="model-launch-privacy-explanation"]');
    expect(trigger.attributes('aria-controls')).toBe(explanation.attributes('id'));
    expect(explanation.text()).toContain('not in the cloud');
    expect(explanation.findAll('li')).toHaveLength(3);
    expect(explanation.findAll('li').every(item => item.findAll('p').length === 2)).toBe(true);
    expect(explanation.text()).toContain('Hugging Face');
    expect(explanation.text()).not.toContain('Tools and other model connections');
    wrapper.unmount();
  });

  it('closes on Escape and returns focus to the disclosure control', async () => {
    const wrapper = mount(LlamaCppBrowserModelLaunchPrivacy, { attachTo: document.body, global: { stubs: { Teleport: true } } });
    const trigger = wrapper.get('[data-testid="model-launch-privacy-trigger"]');
    await trigger.trigger('click');
    await trigger.trigger('keydown', { key: 'Escape' });
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('[data-testid="model-launch-privacy-explanation"]').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    wrapper.unmount();
  });

  it('does not reuse a controls id between disclosures in split views', () => {
    const first = mount(LlamaCppBrowserModelLaunchPrivacy, { attachTo: document.body, global: { stubs: { Teleport: true } } });
    const second = mount({ components: { LlamaCppBrowserModelLaunchPrivacy }, template: '<div><LlamaCppBrowserModelLaunchPrivacy /><LlamaCppBrowserModelLaunchPrivacy /></div>' });
    const controls = second.findAll('[data-testid="model-launch-privacy-trigger"]').map(trigger => trigger.attributes('aria-controls'));
    expect(new Set(controls).size).toBe(2);
    first.unmount();
    second.unmount();
  });
});
