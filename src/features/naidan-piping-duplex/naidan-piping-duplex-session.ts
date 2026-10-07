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
  handshakeRetentionMs: number | undefined;
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
  handshakeRetentionMs: duration.optional(),
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
  /** Settles after all locally owned I/O has stopped. It is not a peer-delivery acknowledgement. */
  readonly closed: Promise<void>;

  private constructor({ streams, keys, stop, endpoint, pacing, bootstrap, signal, forward }: {
    streams: StreamSession;
    keys: NaidanPipingKeyContext;
    stop: AbortController;
    endpoint: FiniteEndpoint;
    pacing: NaidanPipingDuplexPacing;
    bootstrap: PinnedConnectionTask;
    signal: AbortSignal;
    forward: () => void;
  }) {
    this.streams = streams;
    this.keys = keys;
    this.stop = stop;
    const stopStreams = () => {
      streams.abort({ reason: 'Piping session stopped' });
      keys.dispose();
    };
    stop.signal.addEventListener('abort', stopStreams, { once: true });
    if (stop.signal.aborted) stopStreams();
    const traffic = runDuplex({ session: streams, endpoint, signal: stop.signal, pacing, onEvent: () => {} });
    this.closed = (async () => {
      try {
        await traffic;
      } finally {
        stop.abort();
        // After readiness, failed bootstrap cleanup cannot revoke already authenticated traffic.
        // A peer that missed the last confirmation still needs to time out independently.
        await bootstrap.completion.catch(() => {});
        stopStreams();
        stop.signal.removeEventListener('abort', stopStreams);
        signal.removeEventListener('abort', forward);
      }
    })();
    // Observing the separate lifetime promise is optional; never create an unhandled rejection.
    void this.closed.catch(() => {});
  }

  private static async connectInternal({ piping, code, role, identity, expectedPeer, verifyPeer, signal }: {
    piping: NaidanPipingDuplexOptions;
    code: string;
    role: NaidanPipingRole | undefined;
    identity: NaidanPipingIdentity;
    expectedPeer: Uint8Array | undefined;
    verifyPeer: NaidanPipingPeerVerifier | undefined;
    signal: AbortSignal;
  }): Promise<NaidanPipingDuplexSession> {
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
    try {
      bootstrap = await startPinnedConnection({
        role,
        identity: localIdentity,
        expectedPeer: pin,
        verifyPeer,
        code,
        endpoint: bootstrapEndpoint,
        signal: stop.signal,
        confirmationTimeoutMs: settings.candidateConfirmationTimeoutMs,
        completionLeaseMs: settings.handshakeRetentionMs,
        intervalMs: settings.pacing.minimumMs,
        // A different stream profile must fail authentication, not silently produce two idle routes.
        purpose: ascii({ text: 'naidan-piping-streams/v3' }),
      });
      keys = await bootstrap.ready;
      stop.signal.throwIfAborted();
      streams = await StreamSession.create({ keys });
      stop.signal.throwIfAborted();
      return new NaidanPipingDuplexSession({
        streams,
        keys,
        stop,
        endpoint: trafficEndpoint,
        pacing: settings.pacing,
        bootstrap,
        signal,
        forward,
      });
    } catch (error) {
      stop.abort(error);
      streams?.abort({ reason: 'Piping connection failed' });
      keys?.dispose();
      await bootstrap?.completion.catch(() => {});
      signal.removeEventListener('abort', forward);
      throw error;
    }
  }

  static connect({ piping, code, role, identity, expectedPeer, signal }: {
    piping: NaidanPipingDuplexOptions; code: string; role: NaidanPipingRole;
    identity: NaidanPipingIdentity; expectedPeer: Uint8Array; signal: AbortSignal;
  }): Promise<NaidanPipingDuplexSession> {
    return this.connectInternal({ piping, code, role, identity, expectedPeer, verifyPeer: undefined, signal });
  }
  static pair({ piping, code, identity, verifyPeer, signal }: {
    piping: NaidanPipingDuplexOptions; code: string;
    identity: NaidanPipingIdentity; verifyPeer: NaidanPipingPeerVerifier; signal: AbortSignal;
  }): Promise<NaidanPipingDuplexSession> {
    return this.connectInternal({ piping, code, role: undefined, identity, expectedPeer: undefined, verifyPeer, signal });
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
  /** Confirm a new authenticated round trip; timing and disconnect policy belong to the caller. */
  confirmResponse({ signal, onRequestStarted }: { signal: AbortSignal, onRequestStarted(): void }): Promise<void> {
    return this.streams.confirmResponse({ signal, onRequestStarted });
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
