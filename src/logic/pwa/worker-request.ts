
import { BUILD_ID_MESSAGE, COMPLETE_OFFLINE_MESSAGE, USE_NETWORK_MESSAGE } from './protocol';
import { PREPARE_OFFLINE_ASSETS, prepareOfflineAssetsReplySchema, type PrepareOfflineAssetsRequest } from './asset-cache-protocol';

/** A bounded, one-shot exchange. Every terminal path closes both ports. */
function requestWorker<T>({ worker, signal, message, parse, failure, timeoutMs }: {
  worker: ServiceWorker;
  signal: AbortSignal;
  message: { type: string; buildId?: string };
  parse: ({ data }: { data: unknown }) => T;
  failure: string;
  timeoutMs: number | undefined;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('The update runtime was stopped.'));
      return;
    }
    const channel = new MessageChannel();
    let settled = false;
    const finish = ({ result }: { result: { value: T } | { error: unknown } }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      channel.port1.close();
      channel.port2.close();
      if ('error' in result) {
        reject(result.error);
      } else {
        resolve(result.value);
      }
    };
    const abort = () => finish({ result: { error: new Error('The update runtime was stopped.') } });
    const timer = setTimeout(() => finish({ result: { error: new Error(failure) } }), timeoutMs ?? 5000);
    signal.addEventListener('abort', abort, { once: true });
    // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- One-shot exchange; parse validates before resolution and both ports close on every terminal path.
    channel.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
      try {
        finish({ result: { value: parse({ data }) } });
      } catch (error) {
        finish({ result: { error } });
      }
    };
    channel.port1.onmessageerror = () => finish({ result: { error: new Error('The update acknowledgement could not be read.') } });
    try {
      worker.postMessage(message, [channel.port2]);
    } catch (error) {
      finish({ result: { error } });
    }
  });
}

export function requestNetworkUpdate({ worker, signal }: { worker: ServiceWorker; signal: AbortSignal }): Promise<void> {
  return requestWorker({
    worker,
    signal,
    message: { type: USE_NETWORK_MESSAGE },
    timeoutMs: undefined,
    failure: 'The current service worker did not enable network updating. Wait for offline preparation and retry.',
    parse({ data }) {
      if (data !== USE_NETWORK_MESSAGE) {
        throw new Error('The service worker could not enable network updating.');
      }
    },
  });
}

export function requestBuildId({ worker, signal }: { worker: ServiceWorker; signal: AbortSignal }): Promise<string> {
  return requestWorker({
    worker,
    signal,
    message: { type: BUILD_ID_MESSAGE },
    timeoutMs: undefined,
    failure: 'The service worker did not identify its build.',
    parse({ data }) {
      if (!data || typeof data !== 'object' || !('type' in data) || data.type !== BUILD_ID_MESSAGE
        || !('buildId' in data) || typeof data.buildId !== 'string' || !data.buildId.trim()) {
        throw new Error('Invalid service worker build identity.');
      }
      return data.buildId;
    },
  });
}

/** Arms worker-owned completion, not a page-owned SKIP_WAITING or reload. */
export function requestOfflineCompletion({ worker, buildId, signal }: { worker: ServiceWorker; buildId: string; signal: AbortSignal }): Promise<void> {
  return requestWorker({
    worker,
    signal,
    message: { type: COMPLETE_OFFLINE_MESSAGE, buildId },
    timeoutMs: undefined,
    failure: 'The current service worker cannot safely finish offline preparation automatically. It will switch after its clients close.',
    parse({ data }) {
      if (data !== COMPLETE_OFFLINE_MESSAGE) {
        throw new Error('Offline completion was not accepted by the current service worker.');
      }
    },
  });
}

export function requestOfflineAssetPreparation({ worker, buildId, target, signal }: {
  worker: ServiceWorker;
  buildId: string;
  target: PrepareOfflineAssetsRequest['target'];
  signal: AbortSignal;
}) {
  const message: PrepareOfflineAssetsRequest = { type: PREPARE_OFFLINE_ASSETS, buildId, target };
  return requestWorker({
    worker,
    signal,
    message,
    timeoutMs: 125_000,
    failure: 'The service worker did not reply about offline assets.',
    parse: ({ data }) => prepareOfflineAssetsReplySchema.parse(data),
  });
}

export const TEST_ONLY = {
};
