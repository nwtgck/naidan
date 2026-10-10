import { preparePinnedKeys } from '@/features/naidan-piping-duplex/pinned-contact';
import { ownBytes, requireValue } from '@/features/naidan-piping-duplex/bytes';
import type { ReceiveLimits } from '@/features/naidan-piping-duplex/batch-wire';
import { validateReceiveLimits } from '@/features/naidan-piping-duplex/batch-wire';
import { FiniteTransferEndpoint } from '@/features/naidan-piping-duplex/finite-transfer';
import { pairKeys } from '@/features/naidan-piping-duplex/finite-handshake';
import type { NaidanPipingPeerVerifier } from '@/features/naidan-piping-duplex/key-context';
import { PipingRetirementError } from '@/features/naidan-piping-duplex/lifetime';
import type { NaidanPipingConnectionEnd } from '@/features/naidan-piping-duplex/lifetime';
import type { NaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import { DEFAULT_LIVENESS, DEFAULT_RECEIVE_LIMITS, OrderedSession, validateLiveness } from '@/features/naidan-piping-duplex/ordered-session';
import type { ConnectionHealth, LivenessOptions } from '@/features/naidan-piping-duplex/ordered-session';
import type { NaidanPipingRole } from '@/features/naidan-piping-duplex/role';
import type { MultiplexedStream } from '@/features/naidan-piping-duplex/stream-mux';

export type NaidanPipingDuplexOptions = {
  baseUrl: string;
  policy: 'https-only' | 'allow-loopback-http';
  requestTimeoutMs: number;
  handshakeResponseTimeoutMs: number;
  headers?: { name: string; value: string }[];
  liveness?: LivenessOptions;
  receiveLimits?: ReceiveLimits;
};
type ConnectionInput = {
  piping: NaidanPipingDuplexOptions; identity: NaidanPipingIdentity; signal: AbortSignal;
  publicHandshakeData?: Uint8Array; handshakeData?: Uint8Array;
};
export type PreparedPinnedConnection = {
  readonly kind: 'candidate';
  readonly peerPublicHandshakeData: Uint8Array;
  assertAvailable(): void;
  finish(): Promise<NaidanPipingDuplexSession>;
  dispose(): Promise<void>;
};


/** A single finite-body, authenticated connection. Never reconnects or replaces itself. */
export class NaidanPipingDuplexSession {
  private readonly connection: OrderedSession;
  private readonly publicData: Uint8Array;
  private readonly privateData: Uint8Array;
  private retired = false;
  readonly ended: Promise<NaidanPipingConnectionEnd>;
  readonly closed: Promise<void>;

  private constructor({ connection, publicData, privateData }: {
    connection: OrderedSession; publicData: Uint8Array; privateData: Uint8Array;
  }) {
    this.connection = connection; this.publicData = publicData; this.privateData = privateData;
    this.ended = connection.ended;
    this.closed = connection.closed.finally(() => {
      this.retired = true; publicData.fill(0); privateData.fill(0);
    });
    void this.closed.catch(() => {});
  }

  private static async connectInternal({ piping, identity, signal, publicHandshakeData, handshakeData, code, role, verifyPeer }: ConnectionInput & {
    code: string; role: NaidanPipingRole | undefined; verifyPeer: NaidanPipingPeerVerifier;
  }): Promise<NaidanPipingDuplexSession> {
    signal.throwIfAborted();
    // Snapshot caller-owned settings and bytes before the first asynchronous step.
    const local = { privateKey: identity.privateKey, publicKey: ownBytes({ bytes: identity.publicKey, maxBytes: 32 }) };
    const publicData = ownBytes({ bytes: publicHandshakeData ?? new Uint8Array(), maxBytes: 256 });
    const privateData = ownBytes({ bytes: handshakeData ?? new Uint8Array(), maxBytes: 16384 });
    const limits = validateReceiveLimits({ limits: piping.receiveLimits ?? DEFAULT_RECEIVE_LIMITS });
    const liveness = validateLiveness({ liveness: piping.liveness ?? DEFAULT_LIVENESS });
    const responseTimeoutMs = piping.handshakeResponseTimeoutMs;
    requireValue({ condition: Number.isInteger(responseTimeoutMs) && responseTimeoutMs > 0 && responseTimeoutMs <= 2147483647, message: 'Invalid handshake response deadline' });
    const endpointOptions = { baseUrl: piping.baseUrl, policy: piping.policy, timeoutMs: piping.requestTimeoutMs, headers: piping.headers };
    // Handshake and traffic never overlap. Separate endpoints have no shared
    // ownership counters and are both validated before any network operation.
    const bootstrap = new FiniteTransferEndpoint({ ...endpointOptions, timeoutMs: Math.min(piping.requestTimeoutMs, responseTimeoutMs) });
    const traffic = new FiniteTransferEndpoint(endpointOptions);
    let established: Awaited<ReturnType<typeof pairKeys>> | undefined;
    let connection: OrderedSession | undefined;
    try {
      const common = { endpoint: bootstrap, identity: local, signal, responseTimeoutMs, publicHandshakeData: publicData, handshakeData: privateData };
      established = await pairKeys({ ...common, code, role, verifyPeer });
      signal.throwIfAborted();
      connection = await OrderedSession.create({ keys: established.keys, endpoint: traffic, signal, limits, liveness });
      signal.throwIfAborted();
      return new NaidanPipingDuplexSession({ connection, publicData: established.peerPublicHandshakeData, privateData: established.peerHandshakeData });
    } catch (error) {
      if (connection) {
        connection.abort({ reason: 'Connection publication cancelled' });
        try {
          await connection.closed;
        } catch (cause) {
          throw new PipingRetirementError({ cause, logicalError: error });
        }
      } else established?.keys.dispose();
      established?.peerPublicHandshakeData.fill(0); established?.peerHandshakeData.fill(0);
      throw error;
    } finally {
      publicData.fill(0); privateData.fill(0);
    }
  }

  /** One bounded authentication candidate. Its signal must belong to the
   * connection intent, not to the DATA session that it may replace. */
  static async preparePinnedContact({ piping, identity, expectedPeer, purpose = 'naidan-piping-duplex/v1', signal, publicHandshakeData, handshakeData, heldContext }: ConnectionInput & {
    expectedPeer: Uint8Array; purpose?: string; heldContext: Uint8Array | undefined;
  }): Promise<PreparedPinnedConnection | { kind: 'same-connection' }> {
    signal.throwIfAborted();
    const limits = validateReceiveLimits({ limits: piping.receiveLimits ?? DEFAULT_RECEIVE_LIMITS });
    const liveness = validateLiveness({ liveness: piping.liveness ?? DEFAULT_LIVENESS });
    const configuredDeadline = piping.handshakeResponseTimeoutMs;
    requireValue({ condition: Number.isInteger(configuredDeadline) && configuredDeadline > 0 && configuredDeadline <= 2147483647, message: 'Invalid handshake response deadline' });
    const responseTimeoutMs = Math.min(5000, configuredDeadline);
    const options = { baseUrl: piping.baseUrl, policy: piping.policy, timeoutMs: piping.requestTimeoutMs, headers: piping.headers };
    const bootstrap = new FiniteTransferEndpoint({ ...options, timeoutMs: Math.min(options.timeoutMs, responseTimeoutMs) });
    const traffic = new FiniteTransferEndpoint(options);
    const prepared = await preparePinnedKeys({
      endpoint: bootstrap,
      identity,
      expectedPeer,
      purpose,
      signal,
      responseTimeoutMs,
      publicHandshakeData: publicHandshakeData ?? new Uint8Array(),
      handshakeData: handshakeData ?? new Uint8Array(),
      heldContext,
    });
    switch (prepared.kind) {
    case 'same-connection': return prepared;
    case 'candidate': break;
    default: { const exhaustive: never = prepared; throw new Error(String(exhaustive)); }
    }
    return {
      kind: 'candidate',
      assertAvailable: () => prepared.assertAvailable(),
      get peerPublicHandshakeData() {
        return prepared.peerPublicHandshakeData;
      },
      dispose: () => prepared.dispose(),
      finish: async () => {
        const established = await prepared.finish();
        // READY is still connection setup, not a potentially slow bulk DATA body.
        const readyStop = new AbortController(), readySignal = AbortSignal.any([signal, readyStop.signal]);
        const readyDeadline = setTimeout(() => readyStop.abort(new Error('Contact READY deadline exceeded')), responseTimeoutMs);
        let connection: OrderedSession | undefined;
        try {
          signal.throwIfAborted();
          connection = await OrderedSession.create({ keys: established.keys, endpoint: traffic, signal: readySignal, limits, liveness });
          signal.throwIfAborted();
          return new NaidanPipingDuplexSession({ connection, publicData: established.peerPublicHandshakeData, privateData: established.peerHandshakeData });
        } catch (error) {
          if (connection) {
            connection.abort({ reason: 'Contact publication cancelled' });
            try {
              await connection.closed;
            } catch (cause) {
              throw new PipingRetirementError({ cause, logicalError: error });
            }
          } else established.keys.dispose();
          established.peerPublicHandshakeData.fill(0); established.peerHandshakeData.fill(0);
          throw error;
        } finally {
          clearTimeout(readyDeadline);
        }
      },
    };
  }

  static async connectPinned({ ...input }: ConnectionInput & { expectedPeer: Uint8Array; purpose?: string }): Promise<NaidanPipingDuplexSession> {
    const prepared = await this.preparePinnedContact({ ...input, heldContext: undefined });
    switch (prepared.kind) {
    case 'candidate': return prepared.finish();
    case 'same-connection': throw new Error('New contact unexpectedly retained a connection');
    default: { const exhaustive: never = prepared; throw new Error(String(exhaustive)); }
    }
  }

  static pair({ code, role, verifyPeer, ...input }: ConnectionInput & {
    code: string; role?: NaidanPipingRole; verifyPeer: NaidanPipingPeerVerifier;
  }): Promise<NaidanPipingDuplexSession> {
    return this.connectInternal({ ...input, code, role, verifyPeer });
  }

  get peerPublicHandshakeData(): Uint8Array {
    requireValue({ condition: !this.retired, message: 'Connection retired' }); return this.publicData.slice();
  }

  get peerHandshakeData(): Uint8Array {
    requireValue({ condition: !this.retired, message: 'Connection retired' }); return this.privateData.slice();
  }

  get contextId(): Uint8Array {
    return this.connection.contextId;
  }

  get peerIdentity(): Uint8Array {
    return this.connection.peerIdentity;
  }

  get health(): ConnectionHealth {
    return this.connection.health;
  }

  subscribeHealth({ listener }: { listener({ health }: { health: ConnectionHealth }): void }): () => void {
    return this.connection.subscribeHealth({ listener });
  }

  get incomingStreams(): AsyncIterable<MultiplexedStream> {
    return this.connection.incomingStreams;
  }

  openStream({ signal }: { signal: AbortSignal | undefined }): Promise<MultiplexedStream> {
    return this.connection.openStream({ signal });
  }

  drain({ signal }: { signal: AbortSignal | undefined }): Promise<void> {
    return this.connection.drain({ signal });
  }

  close({ noticeTimeoutMs, signal }: { noticeTimeoutMs?: number; signal: AbortSignal | undefined }): Promise<{ notification: 'acknowledged' | 'unconfirmed' }> {
    return this.connection.close({ noticeTimeoutMs, signal });
  }

  abort({ reason }: { reason: string }): void {
    this.connection.abort({ reason });
  }
}

export const TEST_ONLY = {
};
