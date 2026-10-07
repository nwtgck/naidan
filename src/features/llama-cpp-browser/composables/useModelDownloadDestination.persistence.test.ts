// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { DEFAULT_BROWSER_IMAGE_GENERATION_SETTINGS, DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { storageService } from '@/00-storage/service';
import { LocalStorageProvider } from '@/00-storage/service/local-storage';
import { hostModelHandles, type HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import { useSettings } from '@/composables/useSettings';
import { useHostModelDirectories } from '@/composables/useHostModelDirectories';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { MemoryDirectory } from '@/features/stable-diffusion-cpp-browser/test-utils/storage';
import LlamaCppBrowserDownloadDestination from '@/features/llama-cpp-browser/components/LlamaCppBrowserDownloadDestination.vue';
import { createDownloadQueue } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { TEST_ONLY, useModelDownloadDestination } from './useModelDownloadDestination';

vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock('@/features/naidan-peer-rpc/runtime/feature', () => ({ configureRpcFeature: vi.fn(async () => {}) }));
vi.mock('@/utils/idle-task', () => ({ scheduleIdleTask: vi.fn(() => ({ cancel: vi.fn() })) }));
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ addErrorEvent: vi.fn(), addInfoEvent: vi.fn() }) }));

const wrappers: VueWrapper[] = [];
const handles = new Map<string, MemoryDirectory>();
const imageTarget = { kind: 'host' as const, directoryId: toHostModelDirectoryId({ raw: 'image-root' }) };
const base: Settings = {
  ...DEFAULT_SETTINGS,
  endpoint: { type: 'openai', url: '' },
  storageType: 'local',
  systemPrompt: 'Keep unrelated settings',
  experimental: {
    browserImageGeneration: { ...DEFAULT_BROWSER_IMAGE_GENERATION_SETTINGS, modelDownloadDestination: imageTarget },
    hostModelDirectories: [
      { id: toHostModelDirectoryId({ raw: 'root-a' }), name: 'Models A' },
      { id: toHostModelDirectoryId({ raw: 'root-b' }), name: 'Models B' },
    ],
  },
};
function simulatedLocks() {
  const lanes = new Map<string, Promise<void>>();
  return {
    request: async (name: string, callback: () => Promise<unknown>) => {
      const previous = lanes.get(name) ?? Promise.resolve();
      const release = Promise.withResolvers<void>();
      const tail = previous.then(() => release.promise); lanes.set(name, tail);
      await previous;
      try {
        return await callback();
      } finally {
        release.resolve(); if (lanes.get(name) === tail) lanes.delete(name);
      }
    },
  };
}
function create() {
  let state: ReturnType<typeof useModelDownloadDestination> | undefined;
  const wrapper = mount(defineComponent({
    setup() {
      state = useModelDownloadDestination({ blocked: () => false, changed: () => {} });
      return () => h(LlamaCppBrowserDownloadDestination, { view: state!.view, disabled: false });
    },
  }));
  wrappers.push(wrapper); return { state: state!, wrapper };
}
function unmountAll(): void {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
}
async function reloadSettings(): Promise<void> {
  useSettings().TEST_ONLY.__testOnlyReset();
  await storageService.init({ type: 'local' });
  const loaded = await storageService.loadSettings();
  if (!loaded) throw new Error('Expected persisted settings');
  useSettings().TEST_ONLY.__testOnlySetSettings({ newSettings: loaded });
  await flushPromises();
}

beforeEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks(); localStorage.clear(); TEST_ONLY.reset();
  useSettings().TEST_ONLY.__testOnlyReset();
  vi.stubGlobal('indexedDB', {});
  Object.defineProperty(navigator, 'locks', { configurable: true, value: simulatedLocks() });
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: vi.fn() });
  handles.clear(); handles.set('root-a', new MemoryDirectory('Models A')); handles.set('root-b', new MemoryDirectory('Models B'));
  vi.mocked(hostModelHandles.get).mockImplementation(async ({ id }) => handles.get(String(id)) as unknown as HostModelDirectoryHandle | undefined);
  vi.mocked(hostModelHandles.delete).mockImplementation(async ({ id }) => {
    handles.delete(String(id));
  });
  await storageService.init({ type: 'local' });
  await storageService.updateSettings({ updater: () => structuredClone(base) });
  await reloadSettings(); await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(async () => {
  unmountAll(); await flushPromises(); TEST_ONLY.reset(); useSettings().TEST_ONLY.__testOnlyReset();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, 'showDirectoryPicker');
});

describe('persisted shared LM download destination', () => {
  it('defaults to OPFS without a write and restores both selectors after real provider recreation', async () => {
    const first = create(), second = create(); await flushPromises();
    expect(first.state.destination.value).toEqual({ kind: 'opfs' });
    expect((await storageService.loadSettings())?.experimental?.llamaCppBrowser).toBeUndefined();
    await first.wrapper.get('[data-testid="llama-download-destination"]').setValue('host:root-a'); await flushPromises();
    expect(second.wrapper.get<HTMLSelectElement>('[data-testid="llama-download-destination"]').element.value).toBe('host:root-a');
    expect((await storageService.loadSettings())?.experimental?.llamaCppBrowser?.modelDownloadDestination).toEqual({ kind: 'host', directoryId: 'root-a' });
    expect((await storageService.loadSettings())?.experimental?.browserImageGeneration?.modelDownloadDestination).toEqual(imageTarget);
    unmountAll(); TEST_ONLY.reset(); await reloadSettings();
    const restored = create(), other = create(); await flushPromises();
    expect(restored.state.destination.value).toEqual({ kind: 'host', directoryId: 'root-a' });
    expect(other.state.view.destination.value).toBe('root-a');
    await other.state.view.selectDestination({ id: 'opfs' });
    unmountAll(); TEST_ONLY.reset(); await reloadSettings();
    expect(create().state.destination.value).toEqual({ kind: 'opfs' });
  });

  it('shares the latest selector intent while serializing competing settings writes', async () => {
    const first = create(), second = create(); await flushPromises();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const save = LocalStorageProvider.prototype.saveSettings;
    vi.spyOn(LocalStorageProvider.prototype, 'saveSettings').mockImplementationOnce(async function(this: LocalStorageProvider, input) {
      entered.resolve(); await release.promise; return save.call(this, input);
    });
    const a = first.state.view.selectDestination({ id: 'root-a' }); await entered.promise;
    const b = second.state.view.selectDestination({ id: 'root-b' });
    const unrelated = useSettings().updateExperimental({ updater: ({ experimental }) => ({ ...experimental, locale: 'ja' }) });
    expect(first.state.destination.value).toEqual({ kind: 'host', directoryId: 'root-b' });
    expect(second.state.view.destination.value).toBe('root-b');
    expect(first.state.unavailable.value).toBe(true);
    release.resolve(); await Promise.all([a, b, unrelated]); await flushPromises();
    expect(first.state.destination.value).toEqual({ kind: 'host', directoryId: 'root-b' });
    expect(first.state.unavailable.value).toBe(false);
    const stored = await storageService.loadSettings();
    expect(stored?.experimental?.llamaCppBrowser?.modelDownloadDestination).toEqual({ kind: 'host', directoryId: 'root-b' });
    expect(stored?.experimental?.locale).toBe('ja');
    expect(stored?.experimental?.browserImageGeneration?.modelDownloadDestination).toEqual(imageTarget);
    expect(stored?.systemPrompt).toBe(base.systemPrompt);
  });

  it('finishes an accepted selection after unmount while new selectors observe the pending intent', async () => {
    const first = create(); await flushPromises();
    const release = Promise.withResolvers<void>();
    const update = storageService.updateSettingsForStorage.bind(storageService);
    vi.spyOn(storageService, 'updateSettingsForStorage').mockImplementationOnce(async input => {
      await release.promise; return update(input);
    });
    const pending = first.state.view.selectDestination({ id: 'root-a' });
    unmountAll();
    const reopened = create(); await flushPromises();
    expect(reopened.state.view.destination.value).toBe('root-a');
    expect(reopened.state.unavailable.value).toBe(true);
    release.resolve(); await pending; await flushPromises();
    expect(reopened.state.unavailable.value).toBe(false);
    expect((await storageService.loadSettings())?.experimental?.llamaCppBrowser?.modelDownloadDestination).toEqual({ kind: 'host', directoryId: 'root-a' });
  });

  it('does not apply a queued intent to a replacement settings provider', async () => {
    const first = create(); await flushPromises();
    const release = Promise.withResolvers<void>();
    const update = storageService.updateSettingsForStorage.bind(storageService);
    vi.spyOn(storageService, 'updateSettingsForStorage').mockImplementationOnce(async input => {
      await release.promise; return update(input);
    });
    const pending = first.state.view.selectDestination({ id: 'root-a' });
    await storageService.init({ type: 'memory' });
    await storageService.updateSettings({ updater: () => ({ ...structuredClone(base), storageType: 'memory' }) });
    await flushPromises();
    release.resolve(); await pending; await flushPromises();
    expect(first.state.destination.value).toEqual({ kind: 'opfs' });
    expect((await storageService.loadSettings())?.experimental?.llamaCppBrowser).toBeUndefined();
    expect(first.state.failure.value).toBe(false);
  });

  it('keeps a failed requested folder visible and unavailable until an explicit retry succeeds', async () => {
    const first = create(), second = create(); await flushPromises();
    vi.spyOn(LocalStorageProvider.prototype, 'saveSettings').mockRejectedValueOnce(new Error('Quota exceeded'));
    await first.state.view.selectDestination({ id: 'root-a' });
    expect(first.state.failure.value).toBe(true);
    expect(second.state.view.destination.value).toBe('root-a');
    expect(second.state.unavailable.value).toBe(true);
    expect((await storageService.loadSettings())?.experimental?.llamaCppBrowser).toBeUndefined();
    await second.state.view.selectDestination({ id: 'root-a' });
    expect(first.state.failure.value).toBe(false); expect(first.state.unavailable.value).toBe(false);
    expect((await storageService.loadSettings())?.experimental?.llamaCppBrowser?.modelDownloadDestination).toEqual({ kind: 'host', directoryId: 'root-a' });
  });

  it('retains a saved folder after registration removal and reload without an OPFS fallback', async () => {
    const first = create(); await flushPromises(); await first.state.view.selectDestination({ id: 'root-a' });
    await first.state.view.remove({ id: 'root-a' });
    expect(first.state.view.destination.value).toBe('root-a'); expect(first.state.unavailable.value).toBe(true);
    unmountAll(); TEST_ONLY.reset(); await reloadSettings();
    const restored = create(); await flushPromises();
    expect(restored.wrapper.get('[data-testid="llama-missing-download-destination"]').text()).toContain('root-a');
    await expect(restored.state.authorize({ destination: restored.state.destination.value })).rejects.toThrow('Reconnect');
    expect(restored.state.destination.value).toEqual({ kind: 'host', directoryId: 'root-a' });
  });

  it('retains denied folder access and an unsupported environment without changing persisted selection', async () => {
    const first = create(); await flushPromises(); await first.state.view.selectDestination({ id: 'root-a' });
    const folder = handles.get('root-a')!;
    vi.spyOn(folder, 'queryPermission').mockResolvedValue('denied');
    vi.spyOn(folder, 'requestPermission').mockResolvedValue('denied');
    window.dispatchEvent(new Event('focus')); await flushPromises();
    await expect(first.state.authorize({ destination: first.state.destination.value })).rejects.toThrow('permission');
    unmountAll(); TEST_ONLY.reset(); await reloadSettings(); Reflect.deleteProperty(window, 'showDirectoryPicker');
    const restored = create(); await flushPromises();
    expect(restored.state.view.destination.value).toBe('root-a'); expect(restored.state.unavailable.value).toBe(true);
    expect(restored.wrapper.get<HTMLOptionElement>('option[value="host:root-a"]').element.disabled).toBe(true);
    expect((await storageService.loadSettings())?.experimental?.llamaCppBrowser?.modelDownloadDestination).toEqual({ kind: 'host', directoryId: 'root-a' });
  });

  it('keeps a persisted host ID named opfs distinct in the selector and authorized download job', async () => {
    const root = new MemoryDirectory('Reserved host folder'); handles.set('opfs', root);
    const prefixed = new MemoryDirectory('Prefixed host folder'); handles.set('host:opfs', prefixed);
    await useSettings().updateExperimental({
      updater: ({ experimental }) => ({
        ...experimental,
        hostModelDirectories: [...experimental?.hostModelDirectories ?? [], { id: toHostModelDirectoryId({ raw: 'opfs' }), name: root.name }, { id: toHostModelDirectoryId({ raw: 'host:opfs' }), name: prefixed.name }],
        llamaCppBrowser: { modelDownloadDestination: { kind: 'host', directoryId: toHostModelDirectoryId({ raw: 'opfs' }) } },
      }),
    });
    await reloadSettings(); const first = create(), second = create(); await flushPromises();
    const selector = first.wrapper.get<HTMLSelectElement>('[data-testid="llama-download-destination"]');
    expect(selector.element.value).toBe('host:opfs');
    expect(selector.element.selectedOptions[0]?.textContent).toContain(root.name);
    expect(first.state.destination.value).toEqual({ kind: 'host', directoryId: 'opfs' });
    const authorized = await first.state.authorize({ destination: first.state.destination.value });
    expect(authorized).toEqual({ destination: { kind: 'host', directoryId: 'opfs' }, expectedRoot: root });
    const download = vi.fn(async () => {});
    const queue = createDownloadQueue({ download });
    const queued = queue.enqueue({
      key: 'reserved-host',
      repository: 'owner/repo',
      source: 'repository',
      ...authorized,
      prepare: async () => ({ repository: 'owner/repo', revision: 'a'.repeat(40), files: [{ path: 'model.gguf', size: 128 }] }),
    });
    expect((await queued.done).status).toBe('complete');
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ destination: { kind: 'host', directoryId: 'opfs' }, expectedRoot: root }));
    await selector.setValue('opfs'); await flushPromises();
    expect(second.state.destination.value).toEqual({ kind: 'opfs' });
    expect(await second.state.authorize({ destination: second.state.destination.value })).toEqual({ destination: { kind: 'opfs' }, expectedRoot: undefined });
    await selector.setValue('host:host:opfs'); await flushPromises();
    expect(second.state.destination.value).toEqual({ kind: 'host', directoryId: 'host:opfs' });
    expect(await second.state.authorize({ destination: second.state.destination.value })).toEqual({ destination: { kind: 'host', directoryId: 'host:opfs' }, expectedRoot: prefixed });
    await selector.setValue('host:opfs'); await flushPromises();
    expect(second.state.destination.value).toEqual({ kind: 'host', directoryId: 'opfs' });
    expect((await storageService.loadSettings())?.experimental?.llamaCppBrowser?.modelDownloadDestination).toEqual({ kind: 'host', directoryId: 'opfs' });
    handles.delete('opfs'); window.dispatchEvent(new Event('focus')); await flushPromises();
    expect(selector.element.value).toBe('host:opfs');
    expect(first.state.unavailable.value).toBe(true);
    await expect(first.state.authorize({ destination: first.state.destination.value })).rejects.toThrow('Reconnect');
    await first.state.view.remove({ id: 'opfs' }); await flushPromises();
    expect(selector.element.value).toBe('host:opfs');
    expect(first.wrapper.get('[data-testid="llama-missing-download-destination"]').text()).toContain('opfs');
    expect(first.state.destination.value).toEqual({ kind: 'host', directoryId: 'opfs' });
  });

  it('does not share its selection with the image-generation directory chooser', async () => {
    const first = create(); let image: ReturnType<typeof useHostModelDirectories> | undefined;
    const wrapper = mount(defineComponent({
      setup() {
        image = useHostModelDirectories({ blocked: () => false, stopDownload: async () => {}, changed: async () => {}, failed: () => {} }); return () => undefined;
      },
    }));
    wrappers.push(wrapper); await flushPromises();
    await first.state.view.selectDestination({ id: 'root-a' });
    expect(image!.view.destination.value).toBe('opfs');
    image!.view.selectDestination({ id: 'root-b' });
    expect(first.state.view.destination.value).toBe('root-a');
    expect((await storageService.loadSettings())?.experimental?.browserImageGeneration?.modelDownloadDestination).toEqual(imageTarget);
  });
});
