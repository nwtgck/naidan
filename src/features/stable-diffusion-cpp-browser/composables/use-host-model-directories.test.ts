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
let storageRevision: number;
let update: ReturnType<typeof vi.fn<ReturnType<typeof useSettings>['updateExperimental']>>;
const handles = new Map<string, HostModelDirectoryHandle>();
const picker = vi.fn();
const failed = vi.fn(), changed = vi.fn(), stopDownload = vi.fn(), added = vi.fn();

function handle({ name }: { name: string }): HostModelDirectoryHandle {
  const result = {
    kind: 'directory',
    name,
    getDirectoryHandle: vi.fn(),
    queryPermission: vi.fn(async () => 'granted'),
    requestPermission: vi.fn(async () => 'granted'),
    isSameEntry: vi.fn(async (entry: unknown) => entry === result),
  };
  return result as unknown as HostModelDirectoryHandle;
}

beforeEach(() => {
  storageRevision = 0;
  settings = ref<Settings>({
    ...DEFAULT_SETTINGS,
    storageType: 'local',
    endpoint: { type: 'openai', url: '' },
    experimental: { locale: 'ja', hostModelDirectories: [{ id, name: 'models' }] },
  });
  update = vi.fn(async ({ updater }) => {
    settings.value = { ...settings.value, experimental: updater({ experimental: settings.value.experimental }) };
  });
  vi.mocked(useSettings).mockReturnValue({
    settings,
    updateExperimental: update,
    captureExperimentalStorage() {
      const revision = storageRevision;
      return () => storageRevision === revision;
    },
  } as unknown as ReturnType<typeof useSettings>);
  handles.clear();
  handles.set('existing', handle({ name: 'models' }));
  vi.mocked(hostModelHandles.get).mockReset().mockImplementation(async ({ id }) => handles.get(String(id)));
  vi.mocked(hostModelHandles.put).mockReset().mockImplementation(async ({ id, handle }) => {
    handles.set(String(id), handle as HostModelDirectoryHandle);
  });
  vi.mocked(hostModelHandles.delete).mockReset().mockImplementation(async ({ id }) => {
    handles.delete(String(id));
  });
  picker.mockReset();
  failed.mockReset();
  changed.mockReset().mockResolvedValue(undefined);
  added.mockReset().mockResolvedValue(undefined);
  stopDownload.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('indexedDB', {});
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, run: () => Promise<void>) => run() } });
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: picker });
  scope = effectScope();
});

afterEach(() => {
  scope.stop();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'showDirectoryPicker');
});

function create() {
  return scope.run(() => useHostModelDirectories({ blocked: () => false, stopDownload, added, changed, failed }))!;
}

describe('linked model directory registration', () => {
  it.each(['opfs', 'existing'])('selects a newly linked root after refreshing its handle when the previous destination is %s', async previous => {
    const root = handle({ name: 'new-models' });
    picker.mockResolvedValue(root);
    const state = create();
    state.view.selectDestination({ id: previous });
    added.mockImplementation(async ({ id }: { id: string }) => {
      expect(state.view.destination.value).toBe(id);
      expect(state.currentHandle({ id })).toBe(root);
      expect(state.view.busy.value).toBe(true);
      expect(changed).not.toHaveBeenCalled();
    });
    await state.view.add();
    const registration = state.registrations().find(entry => entry.name === root.name)!;
    expect(registration.id).not.toBe('existing');
    expect(state.view.destination.value).toBe(registration.id);
    expect(added).toHaveBeenCalledExactlyOnceWith({ id: registration.id });
    expect(changed).toHaveBeenCalledOnce();
    expect(state.view.busy.value).toBe(false);
  });

  it.each(['cancelled', 'denied', 'duplicate', 'handle-save', 'metadata-save'])('keeps the selected root when linking is %s', async outcome => {
    const root = handle({ name: 'new-models' });
    picker.mockResolvedValue(root);
    switch (outcome) {
    case 'cancelled': picker.mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
      break;
    case 'denied': vi.mocked(root.queryPermission).mockResolvedValue('denied');
      break;
    case 'duplicate': picker.mockResolvedValue(handles.get('existing'));
      break;
    case 'handle-save': vi.mocked(hostModelHandles.put).mockRejectedValueOnce(new Error('Handle save failed'));
      break;
    case 'metadata-save': update.mockRejectedValueOnce(new Error('Settings save failed'));
      break;
    }
    const state = create();
    state.view.selectDestination({ id: 'existing' });
    await state.view.add();
    expect(state.view.destination.value).toBe('existing');
    expect(added).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(state.registrations()).toEqual([{ id: 'existing', name: 'models' }]);
    expect(handles.size).toBe(1);
    expect(failed).toHaveBeenCalledTimes(outcome === 'cancelled' ? 0 : 1);
  });

  it('does not auto-select a picker result after its settings provider changes', async () => {
    const picked = Promise.withResolvers<HostModelDirectoryHandle>();
    picker.mockReturnValue(picked.promise);
    const state = create();
    state.view.selectDestination({ id: 'existing' });
    const adding = state.view.add();
    storageRevision++;
    picked.resolve(handle({ name: 'new-models' }));
    await adding;
    expect(state.registrations()).toHaveLength(2);
    expect(state.view.destination.value).toBe('existing');
    expect(added).not.toHaveBeenCalled();
  });

  it('caches the linked handle before a superseded refresh can finish the add operation', async () => {
    const root = handle({ name: 'new-models' });
    picker.mockResolvedValue(root);
    const staleEntered = Promise.withResolvers<void>(), stale = Promise.withResolvers<void>();
    const latestEntered = Promise.withResolvers<void>(), latest = Promise.withResolvers<void>();
    let reads = 0;
    vi.mocked(hostModelHandles.get).mockImplementation(async ({ id }) => {
      const stored = handles.get(String(id));
      if (stored === root) {
        reads++;
        if (reads === 1) {
          staleEntered.resolve();
          await stale.promise;
        } else {
          latestEntered.resolve();
          await latest.promise;
        }
      }
      return stored;
    });
    const state = create();
    const adding = state.view.add();
    await staleEntered.promise;
    const refreshing = state.refresh();
    await latestEntered.promise;
    stale.resolve();
    await adding;
    expect(state.view.busy.value).toBe(false);
    expect(state.currentHandle({ id: state.view.destination.value })).toBe(root);
    expect(await state.downloadDestination({ id: state.view.destination.value })).toEqual({ kind: 'host', directoryId: state.view.destination.value });
    latest.resolve();
    await refreshing;
    expect(state.currentHandle({ id: state.view.destination.value })).toBe(root);
  });

  it('does not select a new root unlinked by another selector before the add refresh finishes', async () => {
    const root = handle({ name: 'new-models' });
    picker.mockResolvedValue(root);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let waiting = false;
    vi.mocked(hostModelHandles.get).mockImplementation(async ({ id }) => {
      const stored = handles.get(String(id));
      if (stored === root && !waiting) {
        waiting = true;
        entered.resolve();
        await release.promise;
      }
      return stored;
    });
    const state = create(), other = create();
    state.view.selectDestination({ id: 'existing' });
    const adding = state.view.add();
    await entered.promise;
    const registration = state.registrations().find(entry => entry.name === root.name)!;
    await other.view.remove({ id: registration.id });
    release.resolve();
    await adding;
    expect(state.registrations()).toEqual([{ id: 'existing', name: 'models' }]);
    expect(state.view.destination.value).toBe('existing');
    expect(added).not.toHaveBeenCalled();
  });

  it('defaults to OPFS, reads permission without prompting and keeps restored missing handles registered', async () => {
    handles.clear();
    const state = create();
    await state.refresh();
    expect(state.view.destination.value).toBe('opfs');
    expect(state.view.entries.value).toEqual([{ id: 'existing', name: 'models', access: 'missing', error: undefined }]);
    expect(settings.value.experimental?.hostModelDirectories).toEqual([{ id, name: 'models' }]);
    expect(update).not.toHaveBeenCalled();
    expect(picker).not.toHaveBeenCalled();
  });

  it('reconnects a restored registration with the same ID', async () => {
    handles.clear();
    const replacement = handle({ name: 'restored-models' });
    picker.mockResolvedValue(replacement);
    const state = create();
    await state.refresh();
    await state.view.reconnect({ id: 'existing' });
    expect(picker).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(hostModelHandles.put).toHaveBeenCalledWith({ id, handle: replacement });
    expect(settings.value.experimental?.hostModelDirectories).toEqual([{ id, name: 'restored-models' }]);
    expect(settings.value.experimental?.locale).toBe('ja');
    expect(state.view.destination.value).toBe('opfs');
    expect(added).not.toHaveBeenCalled();
  });

  it('keeps another selected root when reconnecting an existing handle', async () => {
    handles.set('other', handle({ name: 'other-models' }));
    settings.value.experimental!.hostModelDirectories!.push({ id: otherId, name: 'other-models' });
    const state = create();
    await state.refresh();
    state.view.selectDestination({ id: 'other' });
    await state.view.reconnect({ id: 'existing' });
    expect(state.view.destination.value).toBe('other');
    expect(added).not.toHaveBeenCalled();
    expect(handles.get('existing')!.requestPermission).toHaveBeenCalledOnce();
  });

  it('removes a newly saved handle when registering its metadata fails', async () => {
    picker.mockResolvedValue(handle({ name: 'new-models' }));
    update.mockRejectedValueOnce(new Error('Settings save failed'));
    const state = create();
    await state.view.add();
    expect(handles.size).toBe(1);
    expect(handles.has('existing')).toBe(true);
    expect(settings.value.experimental?.hostModelDirectories).toEqual([{ id, name: 'models' }]);
    expect(failed).toHaveBeenCalledWith({ error: expect.objectContaining({ message: 'Settings save failed' }) });
  });

  it('awaits its active writer before removing metadata and handle registration', async () => {
    const pending = Promise.withResolvers<void>();
    stopDownload.mockReturnValue(pending.promise);
    const state = create();
    const removal = state.view.remove({ id: 'existing' });
    expect(stopDownload).toHaveBeenCalledWith({ id: 'existing' });
    expect(update).not.toHaveBeenCalled();
    expect(hostModelHandles.delete).not.toHaveBeenCalled();
    pending.resolve();
    await removal;
    expect(settings.value.experimental?.hostModelDirectories).toEqual([]);
    expect(handles.has('existing')).toBe(false);
  });

  it('restores the removed registration after IDB failure without replacing concurrently added roots', async () => {
    vi.mocked(hostModelHandles.delete).mockImplementationOnce(async () => {
      settings.value.experimental = { ...settings.value.experimental, hostModelDirectories: [{ id: otherId, name: 'other-models' }] };
      throw new Error('IDB unavailable');
    });
    const state = create();
    await state.view.remove({ id: 'existing' });
    expect(settings.value.experimental?.hostModelDirectories).toEqual([{ id: otherId, name: 'other-models' }, { id, name: 'models' }]);
    expect(settings.value.experimental?.locale).toBe('ja');
    expect(handles.has('existing')).toBe(true);
    expect(failed).toHaveBeenCalled();
  });

  it('requests write permission only on explicit download and keeps destination out of settings', async () => {
    const root = handles.get('existing')!;
    vi.mocked(root.queryPermission).mockImplementation(async ({ mode }) => mode === 'read' ? 'granted' : 'prompt');
    const state = create();
    await state.refresh();
    expect(state.view.entries.value[0]?.access).toBe('read');
    expect(root.requestPermission).not.toHaveBeenCalled();
    state.view.selectDestination({ id: 'existing' });
    expect(await state.downloadDestination({ id: state.view.destination.value })).toEqual({ kind: 'host', directoryId: 'existing' });
    expect(root.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps unsupported registrations visible without using IDB or a picker', async () => {
    Reflect.deleteProperty(window, 'showDirectoryPicker');
    const state = create();
    await state.refresh();
    await state.view.add();
    expect(state.view.supported.value).toBe(false);
    expect(state.view.entries.value[0]?.access).toBe('unsupported');
    expect(hostModelHandles.get).not.toHaveBeenCalled();
    expect(picker).not.toHaveBeenCalled();
  });

  it('never falls back to OPFS when permission for the explicitly selected host root is denied', async () => {
    const root = handles.get('existing')!;
    vi.mocked(root.requestPermission).mockResolvedValue('denied');
    const state = create();
    await state.refresh();
    state.view.selectDestination({ id: 'existing' });
    await expect(state.downloadDestination({ id: state.view.destination.value })).rejects.toThrow('read and write permission');
    expect(state.view.destination.value).toBe('existing');
    expect(update).not.toHaveBeenCalled();
  });
});
