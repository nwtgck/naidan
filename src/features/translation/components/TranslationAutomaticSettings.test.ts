import { beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import TranslationAutomaticSettings from './TranslationAutomaticSettings.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function fixture() {
  const active = ref(true);
  const parent = document.createElement('div');
  document.body.append(parent);
  const wrapper = mount(TranslationAutomaticSettings, { attachTo: parent, props: { debounceMs: 600, disabled: false }, global: { provide: { 'settings-disclosure-open': active } } });
  return {
    wrapper,
    active,
    [Symbol.dispose]() {
      wrapper.unmount();
      parent.remove();
    },
  };
}

describe('automatic translation details', () => {
  it.each([{ raw: '1333', expected: 1300 }, { raw: '50', expected: 200 }, { raw: '5000', expected: 3000 }])('normalizes timing without pretending a pending save has succeeded: $raw', async ({ raw, expected }) => {
    using f = fixture();
    await f.wrapper.get('button').trigger('click');
    const input = document.querySelector<HTMLInputElement>('[data-testid="translation-debounce"]')!;
    expect(document.activeElement).toBe(input);
    input.value = raw;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    expect(f.wrapper.emitted('change')).toEqual([[expected]]);
    expect(input.value).toBe('600');
    await f.wrapper.setProps({ debounceMs: expected });
    expect(input.value).toBe(String(expected));
  });

  it('ignores an empty value and composition Enter, then commits Enter with focus restoration', async () => {
    using f = fixture();
    await f.wrapper.get('button').trigger('click');
    const input = document.querySelector<HTMLInputElement>('[data-testid="translation-debounce"]')!;
    input.value = '';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(f.wrapper.emitted('change')).toBeUndefined();
    expect(input.value).toBe('600');
    input.value = '1200';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    expect(f.wrapper.emitted('change')).toBeUndefined();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(f.wrapper.emitted('change')).toEqual([[1200]]);
    expect(document.querySelector('[data-testid="translation-auto-settings-panel"]')).toBeNull();
    expect(document.activeElement).toBe(f.wrapper.get('button').element);
  });

  it('closes when its scope hides and ignores a late event from the detached input', async () => {
    using f = fixture();
    await f.wrapper.get('button').trigger('click');
    const input = document.querySelector<HTMLInputElement>('[data-testid="translation-debounce"]')!;
    f.active.value = false;
    await flushPromises();
    expect(document.querySelector('[data-testid="translation-auto-settings-panel"]')).toBeNull();
    input.value = '2000';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(f.wrapper.emitted('change')).toBeUndefined();
  });
});
