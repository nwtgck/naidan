import { isPWAReply, type PWAReply, type PWARequest } from '@/logic/pwa/protocol';

/** A bounded capability check, not an assumption about the currently active SW. */
export async function requestPWAWorker({ worker, request }: {
  worker: ServiceWorker;
  request: PWARequest;
}): Promise<PWAReply> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = () => {
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error('The service worker did not answer the update request.'));
    }, 5000);
    // The cross-version Service Worker protocol intentionally uses a one-shot
    // MessageChannel, not a long-lived Comlink endpoint. Validate every reply.
    // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- Audited native SW capability/reply boundary; ports close on every terminal path.
    channel.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
      finish();
      if (isPWAReply(data) && data.ok) resolve(data);
      else reject(new Error('The service worker rejected the update request.'));
    };
    channel.port1.onmessageerror = () => {
      finish();
      reject(new Error('The service worker returned an unreadable update response.'));
    };
    try {
      worker.postMessage(request, [channel.port2]);
    } catch (error) {
      finish();
      reject(error);
    }
  });
}

export const TEST_ONLY = {
};
