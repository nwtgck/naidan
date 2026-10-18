import { describe, it, expect, afterEach } from 'vitest';
import { mount, enableAutoUnmount, flushPromises } from '@vue/test-utils';
import { nextTick, defineComponent } from 'vue';
import SettingsSelect from './SettingsSelect.vue';
import SettingsDisclosure from './SettingsDisclosure.vue';

enableAutoUnmount(afterEach);

afterEach(() => {
  document.body.innerHTML = '';
});

const options = [
  { value: 'inherit', label: 'llama.cpp browser', detail: 'local', source: { label: 'Global', description: 'Follows global changes' } },
  { value: 'llama_cpp_browser', label: 'llama.cpp browser', detail: 'local' },
  { value: 'disabled', label: 'Unavailable', disabled: true },
  { value: 'ollama', label: 'Ollama' },
];

describe.each(['default', 'compact'] as const)('SettingsSelect (%s)', size => {
  it('distinguishes inherited and explicit equal values without rewriting raw values', async () => {
    const wrapper = mount(SettingsSelect, { attachTo: document.body, props: { modelValue: 'inherit', options, label: 'Connection', size } });
    const trigger = wrapper.get('button');
    expect(trigger.attributes('aria-label')).toContain('Follows global changes');
    await trigger.trigger('click');
    const entries = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    expect(entries[0]?.getAttribute('aria-label')).toContain('Follows global changes');
    expect(entries[1]?.getAttribute('aria-label')).not.toContain('Follows');
    entries[1]?.click();
    expect(wrapper.emitted('update:modelValue')).toEqual([['llama_cpp_browser']]);
    await wrapper.setProps({ modelValue: 'llama_cpp_browser' });
    expect(trigger.attributes('aria-label')).not.toContain('Follows');
  });

  it('closes and returns focus without emitting when the current raw value is reselected', async () => {
    const wrapper = mount(SettingsSelect, { attachTo: document.body, props: { modelValue: 'inherit', options, label: 'Connection', size } });
    const trigger = wrapper.get('button');
    await trigger.trigger('click');
    const selected = document.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')!;
    selected.click();
    await nextTick();
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger.element);
  });

  it('skips disabled options and supports navigation, typeahead and nested Escape', async () => {
    const wrapper = mount(SettingsSelect, { attachTo: document.body, props: { modelValue: 'inherit', options, label: 'Connection', size } });
    await wrapper.get('button').trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(list.hasAttribute('inert')).toBe(false);
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    expect(document.activeElement?.textContent).toContain('Ollama');
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    expect(document.activeElement?.textContent).toContain('llama.cpp browser');
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', bubbles: true, cancelable: true }));
    expect(document.activeElement?.textContent).toContain('Ollama');
    const compositionEscape = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true });
    list.dispatchEvent(compositionEscape);
    expect(wrapper.get('button').attributes('aria-expanded')).toBe('true');
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    list.dispatchEvent(escape);
    await nextTick();
    expect(escape.defaultPrevented).toBe(true);
    expect(wrapper.get('button').attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(wrapper.get('button').element);
    expect(list.hasAttribute('inert')).toBe(true);
  });

  it('closes and blocks a teleported option when disabled during an open menu', async () => {
    const wrapper = mount(SettingsSelect, { attachTo: document.body, props: { modelValue: 'inherit', options, label: 'Connection', size } });
    await wrapper.get('button').trigger('click');
    const option = document.querySelector<HTMLButtonElement>('[role="option"]')!;
    await wrapper.setProps({ disabled: true });
    option.click();
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    const list = document.querySelector('[role="listbox"]');
    expect(list?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps children mounted but closes only their popup when the disclosure closes', async () => {
    const Host = defineComponent({ components: { SettingsDisclosure, SettingsSelect }, data: () => ({ options, size }), template: '<SettingsDisclosure title="Title"><SettingsSelect model-value="inherit" :options="options" label="Connection" :size="size" /><input data-testid="draft" value="preserved" /></SettingsDisclosure>' });
    const wrapper = mount(Host, { attachTo: document.body });
    const disclosure = wrapper.findComponent(SettingsDisclosure);
    await disclosure.get('button').trigger('click');
    const input = wrapper.get('[data-testid="draft"]').element;
    await wrapper.findComponent(SettingsSelect).get('button').trigger('click');
    await disclosure.get('button').trigger('click');
    await nextTick();
    expect(wrapper.findComponent(SettingsSelect).get('button').attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('[data-testid="draft"]').element).toBe(input);
    expect(document.activeElement).toBe(disclosure.get('button').element);
  });
});
