import { usePWAUpdate } from '@/composables/usePWAUpdate';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { ensureStrings } from '@/strings';
import { createPWAUpdateController } from '@/logic/pwa/update-controller';
import { reloadPWAPage } from '@/logic/pwa/reload-page';
import { startPWAOfflineAssetRuntime } from './pwa-offline-asset-runtime';

let runtime: { dispose: () => void } | undefined;

/** Called only by PWAManager after Sidebar and the chat surface can paint. */
export function startPWAUpdateRuntime(): void {
  if (runtime || !('serviceWorker' in navigator) || (import.meta.env.DEV && !__BUILD_MODE_IS_TEST__)) {
    return;
  }
  const { setUpdateState } = usePWAUpdate();
  const { addInfoEvent, addErrorEvent, addEvent } = useGlobalEvents();
  let disposed = false;
  const baseUrl = new URL(import.meta.env.BASE_URL, document.baseURI);
  const offlineAssets = startPWAOfflineAssetRuntime({ serviceWorkers: navigator.serviceWorker, baseUrl, buildId: __PWA_BUILD_ID__ });
  const controller = createPWAUpdateController({
    platform: {
      serviceWorkers: navigator.serviceWorker,
      reload: () => reloadPWAPage({ location: window.location, history: window.history }),
    },
    pageBuildId: __PWA_BUILD_ID__,
    baseUrl,
    onState: ({ next }) => setUpdateState({ next }),
    onOfflineReady: () => {
      void (async () => {
        const ready = await offlineAssets.confirmReady();
        if (!ready || disposed) {
          return;
        }
        const message = ready.controlled ? await ensureStrings.PWAManager__app_ready_to_work_offline()
          : await ensureStrings.PWAManager__reopen_to_use_offline();
        if (offlineAssets.stillReady(ready)) {
          addInfoEvent({ source: 'PWA', message });
        }
      })().catch((error: unknown) => {
        if (!disposed) {
          console.error('[PWA] Failed to load the offline-ready notification.', error);
        }
      });
    },
    onWarning: ({ message }) => {
      console.warn(`[PWA] ${message}`);
      addEvent({ type: 'warn', source: 'PWA', message });
    },
    onError: ({ message, error }) => {
      console.error(`[PWA] ${message}`, error);
      addErrorEvent({ source: 'PWA', message, details: error instanceof Error ? error : String(error) });
    },
  });
  runtime = {
    dispose() {
      disposed = true;
      offlineAssets.dispose();
      controller.dispose();
    },
  };
}

export const TEST_ONLY = {
  reset() {
    runtime?.dispose();
    runtime = undefined;
    usePWAUpdate().setUpdateState({ next: { kind: 'idle' } });
  },
};
