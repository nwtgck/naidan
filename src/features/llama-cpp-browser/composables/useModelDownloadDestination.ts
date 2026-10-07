import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import type { LlamaCppBrowserSettings } from '@/01-models/types';
import { idToRaw, toHostModelDirectoryId } from '@/01-models/ids';
import { useSettings } from '@/composables/useSettings';
import { useHostModelDirectories } from '@/composables/useHostModelDirectories';
import { getDownloadQueue } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import type { ModelDestination } from '@/features/llama-cpp-browser/runtime/model-destination';

export type AuthorizedModelDestination = { destination: ModelDestination, expectedRoot: FileSystemDirectoryHandle | undefined };

const registrationChangeEvent = 'naidan-host-model-directories-changed';

// One accepted intent is shared by both LM download entry points. It overlays
// stored settings only until its guarded write completes, without changing jobs
// that already captured a destination or the image-generation selector.
type DestinationIntent = {
  revision: number,
  destination: ModelDestination,
  isCurrent: () => boolean,
  status: 'saving' | 'failed',
};
const destinationIntent = shallowRef<DestinationIntent>();
let destinationRevision = 0;

export function hostModelDirectoryLabel({ id, name, entries }: { id: string, name: string, entries: readonly { id: string, name: string }[] }): string {
  return entries.some(entry => entry.name === name && entry.id !== id) ? `${name} (${id})` : name;
}

/** Both LM download entry points share one persisted choice; image generation remains independent. */
export function useModelDownloadDestination({ blocked, changed }: {
  blocked: () => boolean,
  changed: () => void,
}) {
  const { settings, captureExperimentalStorage, updateExperimentalForStorage } = useSettings();
  const registrationFailure = ref(false);
  const revision = ref(0);
  const host = useHostModelDirectories({
    blocked,
    stopDownload: async ({ id }) => getDownloadQueue().stopDirectory({ directoryId: id }),
    changed: async () => {
      registrationFailure.value = false; revision.value++; changed();
      window.dispatchEvent(new Event(registrationChangeEvent));
    },
    failed: () => {
      registrationFailure.value = true;
    },
  });
  const pending = computed(() => {
    // Read settings even while an intent is pending so a storage-provider change
    // invalidates the overlay before an old provider finishes its write.
    void settings.value;
    const intent = destinationIntent.value;
    return intent?.isCurrent() ? intent : undefined;
  });
  const destination = computed<ModelDestination>(() => {
    const stored = settings.value.experimental?.llamaCppBrowser?.modelDownloadDestination;
    if (pending.value) return pending.value.destination;
    switch (stored?.kind) {
    case undefined: case 'opfs': return { kind: 'opfs' };
    case 'host': return { kind: 'host', directoryId: idToRaw({ id: stored.directoryId }) };
    default: { const exhaustive: never = stored; throw new Error(String(exhaustive)); }
    }
  });
  const selectedId = computed(() => {
    const target = destination.value;
    switch (target.kind) {
    case 'opfs': return 'opfs';
    case 'host': return target.directoryId;
    default: { const exhaustive: never = target; throw new Error(String(exhaustive)); }
    }
  });
  const failure = computed(() => registrationFailure.value || pending.value?.status === 'failed');
  async function selectDestination({ id, kind }: { id: string, kind?: 'opfs' | 'host' }): Promise<void> {
    if (blocked() || host.view.busy.value) return;
    const requestedKind = kind ?? (id === 'opfs' ? 'opfs' : 'host');
    let requested: ModelDestination;
    let storedDestination: NonNullable<LlamaCppBrowserSettings['modelDownloadDestination']>;
    switch (requestedKind) {
    case 'opfs':
      requested = { kind: 'opfs' }; storedDestination = { kind: 'opfs' };
      break;
    case 'host':
      if (!host.view.supported.value || !host.registrations().some(entry => entry.id === id)) return;
      requested = { kind: 'host', directoryId: id }; storedDestination = { kind: 'host', directoryId: toHostModelDirectoryId({ raw: id }) };
      break;
    default: { const exhaustive: never = requestedKind; throw new Error(String(exhaustive)); }
    }
    const requestRevision = ++destinationRevision;
    let isStorageCurrent: () => boolean;
    try {
      isStorageCurrent = captureExperimentalStorage();
    } catch {
      destinationIntent.value = { revision: requestRevision, destination: requested, isCurrent: () => true, status: 'failed' };
      return;
    }
    destinationIntent.value = { revision: requestRevision, destination: requested, isCurrent: isStorageCurrent, status: 'saving' };
    registrationFailure.value = false;
    try {
      const outcome = await updateExperimentalForStorage({
        isCurrent: () => isStorageCurrent() && destinationIntent.value?.revision === requestRevision,
        updater: ({ experimental }) => ({
          ...experimental,
          llamaCppBrowser: {
            ...experimental?.llamaCppBrowser,
            modelDownloadDestination: storedDestination,
          },
        }),
      });
      switch (outcome) {
      case 'saved': case 'changed':
        if (destinationIntent.value?.revision === requestRevision) destinationIntent.value = undefined;
        break;
      default: { const exhaustive: never = outcome; throw new Error(String(exhaustive)); }
      }
    } catch {
      if (destinationIntent.value?.revision === requestRevision) {
        destinationIntent.value = isStorageCurrent()
          ? { revision: requestRevision, destination: requested, isCurrent: isStorageCurrent, status: 'failed' } : undefined;
      }
    }
  }
  const unavailable = computed(() => {
    if (pending.value) return true;
    const target = destination.value;
    switch (target.kind) {
    case 'opfs': return false;
    case 'host': {
      const entry = host.view.entries.value.find(entry => entry.id === target.directoryId);
      return !host.view.supported.value || !entry || ['missing', 'error', 'unsupported'].includes(entry.access);
    }
    default: { const exhaustive: never = target; throw new Error(String(exhaustive)); }
    }
  });
  function label({ destination: target }: { destination: ModelDestination }): string {
    switch (target.kind) {
    case 'opfs': return 'OPFS';
    case 'host': {
      const entry = host.view.entries.value.find(entry => entry.id === target.directoryId);
      return entry ? hostModelDirectoryLabel({ id: entry.id, name: entry.name, entries: host.view.entries.value }) : target.directoryId;
    }
    default: { const exhaustive: never = target; throw new Error(String(exhaustive)); }
    }
  }
  async function authorize({ destination: requested }: { destination: ModelDestination }): Promise<AuthorizedModelDestination> {
    // The caller captures its root before permission UI yields. Never consult
    // the current selector after that await or fall back to browser storage.
    switch (requested.kind) {
    case 'opfs': return { destination: { kind: 'opfs' }, expectedRoot: undefined };
    case 'host': {
      const expectedRoot = host.currentHandle({ id: requested.directoryId });
      if (!expectedRoot) throw new Error('Reconnect this model directory before downloading');
      const authorized = await host.hostDownloadDestination({ id: requested.directoryId });
      return { destination: authorized, expectedRoot };
    }
    default: { const exhaustive: never = requested; throw new Error(String(exhaustive)); }
    }
  }
  async function refresh(): Promise<void> {
    await host.refresh(); revision.value++;
  }
  function refreshOnFocus(): void {
    void refresh();
  }
  function registrationsChanged(): void {
    void refresh(); changed();
  }
  watch(() => host.registrations(), () => {
    void refresh(); changed();
  }, { deep: true });
  onMounted(() => {
    window.addEventListener('focus', refreshOnFocus); window.addEventListener(registrationChangeEvent, registrationsChanged); void refresh();
  });
  onUnmounted(() => {
    window.removeEventListener('focus', refreshOnFocus); window.removeEventListener(registrationChangeEvent, registrationsChanged);
  });
  return {
    view: { ...host.view, destination: selectedId, destinationKind: computed(() => destination.value.kind), selectDestination },
    destination,
    unavailable,
    authorize,
    revision,
    failure,
    label,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}
export const TEST_ONLY = {
  reset() {
    destinationIntent.value = undefined; destinationRevision++;
  },
};
