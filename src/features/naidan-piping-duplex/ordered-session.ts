import { equalBytes, ownBytes, requireValue } from '@/features/naidan-piping-duplex/bytes';
import {
  BATCH_BYTES, CONNECTION_WINDOW, STREAM_WINDOW, STREAMS, decodeFrames,
} from '@/features/naidan-piping-duplex/batch-wire';
import type { Frame, ReceiveLimits } from '@/features/naidan-piping-duplex/batch-wire';
import type { FiniteTransfer } from '@/features/naidan-piping-duplex/finite-transfer';
import type { NaidanPipingKeyContext } from '@/features/naidan-piping-duplex/key-context';
import { OrderedRecords } from '@/features/naidan-piping-duplex/ordered-records';
import { StreamMux } from '@/features/naidan-piping-duplex/stream-mux';
import type { MultiplexedStream, TransmissionResult } from '@/features/naidan-piping-duplex/stream-mux';
import { isInitiator } from '@/features/naidan-piping-duplex/role';
import {
  AuthenticatedProtocolError, ConnectionLifetime, PipingRetirementError, RecordExhaustedError, ResponseUnconfirmedError,
} from '@/features/naidan-piping-duplex/lifetime';
import type { NaidanPipingConnectionEndKind } from '@/features/naidan-piping-duplex/lifetime';

export type ConnectionHealth = Readonly<{ state: 'healthy' | 'checking' }>;
export type LivenessOptions = { intervalMs: number; checkingMs: number; responseTimeoutMs: number; busyTimeoutMs: number };
export const DEFAULT_LIVENESS: LivenessOptions = Object.freeze({ intervalMs: 10_000, checkingMs: 5_000, responseTimeoutMs: 20_000, busyTimeoutMs: 120_000 });
export const DEFAULT_RECEIVE_LIMITS: ReceiveLimits = Object.freeze({ streams: STREAMS, connectionWindow: CONNECTION_WINDOW, streamWindow: STREAM_WINDOW });
export function validateLiveness({ liveness }: { liveness: LivenessOptions }): LivenessOptions {
  for (const duration of Object.values(liveness)) requireValue({ condition: Number.isInteger(duration) && duration > 0 && duration <= 2147483647, message: 'Invalid liveness duration' });
  requireValue({ condition: liveness.checkingMs < liveness.responseTimeoutMs && liveness.responseTimeoutMs <= liveness.busyTimeoutMs, message: 'Invalid liveness ordering' });
  return { ...liveness };
}

type Probe = { token: Uint8Array; checkingAt: number; deadline: number; sealed: boolean };
type LocalClose = { token: Uint8Array; sealed: boolean; sent: boolean; acknowledged: boolean };
type RemoteClose = { token: Uint8Array; sealed: boolean; sent: boolean };

/** One authenticated connection. Reconnection and persistence deliberately do not live here. */
export class OrderedSession {
  private readonly mux: StreamMux;
  private readonly sender: OrderedRecords;
  private readonly receiver: OrderedRecords;
  private readonly keys: NaidanPipingKeyContext;
  private readonly endpoint: FiniteTransfer;
  private readonly stop = new AbortController();
  private readonly lifetime = new ConnectionLifetime();
  private readonly readiness = Promise.withResolvers<void>();
  private readonly liveness: LivenessOptions;
  private readonly peer: Uint8Array;
  private readonly context: Uint8Array;
  private localReady = false;
  private peerReady = false;
  private gotReady = false;
  private active = false;
  private transmitting = false;
  private receiving = false;
  private pendingCloseAck = false;
  private nextProbe = Infinity;
  private probe: Probe | undefined;
  private pong: Uint8Array | undefined;
  private localClose: LocalClose | undefined;
  private remoteClose: RemoteClose | undefined;
  private closeDeadline = Infinity;
  private closeResult: Promise<{ notification: 'acknowledged' | 'unconfirmed' }> | undefined;
  private currentHealth: ConnectionHealth = { state: 'healthy' };
  private readonly listeners = new Set<({ health }: { health: ConnectionHealth }) => void>();
  readonly ended = this.lifetime.ended;
  readonly closed: Promise<void>;

  private constructor({ keys, endpoint, limits, liveness, signal }: {
    keys: NaidanPipingKeyContext; endpoint: FiniteTransfer; limits: ReceiveLimits; liveness: LivenessOptions; signal: AbortSignal;
  }) {
    this.liveness = validateLiveness({ liveness }); this.keys = keys; this.endpoint = endpoint;
    this.peer = keys.peerIdentity; this.context = keys.contextId;
    this.mux = new StreamMux({ role: keys.role, limits });
    const domain = keys.createDomain({ label: 'piping-duplex/v1', context: keys.contextId });
    const tx = isInitiator({ role: keys.role }) ? 1 : 2, rx = tx === 1 ? 2 : 1;
    this.sender = new OrderedRecords({ domain, context: keys.contextId, direction: tx, usage: 'encrypt' });
    this.receiver = new OrderedRecords({ domain, context: keys.contextId, direction: rx, usage: 'decrypt' });
    void this.readiness.promise.catch(() => {});
    const forward = () => this.abort({ reason: 'Connection owner aborted' });
    signal.addEventListener('abort', forward, { once: true }); if (signal.aborted) forward();
    const failures: unknown[] = [];
    const guarded = async ({ task }: { task(): Promise<void> }) => {
      try {
        await task();
      } catch (error) {
        if (error instanceof PipingRetirementError) failures.push(error);
        if (!this.stop.signal.aborted) this.fail({ error });
      }
    };
    const jobs = [guarded({ task: () => this.sendLoop() }), guarded({ task: () => this.receiveLoop() }), guarded({ task: () => this.monitor() })];
    const sender = this.sender, receiver = this.receiver, ownedKeys = this.keys;
    this.closed = (async () => {
      await Promise.allSettled(jobs);
      signal.removeEventListener('abort', forward);
      sender.dispose(); receiver.dispose(); ownedKeys.dispose();
      this.listeners.clear(); this.probe?.token.fill(0); this.pong?.fill(0);
      if (failures.length) throw new PipingRetirementError({ cause: failures[0], logicalError: this.lifetime.end?.error });
    })();
    void this.closed.catch(() => {});
  }
  static async create({ keys, endpoint, signal, limits = DEFAULT_RECEIVE_LIMITS, liveness = DEFAULT_LIVENESS }: {
    keys: NaidanPipingKeyContext; endpoint: FiniteTransfer; signal: AbortSignal; limits?: ReceiveLimits; liveness?: LivenessOptions;
  }): Promise<OrderedSession> {
    let session: OrderedSession | undefined;
    try {
      signal.throwIfAborted(); session = new OrderedSession({ keys, endpoint, signal, limits, liveness });
      await session.readiness.promise; signal.throwIfAborted(); return session;
    } catch (error) {
      if (session) {
        session.abort({ reason: 'Connection initialization failed' });
        try {
          await session.closed;
        } catch (cause) {
          throw new PipingRetirementError({ cause, logicalError: error });
        }
      } else keys.dispose();
      throw error;
    }
  }
  get peerIdentity(): Uint8Array {
    return this.peer.slice();
  }
  get contextId(): Uint8Array {
    return this.context.slice();
  }
  get health(): ConnectionHealth {
    return this.currentHealth;
  }
  subscribeHealth({ listener }: { listener({ health }: { health: ConnectionHealth }): void }): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  get incomingStreams(): AsyncIterable<MultiplexedStream> {
    return this.mux.incomingStreams;
  }
  openStream({ signal }: { signal: AbortSignal | undefined }): Promise<MultiplexedStream> {
    return this.mux.openStream({ signal });
  }
  drain({ signal }: { signal: AbortSignal | undefined }): Promise<void> {
    return this.mux.drain({ signal });
  }
  private healthChanged({ state }: { state: ConnectionHealth['state'] }): void {
    if (this.currentHealth.state === state) return;
    this.currentHealth = Object.freeze({ state });
    for (const listener of this.listeners) {
      try {
        listener({ health: this.currentHealth });
      } catch { /* Observation does not own I/O. */ }
    }
  }
  private end({ kind, error }: { kind: NaidanPipingConnectionEndKind; error: unknown }): void {
    const end = this.lifetime.commit({ kind, error });
    this.mux.stop({ error: end.error }); this.readiness.reject(end.error); this.mux.changed.fire();
  }
  private fail({ error }: { error: unknown }): void {
    let kind: NaidanPipingConnectionEndKind = 'transport-fatal';
    if (error instanceof AuthenticatedProtocolError) kind = 'authenticated-protocol-error';
    else if (error instanceof RecordExhaustedError) kind = 'record-exhausted';
    else if (error instanceof ResponseUnconfirmedError) kind = 'response-unconfirmed';
    this.end({ kind, error }); this.stop.abort(error); this.mux.changed.fire();
  }
  abort({ reason }: { reason: string }): void {
    const error = new Error(reason); this.end({ kind: 'local-stop', error }); this.stop.abort(error); this.mux.changed.fire();
  }
  close({ noticeTimeoutMs = 2000, signal }: { noticeTimeoutMs?: number; signal: AbortSignal | undefined }): Promise<{ notification: 'acknowledged' | 'unconfirmed' }> {
    if (this.closeResult) return this.closeResult;
    requireValue({ condition: Number.isInteger(noticeTimeoutMs) && noticeTimeoutMs > 0 && noticeTimeoutMs <= 2147483647, message: 'Invalid close deadline' });
    if (!this.stop.signal.aborted && !this.remoteClose) {
      this.localClose = { token: crypto.getRandomValues(new Uint8Array(32)), sealed: false, sent: false, acknowledged: false };
      this.closeDeadline = Math.min(this.closeDeadline, performance.now() + noticeTimeoutMs);
      this.end({ kind: 'local-stop', error: new Error('Connection closed by owner') });
    }
    const abort = () => this.abort({ reason: 'Close notice cancelled' });
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    this.closeResult = this.closed.then(() => ({ notification: this.localClose?.acknowledged ? 'acknowledged' as const : 'unconfirmed' as const }))
      .finally(() => signal?.removeEventListener('abort', abort));
    void this.closeResult.catch(() => {}); this.mux.changed.fire(); return this.closeResult;
  }
  private activate(): void {
    if (!this.active && this.localReady && this.peerReady && !this.lifetime.end) {
      this.active = true; this.nextProbe = performance.now() + this.liveness.intervalMs;
      this.mux.activate(); this.readiness.resolve(); this.mux.changed.fire();
    }
  }
  private noticeFinished(): void {
    if (!this.localClose && !this.remoteClose) return;
    if (this.localClose && (!this.localClose.sent || !this.localClose.acknowledged)) return;
    if (this.remoteClose && !this.remoteClose.sent) return;
    this.stop.abort(new Error('Close notice complete')); this.mux.changed.fire();
  }
  private controls(): Frame[] {
    if (!this.localReady) return [{ kind: 'ready', limits: this.mux.limits }];
    const frames: Frame[] = [];
    if (this.localClose && !this.localClose.sealed) {
      frames.push({ kind: 'close', token: this.localClose.token }); this.localClose.sealed = true;
    }
    if (this.remoteClose && !this.remoteClose.sealed) {
      frames.push({ kind: 'close-ack', token: this.remoteClose.token }); this.remoteClose.sealed = true;
    }
    if (!this.lifetime.end) {
      if (this.pong) {
        frames.push({ kind: 'pong', token: this.pong }); this.pong = undefined;
      }
      if (this.probe && !this.probe.sealed) {
        frames.push({ kind: 'ping', token: this.probe.token }); this.probe.sealed = true;
      }
    }
    return frames;
  }
  private async sendLoop(): Promise<void> {
    const signal = this.stop.signal;
    while (!signal.aborted) {
      const revision = this.mux.changed.revision, controls = this.controls();
      const plan = this.mux.prepare({ controls });
      if (!plan) {
        await this.mux.changed.wait({ revision, signal }); continue;
      }
      let result: TransmissionResult = { kind: 'sent' };
      this.transmitting = true;
      try {
        const route = await this.sender.nextRoute({ signal });
        const bytes = await this.sender.seal({ plaintexts: plan.plaintexts, signal });
        await this.endpoint.send({ route, bytes, signal }); signal.throwIfAborted();
        this.sent({ controls });
      } catch (error) {
        result = { kind: 'failed', error }; throw error;
      } finally {
        this.transmitting = false; plan.complete({ result });
      }
      this.noticeFinished();
    }
  }
  private sent({ controls }: { controls: readonly Frame[] }): void {
    for (const frame of controls) {
      switch (frame.kind) {
      case 'ready': this.localReady = true; this.activate(); break;
      case 'close': if (this.localClose) this.localClose.sent = true; break;
      case 'close-ack': if (this.remoteClose) this.remoteClose.sent = true; break;
      default: break;
      }
    }
  }
  private received({ frame, first }: { frame: Frame; first: boolean }): void {
    if (first) {
      requireValue({ condition: !this.gotReady && frame.kind === 'ready', message: 'Missing initial READY' });
      switch (frame.kind) {
      case 'ready': this.gotReady = true; this.mux.setPeerLimits({ limits: frame.limits }); return;
      default: throw new Error('Missing READY');
      }
    }
    requireValue({ condition: this.gotReady, message: 'Frame before peer READY' });
    switch (frame.kind) {
    case 'ready': throw new Error('Duplicate READY');
    case 'ping': if (!this.lifetime.end) this.pong = ownBytes({ bytes: frame.token, maxBytes: 32 }); break;
    case 'pong':
      if (this.probe?.sealed && equalBytes({ left: frame.token, right: this.probe.token })) {
        if (performance.now() >= this.probe.deadline) throw new ResponseUnconfirmedError();
        this.probe = undefined; this.nextProbe = performance.now() + this.liveness.intervalMs; this.healthChanged({ state: 'healthy' });
      }
      break;
    case 'close':
      if (this.remoteClose) requireValue({ condition: equalBytes({ left: frame.token, right: this.remoteClose.token }), message: 'Conflicting CLOSE token' });
      else {
        this.remoteClose = { token: ownBytes({ bytes: frame.token, maxBytes: 32 }), sealed: false, sent: false };
        this.closeDeadline = Math.min(this.closeDeadline, performance.now() + 2000);
        this.end({ kind: 'peer-closed', error: new Error('Peer closed the connection') });
      }
      break;
    case 'close-ack':
      if (this.localClose && this.localClose.sealed && equalBytes({ left: frame.token, right: this.localClose.token })) this.pendingCloseAck = true;
      break;
    default: this.mux.accept({ frame }); break;
    }
    this.mux.changed.fire();
  }
  private async receiveLoop(): Promise<void> {
    const signal = this.stop.signal;
    while (!signal.aborted) {
      const initial = !this.peerReady, route = await this.receiver.nextRoute({ signal });
      await this.endpoint.read({
        route,
        maximum: BATCH_BYTES,
        signal,
        consume: async ({ body }) => {
          this.receiving = true;
          try {
            await this.receiver.receive({
              body,
              signal,
              onRecord: async ({ plaintext, first }) => {
                try {
                  const frames = decodeFrames({ bytes: plaintext });
                  requireValue({ condition: !first || (frames.length === 1 && frames[0]!.kind === 'ready'), message: 'Invalid initial READY record' });
                  for (const frame of frames) this.received({ frame, first });
                } catch (cause) {
                  if (cause instanceof ResponseUnconfirmedError) throw cause;
                  throw new AuthenticatedProtocolError({ cause });
                }
              },
            });
          } finally {
            this.receiving = false;
          }
        },
      });
      if (initial) {
        this.peerReady = true; this.activate();
      }
      // Only a fully validated finite body can complete a close notice. A
      // concurrent POST completion must not abort a still-unchecked tail.
      if (this.pendingCloseAck && this.localClose) {
        this.localClose.acknowledged = true; this.pendingCloseAck = false;
      }
      this.noticeFinished();
      // Even a valid stream of tiny records yields to cancellation, rendering and timers.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
  private async monitor(): Promise<void> {
    const signal = this.stop.signal;
    while (!signal.aborted) {
      const now = performance.now();
      if (this.lifetime.end) {
        if (now >= this.closeDeadline) {
          this.stop.abort(this.lifetime.end.error); this.mux.changed.fire(); return;
        }
      } else if (this.active) {
        if (!this.probe && now >= this.nextProbe) {
          this.probe = {
            token: crypto.getRandomValues(new Uint8Array(32)),
            checkingAt: now + this.liveness.checkingMs,
            deadline: now + (this.transmitting || this.receiving ? this.liveness.busyTimeoutMs : this.liveness.responseTimeoutMs),
            sealed: false,
          };
          this.mux.changed.fire();
        }
        if (this.probe && now >= this.probe.deadline) throw new ResponseUnconfirmedError();
        if (this.probe && now >= this.probe.checkingAt) this.healthChanged({ state: 'checking' });
      }
      const due = (() => {
        if (this.lifetime.end) return this.closeDeadline;
        if (!this.probe) return this.nextProbe;
        switch (this.currentHealth.state) {
        case 'checking': return this.probe.deadline;
        case 'healthy': return this.probe.checkingAt;
        default: { const exhaustive: never = this.currentHealth.state; throw new Error(String(exhaustive)); }
        }
      })();
      const revision = this.mux.changed.revision;
      const timer = Number.isFinite(due) ? setTimeout(() => this.mux.changed.fire(), Math.max(1, Math.min(2147483647, due - performance.now()))) : undefined;
      try {
        await this.mux.changed.wait({ revision, signal });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  }
}

export const TEST_ONLY = {
};
