import { usePWAUpdate } from '@/composables/usePWAUpdate';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { ensureStrings } from '@/strings';
import { createPWAUpdateController } from '@/logic/pwa/update-controller';

let runtime: { dispose: () => void } | undefined;

/** Called only by PWAManager after Sidebar and the chat surface can paint. */
export function startPWAUpdateRuntime(): void {
  if (runtime || !('serviceWorker' in navigator) || (import.meta.env.DEV && !__BUILD_MODE_IS_TEST__)) return;
  const { setUpdateState } = usePWAUpdate();
  const { addInfoEvent, addErrorEvent } = useGlobalEvents();
  let disposed = false;
  const controller = createPWAUpdateController({
    platform: {
      serviceWorkers: navigator.serviceWorker,
      getHref: () => window.location.href,
      navigate: ({ href }) => window.location.replace(href),
      replaceHistory: ({ href }) => window.history.replaceState(window.history.state, '', href),
      fetch: (input, init) => window.fetch(input, init),
      createToken: () => window.crypto.randomUUID(),
    },
    baseUrl: new URL(import.meta.env.BASE_URL, window.location.href),
    buildId: __PWA_BUILD_ID__,
    onState: ({ next }) => setUpdateState({ next }),
    onOfflineReady: () => {
      void ensureStrings.PWAManager__app_ready_to_work_offline().then((message) => {
        if (!disposed) addInfoEvent({ source: 'PWA', message });
      }).catch((error: unknown) => {
        if (!disposed) console.error('[PWA] Failed to load the offline-ready notification.', error);
      });
    },
    onError: ({ message, error }) => {
      console.error(`[PWA] ${message}`, error);
      addErrorEvent({ source: 'PWA', message, details: error instanceof Error ? error : String(error) });
    },
  });
  runtime = { dispose() {
    disposed = true; controller.dispose();
  } };
}

export const TEST_ONLY = {
  reset() {
    runtime?.dispose();
    runtime = undefined;
    usePWAUpdate().setUpdateState({ next: { kind: 'idle' } });
  },
};
