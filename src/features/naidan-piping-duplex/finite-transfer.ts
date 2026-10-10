import { restrictedFetchHeadersSchema } from '@/utils/restricted-fetch-headers';
import { ownBytes, requireValue } from '@/features/naidan-piping-duplex/bytes';
import { AttemptError, Deadline } from '@/features/naidan-piping-duplex/finite';
import { BATCH_BYTES } from '@/features/naidan-piping-duplex/batch-wire';
import { AuthenticatedProtocolError, RecordExhaustedError, ResponseUnconfirmedError, PipingRetirementError } from '@/features/naidan-piping-duplex/lifetime';

/** One bounded cursor. Never preallocates a peer-declared length or retains an unbounded body. */
export class BoundedBody {
  private chunk: Uint8Array = new Uint8Array();
  private offset = 0;
  private received = 0;
  private done = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly maximum: number;
  private readonly signal: AbortSignal;

  constructor({ reader, maximum, signal }: { reader: ReadableStreamDefaultReader<Uint8Array>; maximum: number; signal: AbortSignal }) {
    this.reader = reader; this.maximum = maximum; this.signal = signal;
  }

  private async fill(): Promise<void> {
    this.signal.throwIfAborted();
    while (!this.done && this.offset === this.chunk.length) {
      const item = await this.reader.read(); this.signal.throwIfAborted();
      if (item.done) {
        this.done = true; this.chunk = new Uint8Array(); this.offset = 0; return;
      }
      requireValue({ condition: item.value instanceof Uint8Array && item.value.buffer instanceof ArrayBuffer && item.value.length <= this.maximum - this.received, message: 'Finite response exceeds limit' });
      this.received += item.value.length; this.chunk = item.value; this.offset = 0;
    }
  }

  async take({ size }: { size: number }): Promise<Uint8Array<ArrayBuffer>> {
    requireValue({ condition: Number.isSafeInteger(size) && size >= 0 && size <= this.maximum, message: 'Invalid finite read size' });
    const result = new Uint8Array(size); let offset = 0;
    while (offset < size) {
      await this.fill(); requireValue({ condition: !this.done, message: 'Truncated finite response' });
      const amount = Math.min(size - offset, this.chunk.length - this.offset);
      result.set(this.chunk.subarray(this.offset, this.offset + amount), offset); offset += amount; this.offset += amount;
    }
    return result;
  }

  async end(): Promise<void> {
    await this.fill(); requireValue({ condition: this.done, message: 'Trailing bytes in finite response' });
  }

  async all(): Promise<Uint8Array<ArrayBuffer>> {
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      await this.fill(); if (this.done) break;
      const bytes = this.chunk.slice(this.offset); chunks.push(bytes); size += bytes.length; this.offset = this.chunk.length;
    }
    const result = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset); offset += chunk.length;
    }
    return result;
  }
}

export class PipingStatusError extends AttemptError {
  readonly status: number;

  constructor({ status }: { status: number }) {
    super({ kind: status === 400 || status === 408 || status === 429 || status >= 500 ? 'transient' : 'fatal' });
    this.status = status; this.message = `Piping HTTP status: ${status}`;
  }
}

export interface FiniteTransfer {
  readonly origin: string;
  send({ route, bytes, signal, timeoutMs }: { route: string; bytes: Uint8Array; signal: AbortSignal; timeoutMs?: number | null }): Promise<void>;
  receive({ route, maximum, signal, timeoutMs }: { route: string; maximum: number; signal: AbortSignal; timeoutMs?: number | null }): Promise<Uint8Array>;
  read<T>({ route, maximum, signal, consume, timeoutMs }: {
    route: string; maximum: number; signal: AbortSignal; timeoutMs?: number | null; consume({ body }: { body: BoundedBody }): Promise<T>;
  }): Promise<T>;
}

/** One GET and one POST at a time. No retry, path repair, diagnostic parsing, or timeout growth. */
export class FiniteTransferEndpoint implements FiniteTransfer {
  readonly origin: string;
  private readonly headers: readonly { name: string; value: string }[];
  private readonly timeoutMs: number;
  private sending = false;
  private receiving = false;

  constructor({ baseUrl, policy, timeoutMs, headers }: {
    baseUrl: string; policy: 'https-only' | 'allow-loopback-http'; timeoutMs: number; headers?: { name: string; value: string }[];
  }) {
    requireValue({ condition: Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647, message: 'Invalid finite deadline' });
    requireValue({ condition: policy === 'https-only' || policy === 'allow-loopback-http', message: 'Invalid relay policy' });
    const url = new URL(baseUrl);
    requireValue({ condition: !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', message: 'Relay base must be an origin' });
    requireValue({ condition: url.protocol === 'https:' || (policy === 'allow-loopback-http' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)), message: 'HTTPS relay required' });
    this.origin = url.origin; this.timeoutMs = timeoutMs; this.headers = restrictedFetchHeadersSchema.parse(headers ?? []);
  }

  private async request<T>({ route, method, bytes, maximum, signal, consume, timeoutMs }: {
    route: string; method: 'POST' | 'GET'; bytes?: Uint8Array; maximum: number; signal: AbortSignal; timeoutMs?: number | null;
    consume({ body }: { body: BoundedBody }): Promise<T>;
  }): Promise<T> {
    signal.throwIfAborted();
    requireValue({ condition: /^[A-Za-z0-9_-]{1,96}$/.test(route) && Number.isInteger(maximum) && maximum >= 0 && maximum <= BATCH_BYTES, message: 'Invalid finite request' });
    const deadline = timeoutMs === null ? { signal, dispose() {} } : new Deadline({ parent: signal, milliseconds: timeoutMs ?? this.timeoutMs });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancellation: Promise<void> | undefined;
    let cancellationFailure: { error: unknown } | undefined;
    let terminal: { kind: 'ended' } | { kind: 'errored'; error: unknown } | undefined;
    let complete = false;
    let failure: { error: unknown } | undefined;
    let result: { value: T } | undefined;
    const cancel = () => {
      if (reader && !cancellation && !terminal) {
        cancellation = reader.cancel(deadline.signal.reason).catch(error => {
          // Cancelling an already-errored native stream repeats its read error;
          // it is not failure to retire an owned request. Underlying cancel
          // rejection with a closed (non-errored) reader remains a hard failure.
          if (terminal?.kind !== 'errored' || terminal.error !== error) cancellationFailure = { error };
        });
      }
    };
    deadline.signal.addEventListener('abort', cancel, { once: true });
    try {
      const response = await fetch(`${this.origin}/${route}`, {
        method,
        body: bytes === undefined ? undefined : new Uint8Array(bytes),
        signal: deadline.signal,
        headers: this.headers.map(({ name, value }) => [name, value]),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        mode: 'cors',
      });
      // Own the body before observing late cancellation or a non-200 status.
      if (response.body) {
        reader = response.body.getReader();
        void reader.closed.then(() => {
          terminal = { kind: 'ended' };
        }, error => {
          terminal = { kind: 'errored', error };
        });
      }
      if (deadline.signal.aborted) {
        cancel(); deadline.signal.throwIfAborted();
      }
      if (response.status !== 200) throw new PipingStatusError({ status: response.status });
      const input = reader ?? new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }).getReader();
      reader = input;
      const body = new BoundedBody({ reader: input, maximum, signal: deadline.signal });
      const value = await consume({ body }); await body.end(); deadline.signal.throwIfAborted(); complete = true;
      result = { value };
    } catch (error) {
      // Status diagnostics and malformed transport bodies are not authenticated peer statements.
      const preserved = signal.aborted || error instanceof AttemptError || error instanceof AuthenticatedProtocolError || error instanceof RecordExhaustedError || error instanceof ResponseUnconfirmedError;
      failure = { error: signal.aborted ? signal.reason : preserved ? error : new AttemptError({ kind: 'transient' }) };
    } finally {
      if (!complete) cancel();
      await cancellation;
      reader?.releaseLock();
      deadline.signal.removeEventListener('abort', cancel); deadline.dispose();
    }
    if (cancellationFailure) throw new PipingRetirementError({ cause: cancellationFailure.error, logicalError: failure?.error });
    if (failure) throw failure.error;
    return result!.value;
  }

  async send({ route, bytes, signal, timeoutMs }: { route: string; bytes: Uint8Array; signal: AbortSignal; timeoutMs?: number | null }): Promise<void> {
    requireValue({ condition: !this.sending, message: 'Concurrent finite POST' });
    const snapshot = ownBytes({ bytes, maxBytes: BATCH_BYTES }); this.sending = true;
    try {
      await this.request({
        route,
        method: 'POST',
        bytes: snapshot,
        maximum: 8192,
        signal,
        timeoutMs,
        consume: async ({ body }) => {
          await body.all();
        },
      });
    } finally {
      this.sending = false;
    }
  }

  async read<T>({ route, maximum, signal, consume, timeoutMs }: {
    route: string; maximum: number; signal: AbortSignal; timeoutMs?: number | null; consume({ body }: { body: BoundedBody }): Promise<T>;
  }): Promise<T> {
    requireValue({ condition: !this.receiving, message: 'Concurrent finite GET' }); this.receiving = true;
    try {
      return await this.request({ route, method: 'GET', maximum, signal, timeoutMs, consume });
    } finally {
      this.receiving = false;
    }
  }

  receive({ route, maximum, signal, timeoutMs }: { route: string; maximum: number; signal: AbortSignal; timeoutMs?: number | null }): Promise<Uint8Array> {
    return this.read({ route, maximum, signal, timeoutMs, consume: ({ body }) => body.all() });
  }
}

export const TEST_ONLY = {
};
