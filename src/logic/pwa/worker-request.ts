import { USE_NETWORK_MESSAGE } from '@/logic/pwa/protocol';

/** An acknowledged, bounded command to the CURRENT controller, never an installer. */
export function requestNetworkUpdate({ worker, signal }: {
  worker: ServiceWorker;
  signal: AbortSignal;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('The update runtime was stopped.')); return;
    }
    const channel = new MessageChannel();
    let settled = false;
    const finish = ({ error }: { error?: unknown } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      channel.port1.close();
      channel.port2.close();
      if (error) reject(error); else resolve();
    };
    const abort = () => finish({ error: new Error('The update runtime was stopped.') });
    const timer = setTimeout(() => finish({ error: new Error('The current service worker did not enable network updating. Wait for offline preparation and retry.') }), 5000);
    signal.addEventListener('abort', abort, { once: true });
    // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- One-shot, validated SW acknowledgement; both ports close on every terminal path.
    channel.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (data === USE_NETWORK_MESSAGE) finish();
      else finish({ error: new Error('The service worker could not enable network updating.') });
    };
    channel.port1.onmessageerror = () => finish({ error: new Error('The update acknowledgement could not be read.') });
    try {
      worker.postMessage({ type: USE_NETWORK_MESSAGE }, [channel.port2]);
    } catch (error) {
      finish({ error });
    }
  });
}

export const TEST_ONLY = {
};
