import { z } from 'zod';
import { getReadableStreamTransferSupport, type WorkerTransfer, type WorkerCapability, workerCapability, exposeWorkerRemote, releaseWorkerRemote, workerTransfer, wrapWorkerRemote } from '@/utils/worker-transport';
import { createPrivacyFetchError, isPrivacyFetchError } from './errors';
import { fetchPrivacyStream } from './stream-fetch';
import { streamResponseSchema } from './stream-protocol';
import type { PrivacyFetchRequest, PrivacyFetchStreamResponse } from './types';

const MAX_CHUNK_BYTES = 256 * 1024;
type StreamReply = z.infer<typeof streamResponseSchema>;
type StreamApi = {
  headers(): Promise<StreamReply>,
  read(): Promise<StreamReply>,
  transferSupport(): Promise<'supported' | 'unsupported'>,
  transferBody(): Promise<WorkerTransfer<WorkerCapability<ReadableStream<Uint8Array<ArrayBuffer>>, 'readable-stream-transfer'>>>,
  completed(): Promise<void>,
  cancel(): Promise<void>,
};

export function receivePrivacyStream({ port, signal, onFinish }: {
  port: MessagePort,
  signal: AbortSignal | undefined,
  onFinish: () => void,
}): { response: Promise<PrivacyFetchStreamResponse>, dispose: () => void } {
  const remote = wrapWorkerRemote<StreamApi>({ endpoint: port });
  let resolveResponse!: ReturnType<typeof Promise.withResolvers<PrivacyFetchStreamResponse>>['resolve'];
  let rejectResponse!: ReturnType<typeof Promise.withResolvers<PrivacyFetchStreamResponse>>['reject'];
  const response = new Promise<PrivacyFetchStreamResponse>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  let controller!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
  let finished = false;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseWorkerRemote({ remote });
    port.close();
  };
  const cleanup = () => {
    finished = true;
    signal?.removeEventListener('abort', abort);
    // Cancel first so pending reads/fetches settle before releasing the RPC endpoint.
    void remote.cancel().catch(() => undefined).finally(release);
    onFinish();
  };
  const fail = ({ code }: { code: 'aborted' | 'broker_disposed' | 'fetch_failed' | 'rejected' }) => {
    if (finished) return;
    const error = createPrivacyFetchError({ code, message: `Privacy fetch stream failed: ${code}` });
    rejectResponse(error);
    controller.error(error);
    cleanup();
  };
  const abort = () => fail({ code: 'aborted' });
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(value) {
      controller = value;
    },
    async pull() {
      try {
        const message = streamResponseSchema.parse(await remote.read());
        if (finished) return;
        switch (message.type) {
        case 'chunk':
          if (message.body.byteLength === 0 || message.body.byteLength > MAX_CHUNK_BYTES) {
            fail({ code: 'fetch_failed' }); return;
          }
          controller.enqueue(new Uint8Array(message.body));
          return;
        case 'end':
          controller.close();
          cleanup();
          return;
        case 'error': fail({ code: message.code }); return;
        case 'headers': fail({ code: 'fetch_failed' }); return;
        default: {
          const exhaustive: never = message;
          throw new Error(`Unhandled stream reply: ${String(exhaustive)}`);
        }
        }
      } catch {
        fail({ code: 'fetch_failed' });
      }
    },
    cancel() {
      if (!finished) cleanup();
    },
  }, { highWaterMark: 0 });
  void remote.headers().then(async value => {
    if (finished) return;
    const message = streamResponseSchema.parse(value);
    switch (message.type) {
    case 'headers': {
      const { type: _type, headers, ...metadata } = message;
      const responseHeaders = new Headers(headers);
      if (await getReadableStreamTransferSupport() === 'supported'
          && z.enum(['supported', 'unsupported']).parse(await remote.transferSupport()) === 'supported') {
        if (finished) return;
        const transferred = z.custom<ReadableStream<Uint8Array<ArrayBuffer>>>(value => value instanceof ReadableStream)
          .parse(await remote.transferBody());
        if (finished) {
          await transferred.cancel().catch(() => undefined); return;
        }
        void remote.completed().then(() => {
          if (!finished) cleanup();
        }).catch(() => fail({ code: 'fetch_failed' }));
        resolveResponse({ ...metadata, headers: responseHeaders, body: transferred });
      } else if (!finished) {
        resolveResponse({ ...metadata, headers: responseHeaders, body });
      }
      return;
    }
    case 'error': fail({ code: message.code }); return;
    case 'chunk':
    case 'end': fail({ code: 'fetch_failed' }); return;
    default: {
      const exhaustive: never = message;
      throw new Error(`Unhandled stream headers: ${String(exhaustive)}`);
    }
    }
  }).catch(() => fail({ code: 'fetch_failed' }));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return { response, dispose: () => {
    fail({ code: 'broker_disposed' });
    // The iframe may already be gone; disposal cannot wait for a remote acknowledgement.
    release();
  } };
}

export function servePrivacyStream({ port, request }: { port: MessagePort, request: PrivacyFetchRequest }): void {
  servePrivacyStreamWithFetcher({ port, fetchResponse: ({ signal }) => fetchPrivacyStream({ request: { ...request, signal } }) });
}
/** Reuse the same backpressure/transfer negotiation for an already authorized
 * fetch source. Hosted callers must inject privacyFetchStream, not raw fetch. */
export function servePrivacyStreamWithFetcher({ port, fetchResponse }: {
  port: MessagePort, fetchResponse: ({ signal }: { signal: AbortSignal }) => Promise<PrivacyFetchStreamResponse>,
}): { dispose(): Promise<void> } {
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
  let remainder: Uint8Array | undefined;
  let finished = false;
  let pulling = false;
  let mode: 'unclaimed' | 'chunks' | 'stream' = 'unclaimed';
  let resolveCompleted!: ReturnType<typeof Promise.withResolvers<void>>['resolve'];
  const completed = new Promise<void>(resolve => {
    resolveCompleted = resolve;
  });
  const cancel = async () => {
    if (finished) return;
    finished = true;
    abort.abort();
    remainder = undefined;
    await reader?.cancel().catch(() => undefined);
    resolveCompleted();
  };
  const errorReply = ({ error }: { error: unknown }): StreamReply => ({
    type: 'error', code: isPrivacyFetchError(error) && error.code === 'rejected' ? 'rejected' : 'fetch_failed',
    message: 'Privacy fetch stream failed',
  });
  const ready: Promise<StreamReply> = Promise.resolve().then(() => fetchResponse({ signal: abort.signal })).then(async (response): Promise<StreamReply> => {
    if (finished) {
      await response.body.cancel().catch(() => undefined);
      return { type: 'error', code: 'aborted', message: 'Privacy fetch was aborted' };
    }
    reader = response.body.getReader();
    const { body: _body, headers, ...metadata } = response;
    return { type: 'headers', ...metadata, headers: Array.from(headers.entries()) };
  }).catch(error => errorReply({ error }));
  exposeWorkerRemote<StreamApi>({
    endpoint: port,
    api: {
      headers: () => ready,
      cancel,
      transferSupport: getReadableStreamTransferSupport,
      completed: () => completed,
      async transferBody() {
        await ready;
        if (mode !== 'unclaimed' || finished || reader === undefined || await getReadableStreamTransferSupport() !== 'supported') {
          throw createPrivacyFetchError({ code: 'fetch_failed', message: 'Privacy stream transfer is unavailable' });
        }
        mode = 'stream';
        const sourceReader = reader;
        const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
          async pull(controller) {
            try {
              const result = await sourceReader.read();
              if (result.done) {
                controller.close(); await cancel();
              } else controller.enqueue(result.value);
            } catch {
              controller.error(createPrivacyFetchError({ code: 'fetch_failed', message: 'Privacy fetch stream failed' }));
              await cancel();
            }
          },
          cancel,
        }, { highWaterMark: 0 });
        return workerTransfer({ value: workerCapability({ value: stream, capability: 'readable-stream-transfer' }), transferables: [stream] });
      },
      async read(): Promise<StreamReply> {
        if (pulling || mode === 'stream') return errorReply({ error: new Error('Overlapping stream reads') });
        mode = 'chunks';
        pulling = true;
        try {
          const headers = await ready;
          switch (headers.type) {
          case 'headers': break;
          case 'chunk':
          case 'end':
          case 'error': return headers;
          default: {
            const exhaustive: never = headers;
            throw new Error(`Unhandled stream readiness: ${String(exhaustive)}`);
          }
          }
          if (finished || reader === undefined) return { type: 'end' };
          while (remainder === undefined || remainder.byteLength === 0) {
            const result = await reader.read();
            if (finished || result.done) {
              await cancel(); return { type: 'end' };
            }
            remainder = result.value;
          }
          const chunk = remainder.slice(0, MAX_CHUNK_BYTES);
          remainder = remainder.subarray(chunk.byteLength);
          return workerTransfer({ value: { type: 'chunk', body: chunk.buffer }, transferables: [chunk.buffer] });
        } catch (error) {
          await cancel();
          return errorReply({ error });
        } finally {
          pulling = false;
        }
      },
    },
  });
  return { dispose: cancel };
}

export const TEST_ONLY = {
};
