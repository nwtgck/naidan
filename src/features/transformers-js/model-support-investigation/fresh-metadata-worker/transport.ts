import { FRESH_METADATA_MAX_REQUESTS, type FreshMetadataHttpObservation } from './types';
import { isModelWeightFileName } from '@/features/transformers-js/runtime/configure-hosted-runtime';

export function createFreshMetadataTransport({ modelId, revision, maximumBytes, originalFetch, signal, onObservation }: {
  modelId: string,
  revision: string,
  maximumBytes: number,
  originalFetch: typeof fetch,
  signal: AbortSignal,
  onObservation: () => void,
}) {
  const requests: FreshMetadataHttpObservation[] = [];
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const controller = new AbortController();
  const operationSignal = AbortSignal.any([signal, controller.signal]);
  let receivedBytes = 0;
  let consumer: FreshMetadataHttpObservation['consumer'] = 'runtime-preparation';
  const transport: typeof fetch = async (input, init) => {
    operationSignal.throwIfAborted();
    const request = new Request(input, init);
    const url = new URL(request.url);
    const prefix = `/${modelId}/resolve/${revision}/`;
    // The shared metadata operation admits resource identity before calling us.
    // Repeat the exact-origin/revision boundary here so telemetry never retains
    // credentials, queries, local paths, or another model's identity.
    if (url.origin !== 'https://huggingface.co' || url.username || url.password || !url.pathname.startsWith(prefix)) {
      throw new Error('Fresh metadata transport identity mismatch');
    }
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    if (path.startsWith('onnx/') || isModelWeightFileName({ fileName: path.replace(/\.gz$/u, '').split('/').at(-1)! })) {
      throw new Error('Fresh metadata cannot fetch model weights');
    }
    if (request.method !== 'GET' || (request.headers.has('Range') && request.headers.get('Range') !== 'bytes=0-0')) {
      throw new Error('Fresh metadata request is not a full GET or size probe');
    }
    if (receivedBytes >= maximumBytes) throw new Error('Fresh metadata transfer budget exhausted');
    if (requests.length >= FRESH_METADATA_MAX_REQUESTS) throw new Error('Fresh metadata request budget exceeded');
    const observation: FreshMetadataHttpObservation = {
      consumer,
      path: url.pathname.slice(prefix.length), request: request.headers.has('Range') ? 'size-probe' : 'full',
      status: 'requesting', receivedBytes: 0,
    };
    requests.push(observation);
    onObservation();
    try {
      const response = await originalFetch(request, {
        signal: AbortSignal.any([request.signal, operationSignal]),
        credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
      });
      if (operationSignal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        operationSignal.throwIfAborted();
      }
      const length = response.headers.get('Content-Length');
      const range = response.headers.get('Content-Range');
      observation.httpStatus = response.status;
      observation.contentLength = length !== null && /^\d+$/u.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : undefined;
      observation.contentRange = range !== null && /^bytes \d+-\d+\/\d+$/u.test(range) ? range : undefined;
      observation.status = 'reading';
      if (response.body === null) {
        observation.status = 'complete';
        onObservation();
        return response;
      }
      const reader = response.body.getReader();
      readers.add(reader);
      let ended = false;
      onObservation();
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          try {
            operationSignal.throwIfAborted();
            const item = await reader.read();
            if (ended) return;
            operationSignal.throwIfAborted();
            if (item.done) {
              observation.status = 'complete';
              ended = true;
              readers.delete(reader);
              reader.releaseLock();
              stream.close();
              onObservation();
              return;
            }
            receivedBytes += item.value.byteLength;
            observation.receivedBytes += item.value.byteLength;
            if (receivedBytes > maximumBytes) throw new Error('Fresh metadata transfer budget exceeded');
            stream.enqueue(item.value);
            onObservation();
          } catch (error) {
            observation.status = 'failed';
            controller.abort(error);
            stream.error(error);
            onObservation();
          }
        },
        async cancel() {
          ended = true;
          observation.status = 'cancelling';
          onObservation();
          try {
            await reader.cancel();
            observation.status = 'cancelled';
          } catch (error) {
            observation.status = 'failed';
            throw error;
          } finally {
            readers.delete(reader);
            reader.releaseLock();
            onObservation();
          }
        },
      }, { highWaterMark: 0 });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      observation.status = 'failed';
      onObservation();
      throw error;
    }
  };
  return {
    setConsumer({ next }: { next: FreshMetadataHttpObservation['consumer'] }) {
      consumer = next;
    },
    fetch: transport,
    snapshot() {
      return { receivedBytes, requests: requests.map(request => ({ ...request })) };
    },
    dispose() {
      controller.abort();
      for (const reader of readers) void reader.cancel().catch(() => undefined);
      readers.clear();
    },
  };
}

export const TEST_ONLY = {
};
