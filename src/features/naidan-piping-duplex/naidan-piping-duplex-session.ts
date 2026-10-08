import type { LivenessPolicy } from '@/features/naidan-piping-duplex/private-responses';
import { PipingRetirementError } from '@/features/naidan-piping-duplex/lifetime';
import type { NaidanPipingConnectionEnd } from '@/features/naidan-piping-duplex/lifetime';
import { z } from 'zod';
import { restrictedFetchHeadersSchema } from '@/utils/restricted-fetch-headers';
import { ascii, ownBytes } from '@/features/naidan-piping-duplex/bytes';
import { startPinnedConnection } from '@/features/naidan-piping-duplex/connection';
import type { PinnedConnectionTask } from '@/features/naidan-piping-duplex/connection';
import { FiniteEndpoint } from '@/features/naidan-piping-duplex/finite';
import type { NaidanPipingKeyContext, NaidanPipingPeerVerifier } from '@/features/naidan-piping-duplex/key-context';
import type { NaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import type { NaidanPipingRole } from '@/features/naidan-piping-duplex/role';
import { runDuplex, validatePacing } from '@/features/naidan-piping-duplex/runner';
import type { NaidanPipingDuplexPacing } from '@/features/naidan-piping-duplex/runner';
import { StreamSession } from '@/features/naidan-piping-duplex/session';
import type { NaidanPipingDuplexStream } from '@/features/naidan-piping-duplex/session';

export type NaidanPipingDuplexOptions = {
  baseUrl: string;
  policy: 'https-only' | 'allow-loopback-http';
  requestTimeoutMs: number;
  repairTimeoutMs: number;
  candidateConfirmationTimeoutMs: number;
  handshakeResponseTimeoutMs: number;
  liveness: LivenessPolicy;
  headers?: { name: string; value: string }[];
  pacing: NaidanPipingDuplexPacing;
};

const duration = z.number().int().min(1).max(2147483647);
const optionsSchema = z.strictObject({
  baseUrl: z.string(),
  policy: z.enum(['https-only', 'allow-loopback-http']),
  requestTimeoutMs: duration,
  repairTimeoutMs: duration,
  candidateConfirmationTimeoutMs: duration,
  handshakeResponseTimeoutMs: duration,
  liveness: z.strictObject({ intervalMs: duration, responseTimeoutMs: duration }),
  headers: restrictedFetchHeadersSchema.optional(),
  pacing: z.strictObject({
    minimumMs: duration,
    idleResendIntervalMs: duration,
    retryBaseMs: duration,
    retryMaximumMs: duration,
  }),
});

/** An owned, pinned-peer Piping connection. It does not trust peers based on a short code alone. */
export class NaidanPipingDuplexSession {
  private readonly streams: StreamSession;
  private readonly keys: NaidanPipingKeyContext;
  private readonly stop: AbortController;
  private readonly publicData: Uint8Array;
  private readonly privateData: Uint8Array;
  /** Settles after all locally owned I/O has stopped. It is not a peer-delivery acknowledgement. */
  readonly closed: Promise<void>;
  readonly ended: Promise<NaidanPipingConnectionEnd>;

  private constructor({ streams, keys, stop, endpoint, pacing, bootstrapClosed, signal, forward, liveness, peerPublicHandshakeData, peerHandshakeData }: {
    liveness: LivenessPolicy;
    peerPublicHandshakeData: Uint8Array; peerHandshakeData: Uint8Array;
    streams: StreamSession;
    keys: NaidanPipingKeyContext;
    stop: AbortController;
    endpoint: FiniteEndpoint;
    pacing: NaidanPipingDuplexPacing;
    bootstrapClosed: Promise<void>;
    signal: AbortSignal;
    forward: () => void;
  }) {
    this.publicData = peerPublicHandshakeData; this.privateData = peerHandshakeData;
    this.streams = streams;
    this.ended = streams.ended;
    this.keys = keys;
    this.stop = stop;
    const failures: unknown[] = [];
    const stopStreams = () => {
      // Abort listeners must not throw out of event dispatch and lose cleanup failures.
      try {
        streams.fail({ kind: 'local-stop', error: stop.signal.reason });
      } catch (error) {
        failures.push(error);
      }
      try {
        keys.dispose();
      } catch (error) {
        failures.push(error);
      }
    };
    stop.signal.addEventListener('abort', stopStreams, { once: true });
    if (stop.signal.aborted) stopStreams();
    streams.startResponses({ policy: liveness });
    const traffic = runDuplex({ session: streams, endpoint, signal: stop.signal, pacing, onEvent: () => {} });
    this.closed = (async () => {
      try {
        await traffic;
      } catch (error) {
        // runDuplex has already joined its jobs. Preserve logical failure in
        // ended; only an explicit retirement failure poisons this barrier.
        if (error instanceof PipingRetirementError) failures.push(error);
        try {
          streams.fail({ kind: 'transport-fatal', error });
        } catch (failure) {
          failures.push(failure);
        }
      }
      try {
        stop.abort(streams.failureReason);
      } catch (error) {
        failures.push(error);
      }
      try {
        await bootstrapClosed;
      } catch (error) {
        failures.push(error);
      }
      try {
        stopStreams();
      } catch (error) {
        failures.push(error);
      }
      try {
        streams.retireResponses();
      } catch (error) {
        failures.push(error);
      }
      peerPublicHandshakeData.fill(0); peerHandshakeData.fill(0);
      stop.signal.removeEventListener('abort', stopStreams);
      signal.removeEventListener('abort', forward);
      if (failures.length) throw new PipingRetirementError({ cause: failures[0], logicalError: streams.failureReason });
    })();
    // Observing the separate lifetime promise is optional; never create an unhandled rejection.
    void this.closed.catch(() => {});
  }

  private static async connectInternal({ piping, code, role, identity, expectedPeer, verifyPeer, signal, publicHandshakeData, handshakeData }: {
    publicHandshakeData?: Uint8Array; handshakeData?: Uint8Array;
    piping: NaidanPipingDuplexOptions;
    code: string;
    role: NaidanPipingRole | undefined;
    identity: NaidanPipingIdentity;
    expectedPeer: Uint8Array | undefined;
    verifyPeer: NaidanPipingPeerVerifier | undefined;
    signal: AbortSignal;
  }): Promise<NaidanPipingDuplexSession> {
    const publicData = ownBytes({ bytes: publicHandshakeData === undefined ? new Uint8Array() : publicHandshakeData, maxBytes: 256 });
    const privateData = ownBytes({ bytes: handshakeData === undefined ? new Uint8Array() : handshakeData, maxBytes: 463 });
    signal.throwIfAborted();
    // Zod returns a private options snapshot before the first asynchronous boundary.
    const settings = optionsSchema.parse(piping);
    validatePacing({ pacing: settings.pacing });
    const localIdentity = { privateKey: identity.privateKey, publicKey: ownBytes({ bytes: identity.publicKey, maxBytes: 32 }) };
    const pin = expectedPeer === undefined ? undefined : ownBytes({ bytes: expectedPeer, maxBytes: 32 });
    const endpointOptions = {
      baseUrl: settings.baseUrl,
      policy: settings.policy,
      timeoutMs: settings.requestTimeoutMs,
      repairTimeoutMs: settings.repairTimeoutMs,
      headers: settings.headers,
    };
    // The final handshake flight and application traffic have independent POST ownership.
    const bootstrapEndpoint = new FiniteEndpoint(endpointOptions);
    const trafficEndpoint = new FiniteEndpoint(endpointOptions);
    const stop = new AbortController();
    const forward = () => stop.abort(signal.reason);
    signal.addEventListener('abort', forward, { once: true });
    if (signal.aborted) forward();
    let bootstrap: PinnedConnectionTask | undefined;
    let keys: NaidanPipingKeyContext | undefined;
    let streams: StreamSession | undefined;
    let connection: NaidanPipingDuplexSession | undefined;
    let peerPublicData: Uint8Array | undefined, peerPrivateData: Uint8Array | undefined;
    try {
      bootstrap = await startPinnedConnection({
        publicHandshakeData: publicData,
        handshakeData: privateData,
        role,
        identity: localIdentity,
        expectedPeer: pin,
        verifyPeer,
        code,
        endpoint: bootstrapEndpoint,
        signal: stop.signal,
        responseTimeoutMs: settings.handshakeResponseTimeoutMs,
        confirmationTimeoutMs: settings.candidateConfirmationTimeoutMs,
        intervalMs: settings.pacing.minimumMs,
        // A different stream profile must fail authentication, not silently produce two idle routes.
        purpose: ascii({ text: 'naidan-piping-streams/v3' }),
      });
      const established = await bootstrap.ready;
      keys = established.keys; peerPublicData = established.peerPublicHandshakeData; peerPrivateData = established.peerHandshakeData;
      stop.signal.throwIfAborted();
      streams = await StreamSession.create({ keys });
      stop.signal.throwIfAborted();
      connection = new NaidanPipingDuplexSession({
        streams,
        keys,
        stop,
        endpoint: trafficEndpoint,
        pacing: settings.pacing,
        bootstrapClosed: bootstrap.closed,
        signal,
        forward,
        liveness: settings.liveness,
        peerPublicHandshakeData: peerPublicData,
        peerHandshakeData: peerPrivateData,
      });
      await streams.firstResponse;
      await bootstrap.retire();
      stop.signal.throwIfAborted();
      if (streams.failureReason) throw streams.failureReason;
      return connection;
    } catch (error) {
      // Once keys are owned, a parent stop may precede a late local setup error.
      const original = streams?.failureReason ?? (keys !== undefined && stop.signal.aborted ? stop.signal.reason : error);
      const failures: unknown[] = [];
      for (const dispose of [() => stop.abort(original), () => streams?.fail({ kind: 'local-stop', error: original }), () => keys?.dispose()]) {
        try {
          dispose();
        } catch (failure) {
          failures.push(failure);
        }
      }
      try {
        if (connection) await connection.closed; else await bootstrap?.closed;
      } catch (failure) {
        failures.push(failure);
      }
      try {
        if (!connection) streams?.retireResponses();
      } catch (failure) {
        failures.push(failure);
      }
      signal.removeEventListener('abort', forward);
      peerPublicData?.fill(0); peerPrivateData?.fill(0);
      if (failures.length) throw new PipingRetirementError({ cause: failures[0], logicalError: original instanceof PipingRetirementError ? original.logicalError : original });
      throw original;
    } finally {
      publicData.fill(0); privateData.fill(0);
    }
  }

  static connect({ piping, code, role, identity, expectedPeer, signal, publicHandshakeData, handshakeData }: {
    publicHandshakeData?: Uint8Array; handshakeData?: Uint8Array;
    piping: NaidanPipingDuplexOptions; code: string; role: NaidanPipingRole;
    identity: NaidanPipingIdentity; expectedPeer: Uint8Array; signal: AbortSignal;
  }): Promise<NaidanPipingDuplexSession> {
    return this.connectInternal({ piping, code, role, identity, expectedPeer, verifyPeer: undefined, signal, publicHandshakeData, handshakeData });
  }
  static pair({ piping, code, identity, verifyPeer, signal, publicHandshakeData, handshakeData }: {
    publicHandshakeData?: Uint8Array; handshakeData?: Uint8Array;
    piping: NaidanPipingDuplexOptions; code: string;
    identity: NaidanPipingIdentity; verifyPeer: NaidanPipingPeerVerifier; signal: AbortSignal;
  }): Promise<NaidanPipingDuplexSession> {
    return this.connectInternal({ piping, code, role: undefined, identity, expectedPeer: undefined, verifyPeer, signal, publicHandshakeData, handshakeData });
  }
  /** Authenticated opaque bytes. Each read returns a copy; unavailable after shutdown. */
  get peerPublicHandshakeData(): Uint8Array {
    this.stop.signal.throwIfAborted(); return this.publicData.slice();
  }
  get peerHandshakeData(): Uint8Array {
    this.stop.signal.throwIfAborted(); return this.privateData.slice();
  }
  get peerIdentity(): Uint8Array {
    return this.keys.peerIdentity;
  }
  get incomingStreams(): AsyncIterable<NaidanPipingDuplexStream> {
    return this.streams.incomingStreams;
  }
  openStream({ signal }: { signal: AbortSignal | undefined }): Promise<NaidanPipingDuplexStream> {
    return this.streams.openStream({ signal });
  }
  /** Stop new streams, then wait for local protocol termination; unread data is preserved. */
  drain({ signal }: { signal: AbortSignal | undefined }): Promise<void> {
    return this.streams.drain({ signal });
  }
  /** Abort all streams and transports. Await closed to observe completion of local cleanup. */
  abort({ reason }: { reason: string }): void {
    this.stop.abort(new Error(reason));
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
