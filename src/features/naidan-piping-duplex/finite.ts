import { restrictedFetchHeadersSchema } from '@/utils/restricted-fetch-headers';
import { ownBytes, requireValue } from '@/features/naidan-piping-duplex/bytes';
export type AttemptKind = 'waiting-sender' | 'waiting-receiver' | 'established' | 'transient' | 'fatal';
export class AttemptError extends Error {
  readonly kind: AttemptKind;
  constructor({ kind }: {
        kind: AttemptKind;
    }) {
    super(`Piping attempt: ${kind}`); this.kind = kind;
  }
}
export class Deadline {
  readonly signal: AbortSignal;
  private internalController = new AbortController();
  private internalParent: AbortSignal;
  private internalListener: () => void;
  private internalTimer: ReturnType<typeof setTimeout>;
  constructor({ parent, milliseconds }: {
        parent: AbortSignal;
        milliseconds: number;
    }) {
    requireValue({ condition: Number.isInteger(milliseconds) && milliseconds > 0 && milliseconds <= 2147483647, message: 'Deadline duration' });
    this.internalParent = parent;
    this.signal = this.internalController.signal;
    this.internalListener = () => this.internalController.abort(parent.reason);
    this.internalTimer = setTimeout(() => this.internalController.abort(new Error('Attempt deadline')), milliseconds);
    parent.addEventListener('abort', this.internalListener, { once: true });
    if (parent.aborted)
      this.internalListener();
  }
  dispose(): void {
    clearTimeout(this.internalTimer); this.internalParent.removeEventListener('abort', this.internalListener); this.internalController.abort();
  }
  /** The automatic candidate was confirmed; retain parent cancellation without a deadline. */
  stopTimer(): void {
    clearTimeout(this.internalTimer);
  }
}
export async function sleep({ milliseconds, signal }: {
    milliseconds: number;
    signal: AbortSignal;
}): Promise<void> {
  requireValue({ condition: Number.isInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 2147483647, message: 'Timer duration' });
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup(); reject(signal.reason);
    };
    const timer = setTimeout(() => {
      cleanup(); resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export async function readBounded({ response, maxBytes }: {
    response: Response;
    maxBytes: number;
}): Promise<Uint8Array> {
  requireValue({ condition: Number.isInteger(maxBytes) && maxBytes >= 0 && maxBytes <= 65536, message: 'Read allocation bound' });
  if (!response.body)
    return new Uint8Array();
  const reader = response.body.getReader(), buffer = new Uint8Array(maxBytes);
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done)
        break;
      size += item.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => { });
        throw new AttemptError({ kind: 'transient' });
      }
      buffer.set(item.value, size - item.value.byteLength);
    }
    return buffer.slice(0, size);
  } finally {
    reader.releaseLock();
  }
}
export interface FiniteTransport {
    readonly origin: string;
    send({ route, bytes, signal }: {
        route: string;
        bytes: Uint8Array;
        signal: AbortSignal;
    }): Promise<void>;
    receive({ route, signal }: {
        route: string;
        signal: AbortSignal;
    }): Promise<Uint8Array>;
    repair({ route, signal }: {
        route: string;
        signal: AbortSignal;
    }): Promise<void>;
}
export class FiniteEndpoint implements FiniteTransport {
  private internalBase: string;
  private internalRepairTimeout: number;
  private internalSendOwned = false;
  private readonly headers: readonly { name: string; value: string }[];
  private retryWindowMs: number;
  constructor({ baseUrl, policy, timeoutMs, repairTimeoutMs, headers }: {
        baseUrl: string;
        policy: 'https-only' | 'allow-loopback-http';
        timeoutMs: number;
        repairTimeoutMs: number;
        headers?: { name: string; value: string }[];
    }) {
    requireValue({ condition: policy === 'https-only' || policy === 'allow-loopback-http', message: 'Invalid origin policy' });
    requireValue({ condition: Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647 &&
                Number.isInteger(repairTimeoutMs) && repairTimeoutMs > 0 && repairTimeoutMs <= 2147483647,
    message: 'Invalid attempt deadlines' });
    const url = new URL(baseUrl);
    requireValue({ condition: !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', message: 'Relay base must be an origin' });
    requireValue({ condition: url.protocol === 'https:' || (policy === 'allow-loopback-http' && url.protocol === 'http:' &&
                (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost')), message: 'HTTPS relay required' });
    this.headers = restrictedFetchHeadersSchema.parse(headers ?? []);
    this.retryWindowMs = timeoutMs;
    this.internalBase = url.origin;
    this.internalRepairTimeout = repairTimeoutMs;
  }
  get origin(): string {
    return this.internalBase;
  }
  private async internalRequest({ route, method, body, limit, timeout, signal, growWindow }: {
        route: string;
        method: 'POST' | 'GET';
        body: Uint8Array | undefined;
        limit: number;
        timeout: number;
        growWindow: boolean;
        signal: AbortSignal;
    }): Promise<Uint8Array> {
    signal.throwIfAborted();
    requireValue({ condition: /^[A-Za-z0-9_-]{1,96}$/.test(route), message: 'Invalid route' });
    const deadline = new Deadline({ parent: signal, milliseconds: timeout });
    try {
      const options: RequestInit = { method, signal: deadline.signal, credentials: 'omit', redirect: 'error',
        cache: 'no-store', referrerPolicy: 'no-referrer', mode: 'cors' };
      if (this.headers.length) options.headers = this.headers.map(({ name, value }) => [name, value]);
      if (body !== undefined)
        options.body = new Uint8Array(body);
      const response = await fetch(`${this.internalBase}/${route}`, options);
      if (response.status !== 200 && response.status !== 400) {
        // Headers determine the status without reading a diagnostic body.
        // Join cancellation before relinquishing this request's POST ownership.
        await response.body?.cancel().catch(() => {});
        throw new AttemptError({ kind: response.status === 408 || response.status === 429 || response.status >= 500
          ? 'transient' : 'fatal' });
      }
      const bytes = await readBounded({ response, maxBytes: response.status === 200 ? limit : 8192 });
      deadline.signal.throwIfAborted();
      if (response.status === 200)
        return bytes;
      const diagnostic = new TextDecoder().decode(bytes).trim();
      if (response.status === 400) {
        if (diagnostic === `[ERROR] Another sender has been connected on '/${route}'.`)
          throw new AttemptError({ kind: 'waiting-sender' });
        if (diagnostic === `[ERROR] Connection on '/${route}' has been established already.`)
          throw new AttemptError({ kind: 'established' });
        if (diagnostic === '[ERROR] The number of receivers has reached limits.')
          throw new AttemptError({ kind: 'waiting-receiver' });
        // An unfamiliar diagnostic must not turn temporary occupancy into a terminal session failure.
        throw new AttemptError({ kind: 'transient' });
      }
      throw new AttemptError({ kind: 'fatal' });
    } catch (error) {
      signal.throwIfAborted();
      // Attempt deadlines only rotate a stuck request. They never expire a living session.
      // Grow the next window instead of failing repeatedly on a consistently slow path.
      if (deadline.signal.aborted && growWindow)
        this.retryWindowMs = Math.min(Math.max(this.retryWindowMs, timeout * 2), 2147483647);
      if (error instanceof AttemptError)
        throw error;
      throw new AttemptError({ kind: 'transient' });
    } finally {
      deadline.dispose();
    }
  }
  async send({ route, bytes, signal }: {
        route: string;
        bytes: Uint8Array;
        signal: AbortSignal;
    }): Promise<void> {
    requireValue({ condition: !this.internalSendOwned, message: 'Concurrent POST/repair on one owner' });
    const copy = ownBytes({ bytes, maxBytes: 65536 });
    this.internalSendOwned = true;
    try {
      await this.internalRequest({ route, method: 'POST', body: copy, limit: 8192, timeout: this.retryWindowMs, signal, growWindow: true });
    } finally {
      this.internalSendOwned = false;
    }
  }
  receive({ route, signal }: {
        route: string;
        signal: AbortSignal;
    }): Promise<Uint8Array> {
    return this.internalRequest({ route, method: 'GET', body: undefined, limit: 65536, timeout: this.retryWindowMs, signal, growWindow: true });
  }
  async repair({ route, signal }: {
        route: string;
        signal: AbortSignal;
    }): Promise<void> {
    requireValue({ condition: !this.internalSendOwned, message: 'Concurrent POST/repair on one owner' });
    this.internalSendOwned = true;
    try {
      await this.internalRequest({ route, method: 'GET', body: undefined, limit: 65536, timeout: this.internalRepairTimeout, signal, growWindow: false });
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof AttemptError) || error.kind === 'fatal')
        throw error;
    } finally {
      this.internalSendOwned = false;
    }
  }
}



export function needsSenderRepair({ kind }: { kind: AttemptKind }): boolean {
  switch (kind) {
  case 'waiting-sender': return true;
  case 'waiting-receiver': case 'established': case 'transient': case 'fatal': return false;
  default: { const unreachable: never = kind; throw new Error(`Invalid attempt kind: ${unreachable}`); }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
