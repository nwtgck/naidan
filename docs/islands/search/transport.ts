import { parseWorkerRequest, parseWorkerResponse } from './worker-contracts';
import type { SearchWorkerRequest, SearchWorkerResponse } from './worker-contracts';
import type { DocsLocale } from '../../site/routes';

// This is the single structured-clone boundary for Docs search. Both sides
// validate received messages before handing them to search or UI code.
export function sendSearchRequest({ worker, request }: { worker: Worker; request: SearchWorkerRequest }): void {
  // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- The worker parses every incoming request in subscribeSearchRequests.
  worker.postMessage(request);
}

export function subscribeSearchResponses({ worker, locale, onResponse, onError }: {
  worker: Worker;
  locale: DocsLocale;
  onResponse: ({ response }: { response: SearchWorkerResponse }) => void;
  onError: ({ error }: { error: unknown }) => void;
}): () => void {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- DOM listener signature is positional.
  const listener = (event: MessageEvent<unknown>): void => {
    try {
      onResponse({ response: parseWorkerResponse({ value: event.data, locale }) });
    } catch (error) {
      onError({ error });
    }
  };
  // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- The listener parses every incoming response.
  worker.addEventListener('message', listener);
  return () => worker.removeEventListener('message', listener);
}

type WorkerEndpoint = Pick<Worker, 'addEventListener' | 'postMessage'>;

export function subscribeSearchRequests({ onRequest }: { onRequest: ({ request }: { request: SearchWorkerRequest }) => void }): void {
  const endpoint = self as unknown as WorkerEndpoint;

  endpoint.addEventListener('message', event => {
    try {
      onRequest({ request: parseWorkerRequest({ value: event.data }) });
    } catch (error) {
      console.error('[Docs search] Invalid worker request.', error);
    }
  });
}

export function sendSearchResponse({ response }: { response: SearchWorkerResponse }): void {
  const endpoint = self as unknown as WorkerEndpoint;

  endpoint.postMessage(response);
}
