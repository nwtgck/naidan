import { computed, ref, shallowRef, type ComputedRef, type Ref } from 'vue';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { useSettings } from '@/composables/useSettings';
import { hostModelHandles, hostModelDirectoryHandleSchema, type HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import { idToRaw, toHostModelDirectoryId } from '@/01-models/ids';
import type { Settings } from '@/01-models/types';
import { missingHostModelDirectoryApis, hostModelDirectoryLock, hostModelPermissionGranted, unregisterHostModelDirectory } from '@/logic/host-model-directories';

export type HostModelDirectoryRegistration = { id: string, name: string };
export type HostModelDownloadDestination = { kind: 'opfs' } | { kind: 'host', directoryId: string };
export type HostModelDirectoryChoice = {
  id: string, name: string,
  access: 'readwrite' | 'read' | 'prompt' | 'missing' | 'error' | 'unsupported',
  error: string | undefined,
};
export type HostModelDirectoriesView = {
  supported: ComputedRef<boolean>, entries: ComputedRef<HostModelDirectoryChoice[]>, busy: Ref<boolean>,
  destination: Ref<string>,
  destinationKind?: ComputedRef<'opfs' | 'host'>,
  add(): Promise<void>,
  addDroppedDirectory?({ directory, signal }: { directory: FileSystemDirectoryHandle, signal: AbortSignal }): Promise<void>,
  reconnect({ id }: { id: string }): Promise<void>,
  remove({ id }: { id: string }): Promise<void>,
  selectDestination({ id, kind }: { id: string, kind?: 'opfs' | 'host' }): void,
};

const pickerSchema = z.custom<({ mode }: { mode: 'readwrite' }) => Promise<HostModelDirectoryHandle>>(value => typeof value === 'function');

export function useHostModelDirectories({ blocked, stopDownload, added, changed, failed, validateDirectory }: {
  blocked: () => boolean,
  validateDirectory?: ({ directory, signal }: { directory: FileSystemDirectoryHandle, signal: AbortSignal | undefined }) => Promise<void>,
  stopDownload: ({ id }: { id: string }) => Promise<void>,
  added: (({ id }: { id: string }) => Promise<void>) | undefined,
  changed: () => Promise<void>,
  failed: ({ error }: { error: unknown }) => void,
}): {
  view: HostModelDirectoriesView,
  registrations: () => HostModelDirectoryRegistration[],
  refresh: () => Promise<void>,
  currentHandle: ({ id }: { id: string }) => HostModelDirectoryHandle | undefined,
  downloadDestination: ({ id }: { id: string }) => Promise<HostModelDownloadDestination>,
  hostDownloadDestination: ({ id }: { id: string }) => Promise<Extract<HostModelDownloadDestination, { kind: 'host' }>>,
} {
  const { settings, updateExperimental, captureExperimentalStorage } = useSettings();
  const supported = computed(() => missingHostModelDirectoryApis().length === 0);
  const busy = ref(false), destination = ref('opfs');
  const observed = shallowRef(new Map<string, Pick<HostModelDirectoryChoice, 'access' | 'error'>>());
  const handles = new Map<string, HostModelDirectoryHandle>();
  function registrations(): HostModelDirectoryRegistration[] {
    return (settings.value.experimental?.hostModelDirectories ?? []).map(({ id, name }) => ({ id: idToRaw({ id }), name }));
  }
  const entries = computed(() => registrations().map(entry => ({
    ...entry,
    ...(supported.value ? observed.value.get(entry.id) ?? { access: 'prompt' as const, error: undefined } : { access: 'unsupported' as const, error: undefined }),
  })));
  let refreshVersion = 0;
  async function refresh(): Promise<void> {
    const version = ++refreshVersion;
    const next = new Map<string, Pick<HostModelDirectoryChoice, 'access' | 'error'>>();
    const nextHandles = new Map<string, HostModelDirectoryHandle>();
    if (!supported.value) {
      return;
    }
    for (const entry of registrations()) {
      try {
        const handle = await hostModelHandles.get({ id: toHostModelDirectoryId({ raw: entry.id }) });
        if (!handle) {
          next.set(entry.id, { access: 'missing', error: undefined });
          continue;
        }
        nextHandles.set(entry.id, handle);
        const write = hostModelPermissionGranted({ permission: await handle.queryPermission({ mode: 'readwrite' }) });
        const read = write || hostModelPermissionGranted({ permission: await handle.queryPermission({ mode: 'read' }) });
        next.set(entry.id, { access: write ? 'readwrite' : read ? 'read' : 'prompt', error: undefined });
      } catch (error) {
        next.set(entry.id, { access: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (version !== refreshVersion) {
      return;
    }
    handles.clear();
    for (const [id, handle] of nextHandles) {
      handles.set(id, handle);
    }
    observed.value = next;
    // A saved but currently unavailable root remains explicit. Refresh cannot
    // silently change where the next download will write.
  }
  async function perform({ operation, refreshed }: { operation: () => Promise<void>, refreshed: (() => Promise<void>) | undefined }): Promise<void> {
    if (!supported.value || blocked() || busy.value) {
      return;
    }
    busy.value = true;
    try {
      await operation();
      await refresh();
      await refreshed?.();
      await changed();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        failed({ error });
      }
    } finally {
      busy.value = false;
    }
  }
  async function pick({ existingId }: { existingId: string | undefined }): Promise<string> {
    // Keep the picker in the click gesture, before asynchronous storage access.
    const picker = pickerSchema.parse(Reflect.get(window, 'showDirectoryPicker'));
    const handle = await picker.call(window, { mode: 'readwrite' });
    if (!hostModelPermissionGranted({ permission: await handle.queryPermission({ mode: 'readwrite' }) })) {
      throw new Error('Model directory needs read and write permission');
    }
    return register({ handle, existingId, signal: undefined });
  }
  // Picker and drop registrations intentionally share deduplication, persistence,
  // rollback and identity. Only acquiring permission differs: a dropped folder
  // can be read-only; reconnect requests write access in a fresh click gesture.
  async function register({ handle, existingId, signal }: { handle: HostModelDirectoryHandle, existingId: string | undefined, signal: AbortSignal | undefined }): Promise<string> {
    await validateDirectory?.({ directory: handle, signal });
    signal?.throwIfAborted();
    for (const entry of registrations()) {
      if (entry.id === existingId) {
        continue;
      }
      const previous = await hostModelHandles.get({ id: toHostModelDirectoryId({ raw: entry.id }) });
      if (previous && await previous.isSameEntry(handle)) {
        throw new Error('This model directory is already registered');
      }
    }
    const id = toHostModelDirectoryId({ raw: existingId ?? nanoid() });
    await navigator.locks.request(hostModelDirectoryLock({ id }), async () => {
      signal?.throwIfAborted();
      const previous = await hostModelHandles.get({ id });
      signal?.throwIfAborted();
      await hostModelHandles.put({ id, handle });
      try {
        signal?.throwIfAborted();
        await updateExperimental({
          updater: ({ experimental }) => {
            const directories = experimental?.hostModelDirectories ?? [];
            if (existingId && !directories.some(entry => entry.id === id)) {
              throw new Error('Model directory registration was removed');
            }
            return {
              ...experimental,
              hostModelDirectories: existingId
                ? directories.map(entry => entry.id === id ? { id, name: handle.name } : entry)
                : [...directories, { id, name: handle.name }],
            };
          },
        });
      } catch (error) {
        // A failed settings save must preserve the previous usable registration.
        if (previous) {
          await hostModelHandles.put({ id, handle: previous });
        } else {
          await hostModelHandles.delete({ id });
        }
        throw error;
      }
    });
    // The accepted handle is ready even if a newer refresh supersedes the one
    // awaited by add(). Other mounted selectors refresh their own caches.
    handles.set(idToRaw({ id }), handle);
    return idToRaw({ id });
  }
  async function addSelected({ select }: { select: () => Promise<string> }): Promise<void> {
    let id: string | undefined, isCurrent: (() => boolean) | undefined;
    await perform({
      operation: async () => {
        isCurrent = captureExperimentalStorage();
        id = await select();
      },
      refreshed: async () => {
        if (id === undefined || !isCurrent?.() || !registrations().some(entry => entry.id === id)) {
          return;
        }
        destination.value = id;
        await added?.({ id });
      },
    });
  }
  async function reconnect({ id }: { id: string }): Promise<void> {
    await perform({
      operation: async () => {
        const handle = handles.get(id);
        if (handle) {
          if (!hostModelPermissionGranted({ permission: await handle.requestPermission({ mode: 'readwrite' }) })) {
            throw new Error('Model directory needs read and write permission');
          }
        } else {
          await pick({ existingId: id });
        }
      },
      refreshed: undefined,
    });
  }
  async function remove({ id: raw }: { id: string }): Promise<void> {
    await perform({
      operation: async () => {
        await stopDownload({ id: raw });
        const id = toHostModelDirectoryId({ raw });
        let removed: NonNullable<NonNullable<Settings['experimental']>['hostModelDirectories']>[number] | undefined;
        await unregisterHostModelDirectory({
          id,
          save: async () => {
            await updateExperimental({
              updater: ({ experimental }) => {
                const directories = experimental?.hostModelDirectories ?? [];
                removed = directories.find(entry => entry.id === id);
                return { ...experimental, hostModelDirectories: directories.filter(entry => entry.id !== id) };
              },
            });
          },
          restore: async () => {
            await updateExperimental({
              updater: ({ experimental }) => {
                const directories = experimental?.hostModelDirectories ?? [];
                return { ...experimental, hostModelDirectories: removed && !directories.some(entry => entry.id === id) ? [...directories, removed] : directories };
              },
            });
          },
        });
      },
      refreshed: undefined,
    });
  }
  async function downloadDestination({ id }: { id: string }): Promise<HostModelDownloadDestination> {
    if (id === 'opfs') {
      return { kind: 'opfs' };
    }
    return hostDownloadDestination({ id });
  }
  // A typed host intent must never pass through the legacy OPFS string sentinel.
  async function hostDownloadDestination({ id }: { id: string }): Promise<Extract<HostModelDownloadDestination, { kind: 'host' }>> {
    if (!supported.value || !registrations().some(entry => entry.id === id)) {
      throw new Error('Linked model directory is unavailable');
    }
    // Use the cached handle so a permission request stays inside the user gesture.
    const handle = handles.get(id);
    if (!handle) {
      throw new Error('Reconnect this model directory before downloading');
    }
    if (!hostModelPermissionGranted({ permission: await handle.requestPermission({ mode: 'readwrite' }) })) {
      throw new Error('Model directory needs read and write permission');
    }
    return { kind: 'host', directoryId: id };
  }
  return {
    registrations,
    refresh,
    currentHandle: ({ id }) => handles.get(id),
    downloadDestination,
    hostDownloadDestination,
    view: {
      supported,
      entries,
      busy,
      destination,
      add: () => addSelected({ select: () => pick({ existingId: undefined }) }),
      addDroppedDirectory: ({ directory, signal }) => addSelected({
        select: async () => {
          signal.throwIfAborted();
          const handle = hostModelDirectoryHandleSchema.parse(directory);
          if (!hostModelPermissionGranted({ permission: await handle.queryPermission({ mode: 'read' }) })) {
            throw new Error('Model directory needs read permission');
          }
          signal.throwIfAborted();
          return register({ handle, existingId: undefined, signal });
        },
      }),
      reconnect,
      remove,
      selectDestination({ id }) {
        if (busy.value) {
          return;
        }
        if (id === 'opfs' || supported.value && registrations().some(entry => entry.id === id)) {
          destination.value = id;
        }
      },
    },
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

export const TEST_ONLY = {
};
