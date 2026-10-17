import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import LlamaCppBrowserModelAction from './LlamaCppBrowserModelAction.vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';

const model = { id: 'local-model-id', name: 'Local model', size: 128, importedAt: 1 };
const wrappers: VueWrapper[] = [];

function render(): VueWrapper {
  const wrapper = mount(LlamaCppBrowserModelAction, {
    attachTo: document.body,
    props: {
      model,
      current: { endpoint: { type: 'openai', url: 'http://localhost:1234/v1' }, modelId: 'global-model' },
      disabled: false,
      defaultActionDisabled: false,
      creating: false,
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}

function option({ testId }: { testId: string }): DOMWrapper<HTMLButtonElement> {
  const element = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!element) {
    throw new Error(`Missing option: ${testId}`);
  }
  return new DOMWrapper(element);
}

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) {
    wrapper.unmount();
  }
  document.body.innerHTML = '';
});

describe('local model split action', () => {
  it('exposes only the active label and keeps the main button text-only while busy', async () => {
    const wrapper = render();
    const main = wrapper.get('[data-testid="llama-model-action-main"]');
    const labels = wrapper.get('[data-testid="llama-model-action-labels"]');
    const candidates = labels.findAll('span');
    expect(candidates).toHaveLength(3);
    expect(candidates.map(candidate => candidate.text())).toEqual(['Create chat group', 'Set as default', 'In use']);
    expect(candidates.map(candidate => candidate.attributes('aria-hidden'))).toEqual(['false', 'true', 'true']);
    expect(candidates.map(candidate => candidate.classes().includes('invisible'))).toEqual([false, true, true]);
    expect(main.find('svg').exists()).toBe(false);

    await wrapper.get('[data-testid="llama-model-action-options"]').trigger('click');
    await option({ testId: 'llama-model-action-set-default' }).trigger('click');
    expect(candidates.map(candidate => candidate.attributes('aria-hidden'))).toEqual(['true', 'false', 'true']);
    expect(candidates.map(candidate => candidate.classes().includes('invisible'))).toEqual([true, false, true]);
    await wrapper.setProps({ current: { endpoint: { type: 'llama_cpp_browser' }, modelId: model.name } });
    expect(candidates.map(candidate => candidate.attributes('aria-hidden'))).toEqual(['true', 'true', 'false']);
    expect(candidates.map(candidate => candidate.classes().includes('invisible'))).toEqual([true, true, false]);
    expect(main.attributes('aria-label')).toBe('In use');
    expect(main.find('svg').exists()).toBe(false);

    await wrapper.setProps({ creating: true });
    expect(main.find('svg').exists()).toBe(false);
    expect(main.attributes('aria-busy')).toBe('true');
    const options = wrapper.get('[data-testid="llama-model-action-options"]');
    expect(options.find('svg.animate-spin').exists()).toBe(true);
    expect(options.findAll('svg')).toHaveLength(1);
  });

  it('starts in create-chat-group mode and only executes the main button', async () => {
    const wrapper = render();
    expect(wrapper.get('[data-testid="llama-model-action-main"]').attributes('aria-label')).toBe('Create chat group');
    await wrapper.get('[data-testid="llama-model-action-options"]').trigger('click');
    expect(wrapper.emitted('createChatGroup')).toBeUndefined();
    await option({ testId: 'llama-model-action-set-default' }).trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-model-action-main"]').attributes('aria-label')).toBe('Set as default');
    expect(wrapper.emitted('selectDefault')).toBeUndefined();
    expect(wrapper.emitted('createChatGroup')).toBeUndefined();
    expect(document.querySelector('[data-testid="llama-model-action-menu"]')).toBeNull();
    expect(document.activeElement).toBe(wrapper.get('[data-testid="llama-model-action-main"]').element);
    await wrapper.get('[data-testid="llama-model-action-main"]').trigger('click');
    expect(wrapper.emitted('selectDefault')).toEqual([[model]]);
    await wrapper.get('[data-testid="llama-model-action-options"]').trigger('click');
    await option({ testId: 'llama-model-action-create-chat-group' }).trigger('click');
    await wrapper.get('[data-testid="llama-model-action-main"]').trigger('click');
    expect(wrapper.emitted('createChatGroup')).toEqual([[]]);
    expect(wrapper.emitted('selectDefault')).toHaveLength(1);
  });

  it('describes both actions separately from their names and lets description clicks change only the mode', async () => {
    const wrapper = render();
    await wrapper.get('[data-testid="llama-model-action-options"]').trigger('click');
    const createChatGroup = option({ testId: 'llama-model-action-create-chat-group' });
    const setDefault = option({ testId: 'llama-model-action-set-default' });
    const createLabel = document.getElementById(createChatGroup.attributes('aria-labelledby')!);
    const createDescription = document.getElementById(createChatGroup.attributes('aria-describedby')!);
    const defaultLabel = document.getElementById(setDefault.attributes('aria-labelledby')!);
    const defaultDescription = document.getElementById(setDefault.attributes('aria-describedby')!);
    expect(createLabel?.textContent).toBe('Create chat group');
    expect(createDescription?.textContent).toBe('Create one chat, close Settings, and open the chat.');
    expect(defaultLabel?.textContent).toBe('Set as default');
    expect(defaultDescription?.textContent).toBe('Set this model as the global default.');
    expect(createChatGroup.element.contains(createDescription)).toBe(true);
    expect(setDefault.element.contains(defaultDescription)).toBe(true);
    defaultDescription?.click();
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-model-action-main"]').attributes('aria-label')).toBe('Set as default');
    expect(wrapper.emitted('selectDefault')).toBeUndefined();
    expect(wrapper.emitted('createChatGroup')).toBeUndefined();
    await wrapper.get('[data-testid="llama-model-action-main"]').trigger('click');
    expect(wrapper.emitted('selectDefault')).toEqual([[model]]);
  });

  it('keeps the dropdown usable when the selected model is already the default', async () => {
    const wrapper = render();
    await wrapper.setProps({ current: { endpoint: { type: 'llama_cpp_browser' }, modelId: model.name } });
    await wrapper.get('[data-testid="llama-model-action-options"]').trigger('click');
    await option({ testId: 'llama-model-action-set-default' }).trigger('click');
    expect(wrapper.get('[data-testid="llama-model-action-main"]').attributes('aria-label')).toBe('In use');
    expect(wrapper.get('[data-testid="llama-model-action-main"]').element.matches(':disabled')).toBe(true);
    expect(wrapper.get('[data-testid="llama-model-action-options"]').element.matches(':disabled')).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('[data-testid="llama-model-action-options"]').element);
    await wrapper.get('[data-testid="llama-model-action-options"]').trigger('click');
    await option({ testId: 'llama-model-action-create-chat-group' }).trigger('click');
    expect(wrapper.get('[data-testid="llama-model-action-main"]').element.matches(':disabled')).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('[data-testid="llama-model-action-main"]').element);
  });

  it('supports arrow/Home/End navigation, Escape and focus restoration across the teleported menu', async () => {
    const wrapper = render();
    const trigger = wrapper.get('[data-testid="llama-model-action-options"]');
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    const first = option({ testId: 'llama-model-action-create-chat-group' });
    const last = option({ testId: 'llama-model-action-set-default' });
    expect(document.activeElement).toBe(first.element);
    await first.trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(last.element);
    await last.trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first.element);
    await first.trigger('keydown', { key: 'End' });
    expect(document.activeElement).toBe(last.element);
    await last.trigger('keydown', { key: 'Home' });
    expect(document.activeElement).toBe(first.element);
    await first.trigger('keydown', { key: 'Escape' });
    expect(document.querySelector('[data-testid="llama-model-action-menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger.element);
    await trigger.trigger('keydown', { key: 'ArrowUp' });
    expect(document.activeElement).toBe(option({ testId: 'llama-model-action-set-default' }).element);
    expect(wrapper.emitted('selectDefault')).toBeUndefined();
    expect(wrapper.emitted('createChatGroup')).toBeUndefined();
  });

  it.each([false, true])('closes on Tab and restores the row focus before native focus movement (shift=%s)', async shiftKey => {
    const wrapper = render();
    const trigger = wrapper.get('[data-testid="llama-model-action-options"]');
    await trigger.trigger('click');
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    option({ testId: 'llama-model-action-create-chat-group' }).element.dispatchEvent(event);
    await flushPromises();
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('[data-testid="llama-model-action-menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger.element);
  });

  it('uses the shared outside-click handling and closes without executing either action', async () => {
    const wrapper = render();
    await wrapper.get('[data-testid="llama-model-action-options"]').trigger('click');
    await new Promise(resolve => setTimeout(resolve, 0));
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await flushPromises();
    expect(document.querySelector('[data-testid="llama-model-action-menu"]')).toBeNull();
    expect(wrapper.emitted('selectDefault')).toBeUndefined();
    expect(wrapper.emitted('createChatGroup')).toBeUndefined();
  });

  it.each(['disabled', 'creating'])('disables both halves and closes an open menu (%s)', async property => {
    const wrapper = render();
    await wrapper.get('[data-testid="llama-model-action-options"]').trigger('click');
    await wrapper.setProps({ [property]: true });
    expect(wrapper.get('[data-testid="llama-model-action-main"]').element.matches(':disabled')).toBe(true);
    expect(wrapper.get('[data-testid="llama-model-action-options"]').element.matches(':disabled')).toBe(true);
    expect(document.querySelector('[data-testid="llama-model-action-menu"]')).toBeNull();
    await wrapper.get('[data-testid="llama-model-action-main"]').trigger('click');
    expect(wrapper.emitted('createChatGroup')).toBeUndefined();
  });

  it('skips an unavailable default option during keyboard navigation', async () => {
    const wrapper = render();
    await wrapper.setProps({ defaultActionDisabled: true });
    await wrapper.get('[data-testid="llama-model-action-options"]').trigger('keydown', { key: 'ArrowUp' });
    expect(document.activeElement).toBe(option({ testId: 'llama-model-action-create-chat-group' }).element);
    expect(option({ testId: 'llama-model-action-set-default' }).element.disabled).toBe(true);
  });
});
