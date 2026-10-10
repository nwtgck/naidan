import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import LlamaCppBrowserFirefoxWebGpuWarning from './LlamaCppBrowserFirefoxWebGpuWarning.vue';

const wrappers: VueWrapper[] = [];

function mountWarning(): VueWrapper {
  const wrapper = mount(LlamaCppBrowserFirefoxWebGpuWarning);
  wrappers.push(wrapper);
  return wrapper;
}

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

describe('LlamaCppBrowserFirefoxWebGpuWarning', () => {
  it('presents the recommendation before the reason and labels the notice without an interrupting alert', () => {
    const wrapper = mountWarning();
    const recommendation = wrapper.get('[data-testid="firefox-webgpu-recommendation"]');
    const reason = wrapper.get('[data-testid="firefox-webgpu-reason"]');
    expect(recommendation.text()).toContain('Chromium-based browser');
    expect(reason.text()).toContain('Firefox');
    expect(recommendation.element.compareDocumentPosition(reason.element) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(wrapper.attributes('aria-labelledby')).toBe(recommendation.attributes('id'));
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    // WelcomeScreen is pointer-events-none; the notice must opt back in.
    expect(wrapper.classes()).toContain('pointer-events-auto');
  });

  it('keeps source details after the reason in the same text column', () => {
    const wrapper = mountWarning();
    const reason = wrapper.get('[data-testid="firefox-webgpu-reason"]');
    const details = wrapper.get('[data-testid="firefox-webgpu-details"]');
    const summary = wrapper.get('[data-testid="firefox-webgpu-details-summary"]');
    const content = wrapper.get('[data-testid="firefox-webgpu-details-content"]');
    expect(details.element.parentElement).toBe(reason.element.parentElement);
    expect(reason.element.compareDocumentPosition(details.element) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(details.element.firstElementChild).toBe(summary.element);
    expect(summary.element.nextElementSibling).toBe(content.element);
  });

  it('uses a closed native disclosure with a keyboard-focusable summary', async () => {
    const wrapper = mountWarning();
    const details = wrapper.get<HTMLDetailsElement>('[data-testid="firefox-webgpu-details"]');
    const summary = wrapper.get('[data-testid="firefox-webgpu-details-summary"]');
    expect(details.element.tagName).toBe('DETAILS');
    expect(details.element.open).toBe(false);
    expect(summary.element.tagName).toBe('SUMMARY');
    expect(summary.text()).toContain('Technical details');
    await summary.trigger('click');
    expect(details.element.open).toBe(true);
    await summary.trigger('click');
    expect(details.element.open).toBe(false);
  });

  it('keeps both canonical Mozilla links in the disclosure without loading external content', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const wrapper = mountWarning();
    const details = wrapper.get('[data-testid="firefox-webgpu-details"]');
    const links = details.findAll('a');
    expect(links.map(link => link.attributes('href'))).toEqual([
      'https://bugzilla.mozilla.org/show_bug.cgi?id=1870699',
      'https://bugzilla.mozilla.org/show_bug.cgi?id=1900273',
    ]);
    expect(links[0]?.text()).toContain("Don't poll WebGPU from a timer");
    expect(links[1]?.text()).toContain('await mapAsync slow');
    for (const link of links) {
      expect(link.attributes('target')).toBe('_blank');
      expect(link.attributes('rel')?.split(' ')).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
    }
    await wrapper.get('[data-testid="firefox-webgpu-details-summary"]').trigger('click');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses distinct accessible heading IDs when multiple chat panes show the notice', () => {
    const wrapper = mount(defineComponent({
      setup: () => () => h('div', [h(LlamaCppBrowserFirefoxWebGpuWarning), h(LlamaCppBrowserFirefoxWebGpuWarning)]),
    }));
    wrappers.push(wrapper);
    const notices = wrapper.findAll('[data-testid="firefox-webgpu-warning"]');
    expect(notices).toHaveLength(2);
    expect(notices[0]?.attributes('aria-labelledby')).not.toBe(notices[1]?.attributes('aria-labelledby'));
  });
});
