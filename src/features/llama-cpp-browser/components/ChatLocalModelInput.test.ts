import { flushPromises, mount } from '@vue/test-utils';
import { computed, shallowRef } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { ChatLocalModelOperation, ChatLocalModelUi } from '@/composables/chat/chat-scoped/useChatLocalModel';
import type { ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import ChatLocalModelInput from './ChatLocalModelInput.vue';
const preference = vi.hoisted(() => ({ tab: 'files' as 'files' | 'hugging-face' | 'saved', save: vi.fn(async () => {}) }));
vi.mock('../composables/useChatBrowserModelPickerTab', () => ({ useChatBrowserModelPickerTab: () => ({ remembered: computed(() => preference.tab), remember: preference.save }) }));

beforeEach(async () => {
  preference.tab = 'files';
  preference.save.mockClear();
  await ensureAllStringsForTest({ locale: 'en' });
});

function inputState() {
  const operation = shallowRef<ChatLocalModelOperation>();
  const accept = vi.fn(async ({ directories }: { directories: Promise<ModelDirectoryInput[]>, controller: AbortController }) => {
    await directories;
  });
  const state = {
    operation: computed(() => operation.value),
    downloadJob: computed(() => undefined),
    useModel: vi.fn(async () => {}),
    useRepositoryModel: vi.fn(async () => {}),
    pauseDownload: vi.fn(),
    maySend: computed(() => operation.value === undefined),
    accept,
    choose: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    TEST_ONLY: {},
  } satisfies ChatLocalModelUi;
  return { state, operation };
}

vi.mock('./LlamaCppBrowserRepositoryPicker.vue', () => ({ __esModule: true, default: { template: '<div data-testid="repository-source" />' } }));
vi.mock('./LlamaCppBrowserSavedModelPicker.vue', () => ({ __esModule: true, default: { template: '<div data-testid="saved-source" />' } }));

describe('chat local file entry', () => {
  it('offers explicit retry even when file checking failed before candidates were available', async () => {
    const { state, operation } = inputState();
    operation.value = { id: 1, phase: 'error', model: undefined, error: 'not-empty', downloadJobId: undefined, candidates: [] };
    const wrapper = mount(ChatLocalModelInput, { props: { state, expansion: 'open', availability: 'available' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    await wrapper.get('[data-testid="chat-local-model-retry"]').trigger('click');
    expect(state.retry).toHaveBeenCalledOnce();
    expect(state.accept).not.toHaveBeenCalled();
    expect(state.cancel).not.toHaveBeenCalled();
  });

  it('keeps the entry and its explanation visible when this environment cannot run models', async () => {
    const { state } = inputState();
    const wrapper = mount(ChatLocalModelInput, { props: { state, expansion: 'open', availability: 'unavailable' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(wrapper.get('[role="status"]').text()).toContain('unavailable');
    expect(wrapper.find('[data-testid="chat-open-local-model"]').exists()).toBe(true);
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-cpp-browser-choose-files"]').element.disabled).toBe(true);
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-cpp-browser-choose-directory"]').element.disabled).toBe(true);
    await wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', { dataTransfer: { types: ['Files'], files: [new File(['GGUF'], 'local.gguf')] } });
    expect(state.accept).not.toHaveBeenCalled();
  });

  it('opens without importing and keeps closed controls outside keyboard navigation', async () => {
    const { state } = inputState();
    const wrapper = mount(ChatLocalModelInput, { props: { state, expansion: 'closed', availability: 'available' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const trigger = wrapper.get('[data-testid="chat-open-local-model"]');
    const panel = wrapper.get(`#${trigger.attributes('aria-controls')}`);
    expect(panel.attributes('inert')).toBeDefined();
    expect(trigger.attributes('aria-expanded')).toBe('false');
    await trigger.trigger('click');
    expect(wrapper.emitted('update:expansion')).toEqual([['open']]);
    expect(state.accept).not.toHaveBeenCalled();
    await wrapper.setProps({ expansion: 'open' });
    expect(panel.attributes('inert')).toBeUndefined();
    expect(panel.attributes('aria-hidden')).toBe('false');
    expect(wrapper.text()).toContain('save');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('reserves the chat synchronously with a snapshot of selected files and permits choosing the same file again', async () => {
    const { state } = inputState();
    const wrapper = mount(ChatLocalModelInput, { props: { state, expansion: 'open', availability: 'available' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const input = wrapper.get<HTMLInputElement>('[data-testid="llama-cpp-browser-file"]').element;
    const model = new File(['GGUF'], 'Qwen-9B-Q4.gguf');
    Object.defineProperty(input, 'files', { configurable: true, value: [model] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(state.accept).toHaveBeenCalledOnce();
    expect(input.value).toBe('');
    Object.defineProperty(input, 'files', { configurable: true, value: [] });
    const call = state.accept.mock.calls[0]![0];
    expect(call.controller.signal.aborted).toBe(false);
    const directories = await call.directories;
    expect(directories).toHaveLength(1);
    expect(directories[0]!.files[0]!.file).toBe(model);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(state.accept).toHaveBeenCalledOnce();
    await flushPromises();
  });

  it('captures native entries during drop dispatch and prevents attachment bubbling', async () => {
    const { state } = inputState();
    const wrapper = mount(ChatLocalModelInput, { props: { state, expansion: 'open', availability: 'available' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    let dispatching = true;
    const file = new File(['GGUF'], 'local.gguf');
    const getEntry = vi.fn(() => {
      expect(dispatching).toBe(true);
      return { isFile: true, isDirectory: false, name: file.name, file: (resolve: (file: File) => void) => resolve(file) };
    });
    const parentDrop = vi.fn();
    wrapper.element.addEventListener('drop', parentDrop);
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [], items: [{ kind: 'file', webkitGetAsEntry: getEntry }] } });
    wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').element.dispatchEvent(event);
    dispatching = false;
    expect(getEntry).toHaveBeenCalledOnce();
    expect(state.accept).toHaveBeenCalledOnce();
    expect(parentDrop).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(wrapper.emitted('model-drop-area-active')).toBeTruthy();
    const directories = await state.accept.mock.calls[0]![0].directories;
    expect(directories[0]!.files[0]!.file).toBe(file);
    await flushPromises();
  });

  it('chooses an explicit candidate and keeps cancellation explicit while the input is active', async () => {
    const { state, operation } = inputState();
    operation.value = {
      id: 1,
      phase: 'choosing',
      model: undefined,
      error: undefined,
      downloadJobId: undefined,
      candidates: [{ modelId: 'temp/local/first.gguf', size: 10, importedAt: 1 }, { modelId: 'temp/local/second.gguf', size: 20, importedAt: 1 }],
    };
    const wrapper = mount(ChatLocalModelInput, { props: { state, expansion: 'open', availability: 'available' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-cpp-browser-choose-files"]').element.disabled).toBe(true);
    await wrapper.get('[data-testid="chat-local-model-candidates"]').findAll('button')[1]!.trigger('click');
    expect(state.choose).toHaveBeenCalledExactlyOnceWith({ modelId: 'temp/local/second.gguf' });
    await wrapper.get('[data-testid="chat-open-local-model"]').trigger('click');
    expect(state.cancel).not.toHaveBeenCalled();
    expect(wrapper.emitted('update:expansion')).toBeUndefined();
    await wrapper.get('[data-testid="chat-local-model-cancel"]').trigger('click');
    expect(state.cancel).toHaveBeenCalledOnce();
  });
});

it('keeps all sources inside the same viewport and moves focus with the selected tab', async () => {
  const { state } = inputState();
  const wrapper = mount(ChatLocalModelInput, { props: { state, expansion: 'open', availability: 'available' }, attachTo: document.body });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  const viewport = wrapper.get('[data-testid="chat-model-source-viewport"]').element;
  const files = wrapper.get('[data-testid="chat-model-tab-files"]');
  await files.trigger('keydown', { key: 'ArrowRight' });
  await flushPromises();
  const tab = wrapper.get('[data-testid="chat-model-tab-hugging-face"]');
  expect(document.activeElement).toBe(tab.element);
  expect(tab.attributes('aria-selected')).toBe('true');
  expect(preference.save).toHaveBeenLastCalledWith({ tab: 'hugging-face' });
  expect(wrapper.get('[data-testid="chat-model-source-viewport"]').element).toBe(viewport);
  expect(wrapper.get('[data-testid="chat-model-picker-label"]').text()).toContain('Hugging Face');
  expect(wrapper.get(`#${files.attributes('aria-controls')}`).attributes('inert')).toBeDefined();
  expect(wrapper.get(`#${tab.attributes('aria-controls')}`).attributes('inert')).toBeUndefined();
  await tab.trigger('keydown', { key: 'End' });
  await flushPromises();
  expect(wrapper.get('[data-testid="chat-model-tab-saved"]').attributes('aria-selected')).toBe('true');
  expect(wrapper.get('[data-testid="chat-model-source-viewport"]').element).toBe(viewport);
  expect(state.accept).not.toHaveBeenCalled();
  expect(state.useRepositoryModel).not.toHaveBeenCalled();
  expect(state.useModel).not.toHaveBeenCalled();
});

it('restores the last source label before opening without selecting a model', async () => {
  preference.tab = 'saved';
  const { state } = inputState();
  const wrapper = mount(ChatLocalModelInput, { props: { state, expansion: 'closed', availability: 'available' } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  expect(wrapper.get('[data-testid="chat-model-picker-label"]').text()).toContain('saved');
  await wrapper.setProps({ expansion: 'open' });
  expect(wrapper.get('[data-testid="chat-model-tab-saved"]').attributes('aria-selected')).toBe('true');
  expect(preference.save).not.toHaveBeenCalled();
  expect(state.useModel).not.toHaveBeenCalled();
});
