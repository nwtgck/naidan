import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import ResourceLoadCspHint from './ResourceLoadCspHint.vue';

vi.mock('@/components/csp/CspMessageHint.vue', () => ({
  default: defineComponent({
    props: ['target', 'activityForDisplayOnly'],
    setup(props) {
      return () => props.target === undefined ? null : h('aside', { 'data-testid': 'passive-csp-hint', 'data-activity': props.activityForDisplayOnly }, JSON.stringify(props.target));
    },
  }),
}));

function imageFixture() {
  const element = document.createElement('img');
  const url = 'blob:https://app.invalid/first-image';
  element.src = url;
  document.body.append(element);
  let current = '';
  Object.defineProperty(element, 'currentSrc', { configurable: true, get: () => current });
  return {
    element,
    url,
    select({ source }: { source: string }) {
      current = source;
    },
    [Symbol.dispose]() {
      element.remove();
    },
  };
}

describe('passive resource load CSP display', () => {
  it('requires the observed current source and never changes the original image', async () => {
    using fixture = imageFixture();
    using view = {
      wrapper: mount(ResourceLoadCspHint, { props: { resources: [{ element: fixture.element, url: fixture.url, destination: 'image' }] } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    fixture.element.dispatchEvent(new Event('error'));
    await view.wrapper.vm.$nextTick();
    expect(view.wrapper.find('[data-testid="passive-csp-hint"]').exists()).toBe(false);
    fixture.select({ source: fixture.url });
    fixture.element.dispatchEvent(new Event('error'));
    await view.wrapper.vm.$nextTick();
    expect(view.wrapper.get('[data-testid="passive-csp-hint"]').text()).toContain(fixture.url);
    expect(view.wrapper.get('[data-testid="passive-csp-hint"]').attributes('data-activity')).toBeUndefined();
    expect(fixture.element.getAttribute('src')).toBe(fixture.url);
    fixture.element.dispatchEvent(new Event('load'));
    await view.wrapper.vm.$nextTick();
    expect(view.wrapper.find('[data-testid="passive-csp-hint"]').exists()).toBe(false);
    expect(fixture.element.getAttribute('src')).toBe(fixture.url);
  });

  it('removes old-source hints and ignores a late event from the previous source', async () => {
    using fixture = imageFixture();
    fixture.select({ source: fixture.url });
    using view = {
      wrapper: mount(ResourceLoadCspHint, { props: { resources: [{ element: fixture.element, url: fixture.url, destination: 'image' }] } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    fixture.element.dispatchEvent(new Event('error'));
    await view.wrapper.vm.$nextTick();
    expect(view.wrapper.find('[data-testid="passive-csp-hint"]').exists()).toBe(true);
    const replacement = 'blob:https://app.invalid/replacement-image';
    fixture.element.src = replacement;
    await view.wrapper.setProps({ resources: [{ element: fixture.element, url: replacement, destination: 'image' }] });
    fixture.element.dispatchEvent(new Event('error'));
    await view.wrapper.vm.$nextTick();
    expect(view.wrapper.find('[data-testid="passive-csp-hint"]').exists()).toBe(false);
    fixture.select({ source: replacement });
    fixture.element.dispatchEvent(new Event('error'));
    await view.wrapper.vm.$nextTick();
    expect(view.wrapper.get('[data-testid="passive-csp-hint"]').text()).toContain(replacement);
    expect(view.wrapper.get('[data-testid="passive-csp-hint"]').text()).not.toContain(fixture.url);
  });

  it('isolates listener setup failures while preserving existing error listeners', async () => {
    using fixture = imageFixture();
    fixture.select({ source: fixture.url });
    const existing = vi.fn();
    fixture.element.addEventListener('error', existing);
    const original = fixture.element.addEventListener.bind(fixture.element);
    using _add = vi.spyOn(fixture.element, 'addEventListener').mockImplementation((name, listener, options) => {
      if (name === 'loadedmetadata') {
        throw new Error('listener unavailable');
      }
      original(name, listener, options);
    });
    using view = {
      wrapper: mount(ResourceLoadCspHint, { props: { resources: [{ element: fixture.element, url: fixture.url, destination: 'image' }] } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    fixture.element.dispatchEvent(new Event('error'));
    await view.wrapper.vm.$nextTick();
    expect(existing).toHaveBeenCalledOnce();
    expect(view.wrapper.find('[data-testid="passive-csp-hint"]').exists()).toBe(false);
    expect(fixture.element.getAttribute('src')).toBe(fixture.url);
  });

  it('removes an existing supplement if later observation fails', async () => {
    using fixture = imageFixture();
    fixture.select({ source: fixture.url });
    using view = {
      wrapper: mount(ResourceLoadCspHint, { props: { resources: [{ element: fixture.element, url: fixture.url, destination: 'image' }] } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    fixture.element.dispatchEvent(new Event('error'));
    await view.wrapper.vm.$nextTick();
    expect(view.wrapper.find('[data-testid="passive-csp-hint"]').exists()).toBe(true);
    Object.defineProperty(fixture.element, 'currentSrc', {
      configurable: true,
      get() {
        throw new Error('inspection unavailable');
      },
    });
    fixture.element.dispatchEvent(new Event('error'));
    await view.wrapper.vm.$nextTick();
    expect(view.wrapper.find('[data-testid="passive-csp-hint"]').exists()).toBe(false);
    expect(fixture.element.getAttribute('src')).toBe(fixture.url);
  });
});
