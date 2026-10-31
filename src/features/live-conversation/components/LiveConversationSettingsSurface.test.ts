import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, onMounted, onUnmounted } from 'vue';
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import LiveConversationSettingsSurface from './LiveConversationSettingsSurface.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function fixture() {
  const mounted = vi.fn();
  const unmounted = vi.fn();
  const Probe = defineComponent({
    setup() {
      onMounted(mounted);
      onUnmounted(unmounted);
      return () => h('div', [
        h('input', { 'data-testid': 'selection', value: 'model-A' }),
        h('button', { 'data-testid': 'last-action' }, 'Last'),
        h('button', { disabled: true }, 'Disabled'),
        h('button', { tabindex: -1 }, 'Not in tab order'),
        h('div', { inert: true }, h('button', { 'data-testid': 'collapsed-action' }, 'Collapsed')),
      ]);
    },
  });
  const host = document.createElement('div');
  const opener = document.createElement('button');
  document.body.append(opener, host);
  const wrapper = mount(LiveConversationSettingsSurface, { props: { open: false, onboarding: true }, attachTo: host, slots: { default: () => h(Probe) } });
  const page = new DOMWrapper(document.body);
  return {
    wrapper,
    host,
    opener,
    page,
    mounted,
    unmounted,
    [Symbol.dispose]() {
      wrapper.unmount();
      host.remove();
      opener.remove();
    },
  };
}

describe('live settings modal and first-use surface', () => {
  it('moves the same settings to a modal without remounting downloads or losing selections', async () => {
    using f = fixture();
    const input = f.wrapper.get<HTMLInputElement>('[data-testid="selection"]').element;
    input.value = 'model-B';
    f.opener.focus();
    await f.wrapper.setProps({ open: true });
    await flushPromises();
    expect(f.page.get('[role="dialog"]').attributes('aria-modal')).toBe('true');
    expect(f.host.contains(input)).toBe(false);
    expect(f.page.get<HTMLInputElement>('[data-testid="selection"]').element).toBe(input);
    expect(input.value).toBe('model-B');
    expect(f.mounted).toHaveBeenCalledOnce();
    expect(f.unmounted).not.toHaveBeenCalled();
    await f.wrapper.setProps({ open: false, onboarding: false });
    await flushPromises();
    expect(document.activeElement).toBe(f.opener);
    expect(f.page.get('[data-testid="live-settings-surface"]').isVisible()).toBe(false);
    await f.wrapper.setProps({ onboarding: true });
    expect(f.host.contains(input)).toBe(true);
    expect(f.mounted).toHaveBeenCalledOnce();
    expect(f.unmounted).not.toHaveBeenCalled();
  });

  it('traps focus, skipping disabled and collapsed controls', async () => {
    using f = fixture();
    await f.wrapper.setProps({ open: true });
    await flushPromises();
    const close = f.page.get<HTMLButtonElement>('[data-testid="live-settings-close"]');
    const last = f.page.get<HTMLButtonElement>('[data-testid="last-action"]');
    expect(document.activeElement).toBe(close.element);
    await close.trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last.element);
    await last.trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(close.element);
  });

  it('closes by Escape or backdrop, without consuming nested Escape or composition', async () => {
    using f = fixture();
    await f.wrapper.setProps({ open: true });
    const dialog = f.page.get('[role="dialog"]');
    await dialog.trigger('keydown', { key: 'Escape', isComposing: true });
    const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    handled.preventDefault();
    dialog.element.dispatchEvent(handled);
    expect(f.wrapper.emitted('close')).toBeUndefined();
    await dialog.trigger('keydown', { key: 'Escape' });
    expect(f.wrapper.emitted('close')).toHaveLength(1);
    await f.page.get('[data-testid="live-settings-surface"]').trigger('click');
    expect(f.wrapper.emitted('close')).toHaveLength(2);
    await dialog.trigger('click');
    expect(f.wrapper.emitted('close')).toHaveLength(2);
  });

  it('does not turn inline setup into a focus trap or close on ordinary clicks', async () => {
    using f = fixture();
    expect(f.wrapper.find('[role="dialog"]').exists()).toBe(false);
    await f.wrapper.get('[data-testid="live-settings-surface"]').trigger('click');
    await f.wrapper.get('[data-testid="selection"]').trigger('keydown', { key: 'Escape' });
    expect(f.wrapper.emitted('close')).toBeUndefined();
  });
});
