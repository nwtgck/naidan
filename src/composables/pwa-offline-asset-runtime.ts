import { shallowRef, watch } from 'vue';
import { currentLocale, preparingLocales } from '@/strings';
import { selectHostedTransformersRuntimeVariant } from '@/features/transformers-js/runtime/configure-hosted-runtime';
import { requestedOfflineProfiles } from '@/features/llama-cpp-browser/runtime/offline-profile-preferences';
import { ASSET_SELECTION_CHANGED, READ_ASSET_SELECTION, type AssetSelection, type PrepareOfflineAssetsRequest, type RuntimeSelection } from '@/logic/pwa/asset-cache-protocol';
import { requestBuildId, requestOfflineAssetPreparation } from '@/logic/pwa/worker-request';
import { setOfflineAssetAction, setOfflineAssetStatus } from './usePWAOfflineAssets';

export function startPWAOfflineAssetRuntime({ serviceWorkers, baseUrl, buildId }: {
  serviceWorkers: ServiceWorkerContainer;
  baseUrl: URL;
  buildId: string;
}) {
  const lifetime = new AbortController();
  const workerUrl = new URL('sw.js', baseUrl).href;
  let selectionRevision = 0;
  let control: ServiceWorker | undefined;
  let availableFor: ServiceWorker | undefined;
  let checking: ServiceWorker | undefined;
  let manualSave: AbortController | undefined;
  let offlineReady = false;
  const llamaProfiles = shallowRef<AssetSelection['llama'] | 'pending'>('pending');
  const unknownNativeProfiles = {
    'stable-diffusion-cpp-browser': { status: 'unknown' },
    'speech-cpp-browser': { status: 'unknown' },
  } as const;
  const nativeProfiles = shallowRef<Record<'stable-diffusion-cpp-browser' | 'speech-cpp-browser', RuntimeSelection>>({
    'stable-diffusion-cpp-browser': { status: 'pending' },
    'speech-cpp-browser': { status: 'pending' },
  });
  const probeSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]);
  const settled = Promise.withResolvers<void>();
  probeSignal.addEventListener('abort', () => {
    if (llamaProfiles.value === 'pending') {
      llamaProfiles.value = undefined;
    }
    if (Object.values(nativeProfiles.value).some(selection => selection.status === 'pending')) {
      nativeProfiles.value = unknownNativeProfiles;
    }
    settled.resolve();
  }, { once: true });
  const probes = Promise.all([
    import('@/features/llama-cpp-browser/runtime/offline-profile-probe').then(async ({ probeOfflineLlamaProfiles }) => {
      const profiles = await probeOfflineLlamaProfiles({ signal: probeSignal });
      if (!probeSignal.aborted) {
        llamaProfiles.value = profiles;
      }
    }).catch(() => {}).finally(() => {
      if (llamaProfiles.value === 'pending') {
        llamaProfiles.value = undefined;
      }
    }),
    (__BUILD_MODE_IS_STANDALONE__ ? Promise.resolve(undefined) : import('./pwa-native-runtime-selection')).then(nativeSelection => {
      if (!probeSignal.aborted) {
        nativeProfiles.value = nativeSelection?.selectNativePWAProfiles() ?? unknownNativeProfiles;
      }
    }).catch(() => {
      nativeProfiles.value = unknownNativeProfiles;
    }),
  ]);
  void probes.then(() => settled.resolve());

  function readSelection(): AssetSelection {
    const profiles = llamaProfiles.value;
    const llama = profiles === undefined || profiles === 'pending' ? undefined : [...new Set([...profiles, ...requestedOfflineProfiles.value])];
    const transformers = selectHostedTransformersRuntimeVariant({ userAgent: navigator.userAgent, vendor: undefined });
    return {
      locales: [...new Set([currentLocale.value, ...preparingLocales.value])],
      // Navigator.vendor is Window-only. Use the same input as a Dedicated Worker.
      transformers,
      llama,
      runtimes: {
        ...nativeProfiles.value,
        'transformers-js': { status: 'known', profiles: [transformers] },
        'llama-cpp-browser': profiles === 'pending' ? { status: 'pending' } : llama === undefined
          ? { status: 'unknown' } : { status: 'known', profiles: llama },
      },
    };
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native ServiceWorkerContainer message event listener.
  function replyToInstaller(event: MessageEvent<unknown>): void {
    const data = event.data;
    const source = event.source;
    if (!data || typeof data !== 'object' || !('type' in data) || data.type !== READ_ASSET_SELECTION
      || !source || !('scriptURL' in source) || source.scriptURL !== workerUrl) {
      return;
    }
    const port = event.ports[0];
    if (!port) {
      return;
    }
    // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- Only the scoped worker can ask. The worker schema checks the one-shot reply.
    port.postMessage(readSelection());
    port.close();
  }

  async function prepare({ worker, target, current, signal }: {
    worker: ServiceWorker;
    target: PrepareOfflineAssetsRequest['target'];
    current: () => boolean;
    signal: AbortSignal;
  }): Promise<'complete' | 'unavailable' | 'failed'> {
    try {
      let remaining = Infinity;
      while (!signal.aborted && current()) {
        const reply = await requestOfflineAssetPreparation({ worker, buildId, target, signal });
        if (typeof reply === 'string') {
          return current() ? reply : 'unavailable';
        }
        if (reply.remaining >= remaining) {
          return 'failed';
        }
        remaining = reply.remaining;
      }
      return 'unavailable';
    } catch {
      return 'failed';
    }
  }

  async function saveRemaining(): Promise<void> {
    if (!availableFor || manualSave) {
      return;
    }
    const worker = availableFor;
    const operation = new AbortController();
    manualSave = operation;
    setOfflineAssetStatus({ next: 'saving' });
    try {
      const result = await prepare({
        worker,
        target: { kind: 'remaining' },
        current: () => availableFor === worker && manualSave === operation,
        signal: AbortSignal.any([lifetime.signal, operation.signal]),
      });
      if (availableFor === worker && manualSave === operation) {
        setOfflineAssetStatus({ next: result });
      }
    } finally {
      if (manualSave === operation) {
        manualSave = undefined;
      }
    }
  }

  function updateControl(): void {
    const candidate = serviceWorkers.controller ?? undefined;
    if (candidate !== control) {
      control?.removeEventListener('statechange', updateControl);
      control = candidate;
      control?.addEventListener('statechange', updateControl);
      manualSave?.abort();
      manualSave = undefined;
      availableFor = undefined;
      setOfflineAssetAction({ action: undefined });
    }
    if (!candidate || candidate.scriptURL !== workerUrl || candidate.state !== 'activated'
      || candidate === availableFor || candidate === checking) {
      return;
    }
    checking = candidate;
    void requestBuildId({ worker: candidate, signal: lifetime.signal }).then(identity => {
      if (control === candidate && identity === buildId && !lifetime.signal.aborted) {
        availableFor = candidate;
        setOfflineAssetAction({ action: saveRemaining });
      }
    }).catch(() => {}).finally(() => {
      if (checking === candidate) {
        checking = undefined;
      }
    });
  }

  async function ensureSelection(): Promise<ServiceWorker | undefined> {
    await settled.promise;
    const revision = selectionRevision;
    const selection = readSelection();
    try {
      const registration = await serviceWorkers.getRegistration(baseUrl.href);
      const worker = registration?.scope === baseUrl.href ? registration.active : undefined;
      if (!worker || worker.scriptURL !== workerUrl) {
        return undefined;
      }
      const result = await prepare({
        worker,
        target: { kind: 'selection', selection },
        current: () => selectionRevision === revision && registration?.active === worker,
        signal: lifetime.signal,
      });
      return result === 'complete' && selectionRevision === revision && !lifetime.signal.aborted ? worker : undefined;
    } catch {
      return undefined;
    }
  }

  function notifyInstaller(): void {
    void (async () => {
      const registration = await serviceWorkers.getRegistration(baseUrl.href);
      const worker = registration?.scope === baseUrl.href ? registration.installing : undefined;
      if (!lifetime.signal.aborted && worker?.scriptURL === workerUrl) {
        worker.postMessage({ type: ASSET_SELECTION_CHANGED });
      }
    })().catch(() => {});
  }

  serviceWorkers.addEventListener('message', replyToInstaller);
  serviceWorkers.addEventListener('controllerchange', updateControl);
  updateControl();
  const stopSelection = watch([currentLocale, preparingLocales, llamaProfiles, nativeProfiles, requestedOfflineProfiles], ([, pending]) => {
    selectionRevision++;
    notifyInstaller();
    if ((offlineReady || availableFor) && pending.length === 0) {
      void ensureSelection();
    }
  }, { flush: 'sync' });

  return {
    async confirmReady() {
      offlineReady = true;
      for (let attempts = 0; attempts < 4; attempts++) {
        const revision = selectionRevision;
        const worker = await ensureSelection();
        if (revision === selectionRevision || lifetime.signal.aborted) {
          return worker ? { revision, worker, controlled: serviceWorkers.controller === worker } : undefined;
        }
      }
      return undefined;
    },
    stillReady({ revision, worker, controlled }: { revision: number; worker: ServiceWorker; controlled: boolean }) {
      return !lifetime.signal.aborted && selectionRevision === revision
        && worker.state === 'activated' && controlled === (serviceWorkers.controller === worker);
    },
    dispose() {
      lifetime.abort();
      stopSelection();
      serviceWorkers.removeEventListener('message', replyToInstaller);
      serviceWorkers.removeEventListener('controllerchange', updateControl);
      control?.removeEventListener('statechange', updateControl);
      setOfflineAssetAction({ action: undefined });
    },
  };
}

export const TEST_ONLY = {
};
