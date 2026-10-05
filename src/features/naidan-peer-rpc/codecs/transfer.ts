import { peerDocumentLimits } from '@/features/naidan-peer-rpc/contract';

/** These helpers bound integration payloads; RPC frame limits are a separate transport budget. */
export async function collectBytes({ readable, limit, signal }: { readable: ReadableStream<Uint8Array>; limit: number; signal: AbortSignal }): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid transfer limit');
  signal.throwIfAborted();
  const reader = readable.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); const item = await reader.read(); signal.throwIfAborted();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) throw new Error('Remote inference returned a non-byte chunk');
      if (item.value.byteLength === 0) continue;
      length += item.value.byteLength; if (length > limit) throw new Error('Remote inference transfer exceeds its limit');
      chunks.push(new Uint8Array(item.value));
    }
    const result = new Uint8Array(length); let at = 0;
    for (const bytes of chunks) {
      result.set(bytes, at); at += bytes.length;
    }
    return result;
  } catch (error) {
    await reader.cancel(error).catch(() => {}); throw error;
  } finally {
    signal.removeEventListener('abort', cancel); reader.releaseLock();
  }
}
export function bytesSource({ bytes }: { bytes: Uint8Array }): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({ pull(controller) {
    if (at === bytes.length) {
      controller.close(); return;
    }
    const end = Math.min(at + 16384, bytes.length); controller.enqueue(bytes.slice(at, end)); at = end;
  } }, { highWaterMark: 0 });
}
/** Starts computation on demand, preserves backpressure, and joins native cleanup on cancel. */
export function computationSource<T>({ signal, run }: { signal: AbortSignal; run: ({ emit, signal }: { emit: ({ value }: { value: T }) => Promise<void>; signal: AbortSignal }) => Promise<void> }): ReadableStream<T> {
  const controller = new AbortController();
  const pipe = new TransformStream<T, T>(); const writer = pipe.writable.getWriter(); const reader = pipe.readable.getReader();
  let job: Promise<void> | undefined; let stopped = false;
  const forward = () => {
    controller.abort(signal.reason); void writer.abort(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', forward, { once: true }); if (signal.aborted) forward();
  const cleanup = () => {
    signal.removeEventListener('abort', forward);
  };
  const start = () => {
    if (job) return;
    job = (async () => {
      try {
        controller.signal.throwIfAborted(); await run({ signal: controller.signal, emit: async ({ value }) => {
          controller.signal.throwIfAborted(); await writer.write(value);
        } }); await writer.close();
      } catch (error) {
        controller.abort(error); await writer.abort(error).catch(() => {});
      } finally {
        cleanup();
      }
    })();
  };
  return new ReadableStream<T>({
    async pull(output) {
      if (stopped) return; start(); const next = await reader.read(); if (stopped) return; if (next.done) output.close(); else output.enqueue(next.value);
    },
    async cancel(reason) {
      stopped = true; controller.abort(reason); cleanup(); await reader.cancel(reason).catch(() => {}); await job;
    },
  }, { highWaterMark: 0 });
}
/** Byte limits alone do not bound recursive JSON-schema work: deeply nested
 * tool parameters fit in a tiny transcript. Check shape iteratively before
 * trusted schema parsing (and before outbound JSON serialization). These are
 * document limits, not transport frame limits or native context limits. */
export function assertDocumentBounds({ value }: { value: unknown }): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 1;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > peerDocumentLimits.depth) throw new Error('Inference document depth limit exceeded');
    if (current.value === null || typeof current.value !== 'object') continue;
    for (const value of Object.values(current.value)) {
      if (++nodes > peerDocumentLimits.nodes) throw new Error('Inference document node limit exceeded');
      pending.push({ value, depth: current.depth + 1 });
    }
  }
}
export function encodeDocument({ value, limit }: { value: unknown; limit: number }): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid document limit');
  assertDocumentBounds({ value });
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('Inference document requires a JSON value');
  const bytes = new TextEncoder().encode(text); if (bytes.length > limit) throw new Error('Inference document exceeds its limit'); return bytes;
}
export function decodeDocument({ bytes }: { bytes: Uint8Array }): unknown {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  assertDocumentBounds({ value }); return value;
}
export const TEST_ONLY = {
};
