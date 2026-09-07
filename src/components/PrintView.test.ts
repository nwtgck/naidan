import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import PrintView from './PrintView.vue';

describe('PrintView component', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark');
    document.body.innerHTML = '';
  });

  it('teleports the print layer directly under body and renders slot content', () => {
    const appHost = document.createElement('div');
    appHost.id = 'app';
    document.body.append(appHost);

    const wrapper = mount(PrintView, {
      attachTo: appHost,
      slots: {
        default: '<div class="test-content">Slot Content</div>',
      },
    });

    try {
      const root = document.body.querySelector<HTMLElement>(':scope > .naidan-print-view-layer');
      expect(root).not.toBeNull();
      expect(root?.parentElement).toBe(document.body);
      expect(appHost.contains(root)).toBe(false);
      expect(root?.classList.contains('bg-white')).toBe(true);
      expect(root?.classList.contains('dark:bg-gray-950')).toBe(true);
      expect(root?.style.display).toBe('none');
      expect(root?.querySelector('.test-content')?.textContent).toBe('Slot Content');
    } finally {
      wrapper.unmount();
      appHost.remove();
    }
  });

  it('keeps the teleported layer under the document-level dark theme ancestor', () => {
    document.documentElement.classList.add('dark');
    const appHost = document.createElement('div');
    appHost.id = 'app';
    document.body.append(appHost);

    const wrapper = mount(PrintView, { attachTo: appHost });

    try {
      const root = document.body.querySelector<HTMLElement>(':scope > .naidan-print-view-layer');
      expect(root).not.toBeNull();
      expect(root?.closest('.dark')).toBe(document.documentElement);
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    } finally {
      wrapper.unmount();
      appHost.remove();
    }
  });

  it('removes the teleported layer when the component unmounts', () => {
    const appHost = document.createElement('div');
    appHost.id = 'app';
    document.body.append(appHost);
    const wrapper = mount(PrintView, { attachTo: appHost });

    expect(document.body.querySelector(':scope > .naidan-print-view-layer')).not.toBeNull();
    wrapper.unmount();
    expect(document.body.querySelector(':scope > .naidan-print-view-layer')).toBeNull();
    appHost.remove();
  });
});
