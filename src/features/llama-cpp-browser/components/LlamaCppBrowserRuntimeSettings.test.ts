import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import type { useSettings } from '@/composables/useSettings';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { captureChatOptions } from '@/features/llama-cpp-browser/runtime/chat-options';
import LlamaCppBrowserRuntimeSettings from './LlamaCppBrowserRuntimeSettings.vue';

const host = vi.hoisted(() => ({
  update: vi.fn<ReturnType<typeof useSettings>['updateExperimentalForStorage']>(),
  capture: vi.fn<ReturnType<typeof useSettings>['captureExperimentalStorage']>(),
  setOptions: vi.fn(),
}));
const settings = ref<Settings>({ ...DEFAULT_SETTINGS, endpoint: { type: 'llama_cpp_browser' }, storageType: 'opfs' });
const initialized = ref(true);
vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({ settings, initialized, captureExperimentalStorage: host.capture, updateExperimentalForStorage: host.update }),
}));
vi.mock('@/00-storage/service', () => ({ storageService: { loadSettings: async () => settings.value } }));
vi.mock('@/features/llama-cpp-browser', () => ({
  llamaCppBrowserService: {
    getProfileState: () => ({ status: 'idle' }),
    getOptions: () => ({ profile: 'auto' }),
    subscribeProfiles: () => () => {},
    probeProfiles: async () => {},
    setOptions: host.setOptions,
  },
}));

function render({ disabled }: { disabled: boolean }) {
  const wrapper = mount(LlamaCppBrowserRuntimeSettings, { props: { disabled, releaseDisabled: false } });
  return { wrapper, [Symbol.dispose]: () => wrapper.unmount() };
}

beforeEach(async () => {
  vi.clearAllMocks();
  settings.value = {
    ...DEFAULT_SETTINGS,
    endpoint: { type: 'llama_cpp_browser' },
    storageType: 'opfs',
    experimental: { llamaCppBrowser: { modelDownloadDestination: { kind: 'opfs' } }, locale: 'ja' },
  };
  initialized.value = true;
  host.capture.mockReturnValue(() => true);
  host.update.mockImplementation(async ({ isCurrent, updater }) => {
    if (!isCurrent()) return 'changed';
    settings.value = { ...settings.value, experimental: updater({ experimental: settings.value.experimental }) };
    return 'saved';
  });
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('persisted chat context controls', () => {
  it('shows the default without writing an override when opened', () => {
    using view = render({ disabled: false });
    expect(view.wrapper.get<HTMLInputElement>('[data-testid="llama-cpp-browser-context-tokens"]').element.value).toBe('32768');
    expect(view.wrapper.text()).toContain('Applies to all llama.cpp chats from the next generation.');
    expect(host.update).not.toHaveBeenCalled();
  });

  it('loads the saved value, persists an edit, and applies it to the next accepted chat', async () => {
    settings.value.experimental!.llamaCppBrowser!.contextTokens = 65536;
    using view = render({ disabled: false });
    const input = view.wrapper.get<HTMLInputElement>('[data-testid="llama-cpp-browser-context-tokens"]');
    expect(input.element.value).toBe('65536');
    const accepted = await captureChatOptions({ options: { profile: 'auto' } });
    await input.setValue('131072');
    expect(host.update).not.toHaveBeenCalled();
    await view.wrapper.get('[data-testid="llama-cpp-browser-context-save"]').trigger('click');
    await flushPromises();
    expect(host.update).toHaveBeenCalledOnce();
    expect(settings.value.experimental).toMatchObject({
      locale: 'ja',
      llamaCppBrowser: { contextTokens: 131072, modelDownloadDestination: { kind: 'opfs' } },
    });
    expect(accepted.contextTokens).toBe(65536);
    expect(await captureChatOptions({ options: { profile: 'auto' } })).toEqual({ profile: 'auto', contextTokens: 131072 });
    expect(host.setOptions).not.toHaveBeenCalled();
  });

  it('resets directly from an unsaved edit without saving the draft first', async () => {
    settings.value.experimental!.llamaCppBrowser!.contextTokens = 65536;
    using view = render({ disabled: false });
    await view.wrapper.get('[data-testid="llama-cpp-browser-context-tokens"]').setValue('131072');
    await view.wrapper.get('[data-testid="llama-cpp-browser-context-reset"]').trigger('click');
    await flushPromises();
    expect(host.update).toHaveBeenCalledOnce();
    expect(settings.value.experimental?.llamaCppBrowser?.contextTokens).toBeUndefined();
    expect(settings.value.experimental?.llamaCppBrowser?.modelDownloadDestination).toEqual({ kind: 'opfs' });
    expect(view.wrapper.get<HTMLInputElement>('[data-testid="llama-cpp-browser-context-tokens"]').element.value).toBe('32768');
    expect(await captureChatOptions({ options: { profile: 'auto' } })).toEqual({ profile: 'auto' });
  });

  it.each(['', '0', '511', '65536.5', '1048577'])('rejects invalid input %j without changing the saved target', async value => {
    using view = render({ disabled: false });
    const input = view.wrapper.get('[data-testid="llama-cpp-browser-context-tokens"]');
    await input.setValue(value);
    const save = view.wrapper.get('[data-testid="llama-cpp-browser-context-save"]');
    expect(save.attributes('disabled')).toBeDefined();
    await save.trigger('click');
    expect(input.attributes('aria-invalid')).toBe('true');
    expect(view.wrapper.get('[data-testid="llama-cpp-browser-context-invalid"]').text()).toBe('Enter a whole number from 512 to 1048576.');
    expect(host.update).not.toHaveBeenCalled();
  });

  it.each(['512', '1048576'])('accepts the context size boundary %s', async value => {
    using view = render({ disabled: false });
    await view.wrapper.get('[data-testid="llama-cpp-browser-context-tokens"]').setValue(value);
    await view.wrapper.get('[data-testid="llama-cpp-browser-context-save"]').trigger('click');
    await flushPromises();
    expect(settings.value.experimental?.llamaCppBrowser?.contextTokens).toBe(Number(value));
    expect(view.wrapper.find('[data-testid="llama-cpp-browser-context-invalid"]').exists()).toBe(false);
  });

  it('reports a failed save and lets the user retry the same value', async () => {
    host.update.mockRejectedValueOnce(new Error('write failed'));
    using view = render({ disabled: false });
    const input = view.wrapper.get('[data-testid="llama-cpp-browser-context-tokens"]');
    await input.setValue('65536');
    const save = view.wrapper.get('[data-testid="llama-cpp-browser-context-save"]');
    await save.trigger('click');
    await flushPromises();
    expect(view.wrapper.get('[data-testid="llama-cpp-browser-context-save-failed"]').text()).toBe('Could not save the context size. Try again.');
    expect(settings.value.experimental?.llamaCppBrowser?.contextTokens).toBeUndefined();
    await save.trigger('click');
    await flushPromises();
    expect(settings.value.experimental?.llamaCppBrowser?.contextTokens).toBe(65536);
    expect(view.wrapper.find('[data-testid="llama-cpp-browser-context-save-failed"]').exists()).toBe(false);
  });

  it('blocks overlapping edits while a save is pending', async () => {
    const pending = Promise.withResolvers<'saved' | 'changed'>();
    host.update.mockReturnValueOnce(pending.promise);
    using view = render({ disabled: false });
    const input = view.wrapper.get('[data-testid="llama-cpp-browser-context-tokens"]');
    await input.setValue('65536');
    const save = view.wrapper.get('[data-testid="llama-cpp-browser-context-save"]');
    await save.trigger('click');
    expect(input.attributes('disabled')).toBeDefined();
    expect(view.wrapper.get('[data-testid="llama-cpp-browser-context-reset"]').attributes('disabled')).toBeDefined();
    await save.trigger('click');
    expect(host.update).toHaveBeenCalledOnce();
    pending.resolve('changed');
    await flushPromises();
    expect(input.attributes('disabled')).toBeUndefined();
  });

  it('does not redirect a queued write to a different storage provider', async () => {
    let current = true;
    const pending = Promise.withResolvers<void>();
    host.capture.mockReturnValue(() => current);
    host.update.mockImplementationOnce(async ({ isCurrent, updater }) => {
      await pending.promise;
      if (!isCurrent()) return 'changed';
      settings.value = { ...settings.value, experimental: updater({ experimental: settings.value.experimental }) };
      return 'saved';
    });
    using view = render({ disabled: false });
    const input = view.wrapper.get<HTMLInputElement>('[data-testid="llama-cpp-browser-context-tokens"]');
    await input.setValue('65536');
    await view.wrapper.get('[data-testid="llama-cpp-browser-context-save"]').trigger('click');
    current = false;
    settings.value = { ...DEFAULT_SETTINGS, endpoint: { type: 'llama_cpp_browser' }, storageType: 'local', experimental: { llamaCppBrowser: { contextTokens: 8192 } } };
    pending.resolve();
    await flushPromises();
    expect(settings.value.experimental?.llamaCppBrowser?.contextTokens).toBe(8192);
    expect(input.element.value).toBe('8192');
  });

  it('keeps the controls visible but disabled until settings initialize or while inference is busy', async () => {
    initialized.value = false;
    using view = render({ disabled: false });
    const input = view.wrapper.get('[data-testid="llama-cpp-browser-context-tokens"]');
    expect(input.attributes('disabled')).toBeDefined();
    initialized.value = true;
    await flushPromises();
    expect(input.attributes('disabled')).toBeUndefined();
    await view.wrapper.setProps({ disabled: true });
    expect(input.attributes('disabled')).toBeDefined();
    await view.wrapper.get('[data-testid="llama-cpp-browser-context-save"]').trigger('click');
    expect(host.update).not.toHaveBeenCalled();
  });
});
