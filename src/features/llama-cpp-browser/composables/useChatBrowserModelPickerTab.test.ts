import { beforeEach, expect, it, vi } from 'vitest';
import { shallowRef, type Ref } from 'vue';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { useChatBrowserModelPickerTab } from './useChatBrowserModelPickerTab';
const mocks = vi.hoisted(() => ({ settings: undefined as Ref<Settings> | undefined, update: vi.fn(), current: true }));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: mocks.settings, captureExperimentalStorage: () => () => mocks.current, updateExperimentalForStorage: mocks.update }) }));

beforeEach(() => {
  mocks.settings = shallowRef({ ...structuredClone(DEFAULT_SETTINGS), endpoint: { type: 'llama_cpp_browser' }, storageType: 'memory' });
  mocks.current = true;
  mocks.update.mockReset().mockImplementation(async ({ isCurrent, updater }: { isCurrent(): boolean, updater({ experimental }: { experimental: Settings['experimental'] }): Settings['experimental'] }) => {
    if (isCurrent()) {
mocks.settings!.value = { ...mocks.settings!.value, experimental: updater({ experimental: mocks.settings!.value.experimental }) };
    }
  });
});

it('defaults to files without saving or changing model settings', () => {
  const view = useChatBrowserModelPickerTab();
  expect(view.remembered.value).toBe('files');
  expect(mocks.update).not.toHaveBeenCalled();
});

it('shares the remembered tab and preserves all other experimental and inference settings', async () => {
  mocks.settings!.value.experimental = { locale: 'ja' };
  const before = { ...mocks.settings!.value };
  const view = useChatBrowserModelPickerTab();
  const other = useChatBrowserModelPickerTab();
  const saving = view.remember({ tab: 'saved' });
  expect(other.remembered.value).toBe('saved');
  await saving;
  expect(mocks.settings!.value).toEqual({ ...before, experimental: { locale: 'ja', chatBrowserModelPickerTab: 'saved' } });
});

it('serializes rapid clicks while immediately showing the latest tab', async () => {
  const release = Promise.withResolvers<void>();
  const update = mocks.update.getMockImplementation()!;
  mocks.update.mockImplementationOnce(async args => {
    await release.promise;
    return update(args);
  });
  const view = useChatBrowserModelPickerTab();
  const first = view.remember({ tab: 'hugging-face' });
  const second = view.remember({ tab: 'files' });
  expect(view.remembered.value).toBe('files');
  release.resolve();
  await Promise.all([first, second]);
  expect(view.remembered.value).toBe('files');
  expect(mocks.settings!.value.experimental?.chatBrowserModelPickerTab).toBe('files');
});

it('does not carry an optimistic tab to a different storage provider', async () => {
  const view = useChatBrowserModelPickerTab();
  const saving = view.remember({ tab: 'saved' });
  mocks.current = false;
  await saving;
  expect(mocks.settings!.value.experimental?.chatBrowserModelPickerTab).toBeUndefined();
  expect(view.remembered.value).toBe('files');
});
