// @vitest-environment happy-dom
import { effectScope, ref, type EffectScope, type Ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettings } from '@/composables/useSettings';
import { hostModelHandles, type HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { useHostModelDirectories } from './use-host-model-directories';

vi.mock('@/composables/useSettings', () => ({ useSettings: vi.fn() }));
vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const id = toHostModelDirectoryId({ raw: 'existing' });
const otherId = toHostModelDirectoryId({ raw: 'other' });
let settings: Ref<Settings>, scope: EffectScope;
let update: ReturnType<typeof vi.fn<ReturnType<typeof useSettings>['updateExperimental']>>;
const handles = new Map<string, HostModelDirectoryHandle>();
const picker = vi.fn();
const failed = vi.fn(), changed = vi.fn(), stopDownload = vi.fn();
function handle({ name }: { name: string }): HostModelDirectoryHandle {
  const result = { kind: 'directory', name, getDirectoryHandle: vi.fn(),
    queryPermission: vi.fn(async () => 'granted'), requestPermission: vi.fn(async () => 'granted'),
    isSameEntry: vi.fn(async (entry: unknown) => entry === result),
  };
  return result as unknown as HostModelDirectoryHandle;
}
beforeEach(() => {
  settings = ref<Settings>({ ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'openai', url: '' },
    experimental: { locale: 'ja', hostModelDirectories: [{ id, name: 'models' }] } });
  update = vi.fn(async ({ updater }) => {
    settings.value = { ...settings.value, experimental: updater({ experimental: settings.value.experimental }) };
  });
  vi.mocked(useSettings).mockReturnValue({ settings, updateExperimental: update } as unknown as ReturnType<typeof useSettings>);
  handles.clear(); handles.set('existing', handle({ name: 'models' }));
  vi.mocked(hostModelHandles.get).mockReset().mockImplementation(async ({ id }) => handles.get(String(id)));
  vi.mocked(hostModelHandles.put).mockReset().mockImplementation(async ({ id, handle }) => {
    handles.set(String(id), handle as HostModelDirectoryHandle);
  });
  vi.mocked(hostModelHandles.delete).mockReset().mockImplementation(async ({ id }) => {
    handles.delete(String(id));
  });
  picker.mockReset(); failed.mockReset(); changed.mockReset().mockResolvedValue(undefined); stopDownload.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('indexedDB', {});
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, run: () => Promise<void>) => run() } });
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: picker });
  scope = effectScope();
});
afterEach(() => {
  scope.stop(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, 'showDirectoryPicker');
});
function create() {
  return scope.run(() => useHostModelDirectories({ blocked: () => false, stopDownload, changed, failed }))!;
}

describe('linked model directory registration', () => {
  it('defaults to OPFS, reads permission without prompting and keeps restored missing handles registered', async () => {
    handles.clear();
    const state = create(); await state.refresh();
    expect(state.view.destination.value).toBe('opfs');
    expect(state.view.entries.value).toEqual([{ id: 'existing', name: 'models', access: 'missing', error: undefined }]);
    expect(settings.value.experimental?.hostModelDirectories).toEqual([{ id, name: 'models' }]);
    expect(update).not.toHaveBeenCalled(); expect(picker).not.toHaveBeenCalled();
  });

  it('reconnects a restored registration with the same ID', async () => {
    handles.clear(); const replacement = handle({ name: 'restored-models' }); picker.mockResolvedValue(replacement);
    const state = create(); await state.refresh(); await state.view.reconnect({ id: 'existing' });
    expect(picker).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(hostModelHandles.put).toHaveBeenCalledWith({ id, handle: replacement });
    expect(settings.value.experimental?.hostModelDirectories).toEqual([{ id, name: 'restored-models' }]);
    expect(settings.value.experimental?.locale).toBe('ja');
  });

  it('removes a newly saved handle when registering its metadata fails', async () => {
    picker.mockResolvedValue(handle({ name: 'new-models' }));
    update.mockRejectedValueOnce(new Error('Settings save failed'));
    const state = create(); await state.view.add();
    expect(handles.size).toBe(1); expect(handles.has('existing')).toBe(true);
    expect(settings.value.experimental?.hostModelDirectories).toEqual([{ id, name: 'models' }]);
    expect(failed).toHaveBeenCalledWith({ error: expect.objectContaining({ message: 'Settings save failed' }) });
  });

  it('awaits its active writer before removing metadata and handle registration', async () => {
    const pending = Promise.withResolvers<void>(); stopDownload.mockReturnValue(pending.promise);
    const state = create();
    const removal = state.view.remove({ id: 'existing' });
    expect(stopDownload).toHaveBeenCalledWith({ id: 'existing' });
    expect(update).not.toHaveBeenCalled(); expect(hostModelHandles.delete).not.toHaveBeenCalled();
    pending.resolve(); await removal;
    expect(settings.value.experimental?.hostModelDirectories).toEqual([]);
    expect(handles.has('existing')).toBe(false);
  });

  it('restores the removed registration after IDB failure without replacing concurrently added roots', async () => {
    vi.mocked(hostModelHandles.delete).mockImplementationOnce(async () => {
      settings.value.experimental = { ...settings.value.experimental, hostModelDirectories: [{ id: otherId, name: 'other-models' }] };
      throw new Error('IDB unavailable');
    });
    const state = create(); await state.view.remove({ id: 'existing' });
    expect(settings.value.experimental?.hostModelDirectories).toEqual([{ id: otherId, name: 'other-models' }, { id, name: 'models' }]);
    expect(settings.value.experimental?.locale).toBe('ja');
    expect(handles.has('existing')).toBe(true);
    expect(failed).toHaveBeenCalled();
  });

  it('requests write permission only on explicit download and keeps destination out of settings', async () => {
    const root = handles.get('existing')!;
    vi.mocked(root.queryPermission).mockImplementation(async ({ mode }) => mode === 'read' ? 'granted' : 'prompt');
    const state = create(); await state.refresh();
    expect(state.view.entries.value[0]?.access).toBe('read');
    expect(root.requestPermission).not.toHaveBeenCalled();
    state.view.selectDestination({ id: 'existing' });
    expect(await state.downloadDestination()).toEqual({ kind: 'host', directoryId: 'existing' });
    expect(root.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps unsupported registrations visible without using IDB or a picker', async () => {
    Reflect.deleteProperty(window, 'showDirectoryPicker');
    const state = create(); await state.refresh(); await state.view.add();
    expect(state.view.supported.value).toBe(false);
    expect(state.view.entries.value[0]?.access).toBe('unsupported');
    expect(hostModelHandles.get).not.toHaveBeenCalled(); expect(picker).not.toHaveBeenCalled();
  });
  it('never falls back to OPFS when permission for the explicitly selected host root is denied', async () => {
    const root = handles.get('existing')!;
    vi.mocked(root.requestPermission).mockResolvedValue('denied');
    const state = create(); await state.refresh(); state.view.selectDestination({ id: 'existing' });
    await expect(state.downloadDestination()).rejects.toThrow('read and write permission');
    expect(state.view.destination.value).toBe('existing');
    expect(update).not.toHaveBeenCalled();
  });
});
