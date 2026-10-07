import { z } from 'zod';
import { createValidatedMessagePort } from './worker-transport';

// One credit, one bounded copy. Never transfer a producer's entire backing buffer:
// it may contain unrelated bytes, be reused by the producer, or be shared memory.
export const BYTE_STREAM_CHUNK_BYTES = 256 * 1024;
const requestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pull') }),
  z.object({ type: z.literal('cancel') }),
]);
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const arrayBufferSchema = z.custom<ArrayBuffer>(value => {
  // Use the intrinsic brand check, not instanceof: browser/VM realms can differ.
  try {
    arrayBufferByteLength.call(value); return true;
  } catch {
    return false;
  }
});
const responseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chunk'), bytes: arrayBufferSchema }),
  z.object({ type: z.literal('end') }),
  z.object({ type: z.literal('error'), message: z.string().max(2048) }),
]);
export const byteStreamPortSchema = z.custom<MessagePort>(value =>
  value !== null && typeof value === 'object'
  && 'postMessage' in value && typeof value.postMessage === 'function'
  && 'close' in value && typeof value.close === 'function'
  && 'start' in value && typeof value.start === 'function');

function abortError(): DOMException {
  return new DOMException('Stream download cancelled', 'AbortError');
}

export function serveByteStream({ port, openStream, signal }: {
  port: MessagePort,
  openStream: () => Promise<ReadableStream<Uint8Array>>,
  signal: AbortSignal | undefined,
}): { completed: Promise<void>, abort: ({ reason }: { reason: unknown }) => void } {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let remainder: Uint8Array | undefined;
  let finished = false;
  let pulling = false;
  const completion = Promise.withResolvers<void>();
  // Callers can attach their observer later without an unhandled rejection.
  void completion.promise.catch(() => undefined);

  const finish = ({ reason }: { reason: unknown | undefined }) => {
    if (finished) return;
    finished = true;
    remainder = undefined;
    signal?.removeEventListener('abort', onAbort);
    channel.close();
    if (reader) {
      const current = reader;
      reader = undefined;
      // A producer's cancel hook need not settle for our consumer to be released.
      void current.cancel(reason).catch(() => undefined);
      // Producer cleanup must not retain a reader after the transport has ended.
      current.releaseLock();
    }
    if (reason === undefined) completion.resolve();
    else completion.reject(reason);
  };
  const abort = ({ reason }: { reason: unknown }) => {
    if (finished) return;
    try {
      channel.send({ message: { type: 'error', message: (reason instanceof Error ? reason.message : 'Stream failed').slice(0, 2048) }, transferables: [] });
    } finally {
      finish({ reason: reason ?? abortError() });
    }
  };
  const onAbort = () => abort({ reason: signal?.reason ?? abortError() });
  const channel = createValidatedMessagePort({
    port,
    incomingSchema: requestSchema,
    outgoingSchema: responseSchema,
    onError: abort,
    async onMessage({ message }) {
      if (finished) return;
      try {
        switch (message.type) {
        case 'cancel':
          finish({ reason: abortError() });
          return;
        case 'pull':
          if (pulling) throw new Error('Overlapping stream reads');
          pulling = true;
          break;
        default: {
          const exhaustive: never = message;
          throw new Error(`Unknown stream request: ${String(exhaustive)}`);
        }
        }
        if (!reader) {
          const stream = await openStream();
          if (finished) {
            void stream.cancel().catch(() => undefined);
            return;
          }
          reader = stream.getReader();
        }
        while (!remainder?.byteLength) {
          const result = await reader.read();
          if (finished) return;
          if (result.done) {
            channel.send({ message: { type: 'end' }, transferables: [] });
            finish({ reason: undefined });
            return;
          }
          if (!ArrayBuffer.isView(result.value) || Object.prototype.toString.call(result.value) !== '[object Uint8Array]') {
            throw new Error('Expected a byte stream');
          }
          remainder = result.value;
        }
        const bytes = new Uint8Array(Math.min(remainder.byteLength, BYTE_STREAM_CHUNK_BYTES));
        bytes.set(remainder.subarray(0, bytes.byteLength));
        remainder = remainder.subarray(bytes.byteLength);
        if (remainder.byteLength === 0) remainder = undefined;
        channel.send({ message: { type: 'chunk', bytes: bytes.buffer }, transferables: [bytes.buffer] });
      } catch (reason) {
        abort({ reason });
      } finally {
        pulling = false;
      }
    },
  });
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return { completed: completion.promise, abort };
}

export function receiveByteStream({ port }: { port: MessagePort }): {
  stream: ReadableStream<Uint8Array>,
  completed: Promise<void>,
  abort: ({ reason }: { reason: unknown }) => void,
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let finished = false;
  let pending: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const completion = Promise.withResolvers<void>();
  void completion.promise.catch(() => undefined);
  const finish = ({ reason }: { reason: unknown | undefined }) => {
    if (finished) return;
    finished = true;
    if (reason !== undefined) {
      channel.send({ message: { type: 'cancel' }, transferables: [] });
      completion.reject(reason);
    } else completion.resolve();
    channel.close();
    pending?.resolve();
    pending = undefined;
  };
  const abort = ({ reason }: { reason: unknown }) => {
    if (finished) return;
    const error = reason ?? abortError();
    controller.error(error);
    finish({ reason: error });
  };
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    pull() {
      if (finished) return;
      const request = Promise.withResolvers<void>();
      pending = request;
      channel.send({ message: { type: 'pull' }, transferables: [] });
      return request.promise;
    },
    cancel() {
      finish({ reason: abortError() });
    },
  }, { highWaterMark: 0 });
  const channel = createValidatedMessagePort({
    port,
    incomingSchema: responseSchema,
    outgoingSchema: requestSchema,
    onError: abort,
    onMessage({ message }) {
      if (finished) return;
      try {
        switch (message.type) {
        case 'error':
          abort({ reason: new Error(message.message) });
          return;
        case 'end':
          if (!pending) throw new Error('Unrequested stream end');
          controller.close();
          finish({ reason: undefined });
          return;
        case 'chunk':
          if (!pending || message.bytes.byteLength === 0 || message.bytes.byteLength > BYTE_STREAM_CHUNK_BYTES) {
            throw new Error('Invalid or unrequested stream chunk');
          }
          controller.enqueue(new Uint8Array(message.bytes));
          pending.resolve();
          pending = undefined;
          return;
        default: {
          const exhaustive: never = message;
          throw new Error(`Unknown stream response: ${String(exhaustive)}`);
        }
        }
      } catch (reason) {
        abort({ reason });
      }
    },
  });
  return { stream, completed: completion.promise, abort };
}

export const TEST_ONLY = {
};
