import { ConnectionLifetime, PipingRetirementError } from './lifetime';
import type { NaidanPipingConnectionEnd } from './lifetime';
import { Deadline } from './finite';
import { equalBytes, requireValue } from './bytes';
import type { NaidanPipingDuplexSession } from './naidan-piping-duplex-session';
import type { StreamSession, NaidanPipingDuplexStream } from './session';
import type { PeerControl, Snapshot } from './wire';

export type NaidanPipingPeerHealth = Readonly<{ state: 'healthy' | 'checking' }>;
export interface NaidanPipingPeerSession {
  readonly peerIdentity: Uint8Array;
  readonly peerPublicHandshakeData: Uint8Array;
  readonly peerHandshakeData: Uint8Array;
  readonly incomingStreams: AsyncIterable<NaidanPipingDuplexStream>;
  readonly ended: Promise<NaidanPipingConnectionEnd>;
  readonly closed: Promise<void>;
  readonly health: NaidanPipingPeerHealth;
  subscribeHealth({ listener }: { listener({ health }: { health: NaidanPipingPeerHealth }): void }): () => void;
  openStream({ signal }: { signal: AbortSignal | undefined }): Promise<NaidanPipingDuplexStream>;
  drain({ signal }: { signal: AbortSignal | undefined }): Promise<void>;
  abort({ reason }: { reason: string }): void;
  close({ noticeTimeoutMs, signal }: { noticeTimeoutMs: number; signal: AbortSignal | undefined }): Promise<{ notification: 'acknowledged' | 'unconfirmed' }>;
}
export interface NaidanPipingPeerCandidate {
  readonly peerIdentity: Uint8Array;
  readonly peerPublicHandshakeData: Uint8Array;
  readonly peerHandshakeData: Uint8Array;
  readonly contextId: Uint8Array;
  readonly closed: Promise<void>;
  activate({ signal }: { signal: AbortSignal }): Promise<NaidanPipingPeerSession>;
  reject({ reason }: { reason: string }): void;
}

/** Logical ownership only: stopping this session leaves the common mailbox alive. */
export class OwnedPeerSession implements NaidanPipingPeerSession, NaidanPipingPeerCandidate {
  private readonly lifetime = new ConnectionLifetime();
  private readonly activation = Promise.withResolvers<void>();
  private readonly closeAck = Promise.withResolvers<void>();
  private readonly completion = Promise.withResolvers<void>();
  private readonly stopped = new AbortController();
  private connection: NaidanPipingDuplexSession | undefined;
  private streams: StreamSession | undefined;
  private localReady = false;
  private peerReady = false;
  private closeToken: Uint8Array<ArrayBuffer> | undefined;
  private peerClose: Uint8Array<ArrayBuffer> | undefined;
  private notice: Promise<{ notification: 'acknowledged' | 'unconfirmed' }> | undefined;
  private offerTimer: ReturnType<typeof setTimeout> | undefined;
  private peerAckTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly healthListeners = new Set<({ health }: { health: NaidanPipingPeerHealth }) => void>();
  private currentHealth: NaidanPipingPeerHealth = { state: 'healthy' };
  readonly ended = this.lifetime.ended;
  readonly closed = this.completion.promise;
  private readonly options: { contextId: Uint8Array; activationTimeoutMs: number; interrupt(): void; abortTransport({ reason }: { reason: string }): void; onEnded({ end }: { end: NaidanPipingConnectionEnd }): void };
  constructor({ options }: { options: OwnedPeerSession['options'] }) {
    this.options = options;
    void this.activation.promise.catch(() => {}); void this.closeAck.promise.catch(() => {}); void this.closed.catch(() => {});
  }
  attach({ streams }: { streams: StreamSession }): void {
    requireValue({ condition: this.streams === undefined, message: 'Peer stream owner already attached' }); this.streams = streams;
    streams.subscribeResponseHealth({
      listener: ({ state }) => {
        this.currentHealth = { state }; for (const listener of [...this.healthListeners]) {
          try {
            listener({ health: this.currentHealth });
          } catch { /* Observation does not own the connection. */ }
        }
      },
    });
    streams.setPeerControls({
      policy: {
        snapshot: () => ({ ready: this.localReady, close: this.closeToken, closeAck: this.peerClose }),
        validate: ({ control, snapshot }) => this.validate({ control, snapshot }),
        accept: ({ control }) => this.accept({ control }),
      },
    });
  }
  established({ connection }: { connection: NaidanPipingDuplexSession }): void {
    this.connection = connection;
    this.offerTimer = setTimeout(() => this.reject({ reason: 'Candidate admission deadline expired' }), this.options.activationTimeoutMs);
    void connection.ended.then(end => this.end({ end }));
    void connection.closed.then(() => this.finish(), error => this.finish({ error }));
    if (this.stopped.signal.aborted) connection.abort({ reason: 'Peer session already stopped' });
  }
  failed({ error }: { error: unknown }): void {
    this.end({ end: { kind: 'transport-fatal', error: error instanceof Error ? error : new Error('Peer establishment failed', { cause: error }) } }); this.finish({ error: error instanceof PipingRetirementError ? error : undefined });
  }
  private finish({ error }: { error?: unknown } = {}): void {
    clearTimeout(this.offerTimer); clearTimeout(this.peerAckTimer); this.stopped.abort(error ?? new Error('Peer session retired'));
    this.activation.reject(this.stopped.signal.reason); this.healthListeners.clear();
    if (error === undefined) this.completion.resolve(); else this.completion.reject(error);
  }
  private end({ end }: { end: NaidanPipingConnectionEnd }): void {
    if (this.lifetime.end) return;
    const outcome = this.lifetime.commit(end); this.streams?.stopApplication(); this.activation.reject(outcome.error);
    this.options.onEnded({ end: outcome });
  }
  private validate({ control, snapshot }: { control: PeerControl | undefined; snapshot: Snapshot }): boolean {
    requireValue({ condition: control !== undefined, message: 'Peer lifecycle control required' });
    if (this.peerClose && control?.close) requireValue({ condition: equalBytes({ left: this.peerClose, right: control.close }), message: 'Conflicting peer close token' });
    if (this.lifetime.end) return false;
    if (!this.localReady || !(this.peerReady || control?.ready)) {
      requireValue({ condition: snapshot.states.length === 0 && snapshot.data.length === 0, message: 'Application stream before mutual admission' });
    }
    return true;
  }
  private accept({ control }: { control: PeerControl | undefined }): void {
    if (!control) return;
    this.peerReady ||= control.ready;
    if (control.close !== undefined) {
      this.peerClose ??= control.close.slice(); this.end({ end: { kind: 'peer-closed', error: new Error('Peer closed the connection') } });
      this.streams?.controlChanged(); this.options.interrupt();
      this.peerAckTimer ??= setTimeout(() => this.connection?.abort({ reason: 'Peer close acknowledgement window ended' }), 2000);
    }
    if (control.closeAck && this.closeToken && equalBytes({ left: control.closeAck, right: this.closeToken })) this.closeAck.resolve();
    if (this.localReady && this.peerReady && !this.lifetime.end) this.activation.resolve();
  }
  private liveConnection(): NaidanPipingDuplexSession {
    requireValue({ condition: this.connection !== undefined, message: 'Peer connection not ready' }); return this.connection!;
  }
  get hasEnded(): boolean {
    return this.lifetime.end !== undefined;
  }
  get contextId(): Uint8Array {
    return this.connection?.contextId ?? this.options.contextId.slice();
  }
  get peerIdentity(): Uint8Array {
    return this.liveConnection().peerIdentity;
  }
  get peerPublicHandshakeData(): Uint8Array {
    return this.liveConnection().peerPublicHandshakeData;
  }
  get peerHandshakeData(): Uint8Array {
    return this.liveConnection().peerHandshakeData;
  }
  get incomingStreams(): AsyncIterable<NaidanPipingDuplexStream> {
    requireValue({ condition: this.localReady && this.peerReady && !this.lifetime.end, message: 'Peer session not admitted' }); return this.liveConnection().incomingStreams;
  }
  openStream({ signal }: { signal: AbortSignal | undefined }): Promise<NaidanPipingDuplexStream> {
    requireValue({ condition: this.localReady && this.peerReady && !this.lifetime.end, message: 'Peer session not admitted' }); return this.liveConnection().openStream({ signal });
  }
  drain({ signal }: { signal: AbortSignal | undefined }): Promise<void> {
    return this.liveConnection().drain({ signal });
  }
  async activate({ signal }: { signal: AbortSignal }): Promise<NaidanPipingPeerSession> {
    requireValue({ condition: !this.localReady && !this.lifetime.end, message: 'Candidate activation already consumed' }); signal.throwIfAborted();
    clearTimeout(this.offerTimer); this.offerTimer = undefined;
    this.localReady = true; this.streams?.controlChanged(); this.options.interrupt();
    if (this.peerReady) this.activation.resolve();
    const deadline = new Deadline({ parent: AbortSignal.any([signal, this.stopped.signal]), milliseconds: this.options.activationTimeoutMs });
    const abort = () => {
      this.activation.reject(deadline.signal.reason); this.abort({ reason: 'Candidate activation stopped' });
    };
    deadline.signal.addEventListener('abort', abort, { once: true });
    try {
      await this.activation.promise; signal.throwIfAborted(); requireValue({ condition: !this.lifetime.end, message: 'Candidate ended during activation' }); return this;
    } finally {
      deadline.signal.removeEventListener('abort', abort); deadline.dispose();
    }
  }
  reject({ reason }: { reason: string }): void {
    this.abort({ reason });
  }
  abort({ reason }: { reason: string }): void {
    this.end({ end: { kind: 'local-stop', error: new Error(reason) } }); this.connection?.abort({ reason }); this.options.abortTransport({ reason }); this.stopped.abort(new Error(reason));
  }
  close({ noticeTimeoutMs, signal }: { noticeTimeoutMs: number; signal: AbortSignal | undefined }): Promise<{ notification: 'acknowledged' | 'unconfirmed' }> {
    if (this.notice) return this.notice;
    this.end({ end: { kind: 'local-stop', error: new Error('Local peer connection closed') } });
    this.closeToken = crypto.getRandomValues(new Uint8Array(32)); this.streams?.controlChanged(); this.options.interrupt();
    this.notice = (async () => {
      const deadline = new Deadline({ parent: AbortSignal.any([this.stopped.signal, ...(signal ? [signal] : [])]), milliseconds: noticeTimeoutMs });
      const outcome = Promise.withResolvers<'acknowledged' | 'unconfirmed'>();
      const expire = () => outcome.resolve('unconfirmed'); deadline.signal.addEventListener('abort', expire, { once: true });
      if (deadline.signal.aborted) expire();
      void this.closeAck.promise.then(() => outcome.resolve('acknowledged'));
      try {
        const notification = await outcome.promise; this.connection?.abort({ reason: 'Local close notice finished' }); await this.closed; return { notification };
      } finally {
        deadline.signal.removeEventListener('abort', expire); deadline.dispose();
      }
    })(); return this.notice;
  }
  get health(): NaidanPipingPeerHealth {
    return this.currentHealth;
  }
  subscribeHealth({ listener }: { listener({ health }: { health: NaidanPipingPeerHealth }): void }): () => void {
    this.healthListeners.add(listener); try {
      listener({ health: this.currentHealth });
    } catch { /* Observation does not own the connection. */ } return () => {
      this.healthListeners.delete(listener);
    };
  }
}
export const TEST_ONLY = {
};
