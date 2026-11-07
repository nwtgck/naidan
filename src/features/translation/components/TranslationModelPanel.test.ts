import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import TranslationModelPanel from './TranslationModelPanel.vue';

const lifecycle = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }));
vi.mock('./TranslationModels.vue', () => ({
  __esModule: true,
  default: {
    props: ['disabled', 'suspended', 'modelId'],
    emits: ['select', 'changed'],
    mounted: lifecycle.mounted,
    unmounted: lifecycle.unmounted,
    template: '<div data-testid="panel-models" :data-suspended="suspended"><button data-testid="panel-select" :disabled="disabled || suspended" @click="$emit(\'select\', \'local/model\')">Select</button><button data-testid="panel-last">Last</button></div>',
  },
}));

beforeEach(async () => {
  lifecycle.mounted.mockClear();
  lifecycle.unmounted.mockClear();
  await ensureAllStringsForTest({ locale: 'en' });
});

function fixture({ open, drawer }: { open: boolean, drawer: boolean }) {
  const parent = document.createElement('div');
  const trigger = document.createElement('button');
  document.body.append(trigger, parent);
  trigger.focus();
  const wrapper = mount(TranslationModelPanel, { attachTo: parent, props: { open, drawer, disabled: false, modelId: 'local/model', returnFocus: trigger } });
  return {
    wrapper,
    trigger,
    [Symbol.dispose]() {
      wrapper.unmount();
      parent.remove();
      trigger.remove();
    },
  };
}

describe('translation catalog and model drawer ownership', () => {
  it('does not mount the model manager for a closed, unvisited catalog', async () => {
    using f = fixture({ open: false, drawer: false });
    await flushPromises();
    expect(lifecycle.mounted).not.toHaveBeenCalled();
    expect(f.wrapper.get('[data-testid="translation-model-panel"]').element.closest('[inert]')).not.toBeNull();
  });

  it('preserves one catalog instance through collapse and actual teleport into the drawer', async () => {
    using f = fixture({ open: true, drawer: false });
    await flushPromises();
    expect(lifecycle.mounted).toHaveBeenCalledOnce();
    await f.wrapper.setProps({ open: false });
    await flushPromises();
    expect(document.querySelector('[data-testid="panel-models"]')?.getAttribute('data-suspended')).toBe('true');
    await f.wrapper.setProps({ open: true, drawer: true });
    await flushPromises();
    expect(document.querySelector('[data-testid="translation-model-panel"]')?.getAttribute('role')).toBe('dialog');
    expect(lifecycle.mounted).toHaveBeenCalledOnce();
    expect(lifecycle.unmounted).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="panel-models"]')?.getAttribute('data-suspended')).toBe('false');
    await f.wrapper.setProps({ open: false, drawer: false });
    await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(f.trigger);
  });

  it('focuses a directly opened drawer and restores the trigger after closing', async () => {
    using f = fixture({ open: true, drawer: true });
    await flushPromises();
    expect(document.activeElement).toBe(document.querySelector('[data-testid="translation-model-panel"]'));
    const close = document.querySelector<HTMLButtonElement>('[data-testid="translation-close-models"]')!;
    close.click();
    expect(f.wrapper.emitted('close')).toHaveLength(1);
    await f.wrapper.setProps({ open: false, drawer: false });
    await flushPromises();
    expect(document.activeElement).toBe(f.trigger);
  });

  it('respects consumed Escape events and closes on an otherwise unhandled Escape', async () => {
    using f = fixture({ open: true, drawer: true });
    await flushPromises();
    const panel = document.querySelector<HTMLElement>('[data-testid="translation-model-panel"]')!;
    const consumed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    consumed.preventDefault();
    panel.dispatchEvent(consumed);
    expect(f.wrapper.emitted('close')).toBeUndefined();
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(f.wrapper.emitted('close')).toHaveLength(1);
  });

  it('keeps forward and backward keyboard traversal within visible drawer controls', async () => {
    using _f = fixture({ open: true, drawer: true });
    await flushPromises();
    const panel = document.querySelector<HTMLElement>('[data-testid="translation-model-panel"]')!;
    using rectangles = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect()] as unknown as DOMRectList);
    const first = panel.querySelector<HTMLButtonElement>('[data-testid="translation-close-models"]')!;
    const last = panel.querySelector<HTMLButtonElement>('[data-testid="panel-last"]')!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(last);
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);
    expect(rectangles).toHaveBeenCalled();
  });
});
