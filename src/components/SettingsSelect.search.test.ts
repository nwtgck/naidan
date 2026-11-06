import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import SettingsSelect from './SettingsSelect.vue';

function fixture() {
  const parent = document.createElement('div');
  document.body.append(parent);
  const wrapper = mount(SettingsSelect, {
    attachTo: parent,
    props: {
      modelValue: 'en',
      label: 'Target language',
      search: { label: 'Search languages', noResults: 'No matching languages' },
      options: [{ value: 'ja', label: '日本語', searchTerms: ['Japanese'] }, { value: 'en', label: '英語', searchTerms: ['English'] }, { value: 'ko', label: '韓国語', disabled: true, searchTerms: ['Korean'] }],
    },
  });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
      parent.remove();
    },
  };
}

describe('searchable settings select', () => {
  it.each(['日', '日本', 'ja', 'j', 'jap', ' ＪＡ '])('finds Japanese through display name, code or generated English name: %s', async query => {
    using f = fixture();
    await f.wrapper.get('button').trigger('click');
    const input = document.querySelector<HTMLInputElement>('[data-testid="settings-select-search"]')!;
    expect(document.activeElement).toBe(input);
    input.value = query;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    const entries = document.querySelectorAll('[role="option"]');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.textContent).toBe('日本語');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(f.wrapper.emitted('update:modelValue')).toEqual([['ja']]);
    expect(document.activeElement).toBe(f.wrapper.get('button').element);
  });

  it('does not invent phonetic aliases, emit unsupported values, or intercept composition confirmation', async () => {
    using f = fixture();
    await f.wrapper.get('button').trigger('click');
    const input = document.querySelector<HTMLInputElement>('[data-testid="settings-select-search"]')!;
    input.value = 'にほん';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(document.querySelector('[role="status"]')?.textContent).toBe('No matching languages');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(f.wrapper.emitted('update:modelValue')).toBeUndefined();
    input.value = 'ja';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    const composing = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    input.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    expect(f.wrapper.emitted('update:modelValue')).toBeUndefined();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flushPromises();
    await f.wrapper.get('button').trigger('click');
    expect(input.value).toBe('');
  });
});
