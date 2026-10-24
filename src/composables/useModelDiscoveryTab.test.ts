import { beforeEach, expect, it, vi } from 'vitest';
import { shallowRef, type Ref } from 'vue';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { TEST_ONLY } from './useModelDiscoveryTab';
const mocks = vi.hoisted(() => ({ settings: undefined as Ref<Settings> | undefined, update: vi.fn(), current: true }));


function createView() {
  return TEST_ONLY.createPreference({ source: { settings: mocks.settings!, captureExperimentalStorage: () => () => mocks.current, updateExperimentalForStorage: mocks.update } });
}

beforeEach(() => {
  mocks.settings = shallowRef({ ...structuredClone(DEFAULT_SETTINGS), endpoint: { type: 'llama_cpp_browser' }, storageType: 'memory' });
  mocks.current = true;
  mocks.update.mockReset().mockImplementation(async ({ isCurrent, updater }: { isCurrent(): boolean, updater({ experimental }: { experimental: Settings['experimental'] }): Settings['experimental'] }) => {
    if (isCurrent()) {
mocks.settings!.value = { ...mocks.settings!.value, experimental: updater({ experimental: mocks.settings!.value.experimental }) };
    }
  });
});

it('defaults to candidates without saving or changing model settings', () => {
  const view = createView();
  expect(view.remembered.value).toBe('candidates');
  expect(mocks.update).not.toHaveBeenCalled();
});

it.each([{ tab: 'hugging-face', stored: 'hugging_face' }, { tab: 'local-files', stored: 'local_files' }] as const)('shares the remembered $tab tab and preserves all other experimental and inference settings', async ({ tab, stored }) => {
  mocks.settings!.value.experimental = { locale: 'ja', chatBrowserModelPickerTab: 'saved' };
  const before = { ...mocks.settings!.value };
  const view = createView();
  const other = createView();
  const saving = view.remember({ tab });
  expect(other.remembered.value).toBe(tab);
  await saving;
  expect(view.remembered.value).toBe(tab);
  expect(mocks.settings!.value).toEqual({ ...before, experimental: { locale: 'ja', chatBrowserModelPickerTab: 'saved', modelDiscoveryTab: stored } });
});

it('serializes rapid clicks while immediately showing the latest tab', async () => {
  const release = Promise.withResolvers<void>();
  const update = mocks.update.getMockImplementation()!;
  mocks.update.mockImplementationOnce(async args => {
    await release.promise;
    return update(args);
  });
  const view = createView();
  const first = view.remember({ tab: 'hugging-face' });
  const second = view.remember({ tab: 'candidates' });
  expect(view.remembered.value).toBe('candidates');
  release.resolve();
  await Promise.all([first, second]);
  expect(view.remembered.value).toBe('candidates');
  expect(mocks.settings!.value.experimental?.modelDiscoveryTab).toBe('candidates');
});

it('does not carry an optimistic tab to a different storage provider', async () => {
  const view = createView();
  const saving = view.remember({ tab: 'local-files' });
  mocks.current = false;
  await saving;
  expect(mocks.settings!.value.experimental?.modelDiscoveryTab).toBeUndefined();
  expect(view.remembered.value).toBe('candidates');
});
