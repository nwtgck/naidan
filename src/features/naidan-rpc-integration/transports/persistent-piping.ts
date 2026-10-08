import { PipingRetirementError } from '@/features/naidan-piping-duplex';
import type { NaidanPipingPeerCandidate, NaidanPipingPeerEndpoint, NaidanPipingPeerSession } from '@/features/naidan-piping-duplex';
import type { RpcLink } from '@/features/naidan-rpc-integration/runtime/manager';
import { RpcConnectionReplacedError, RpcPeerClosedError } from '@/features/naidan-rpc-integration/runtime/persistent-link';
import type { RpcPersistentOwner } from '@/features/naidan-rpc-integration/runtime/persistent-link';

/** Physical ownership remains fenced by the opener until the manager records it. */
export async function openPersistentPipingRpc({ create, signal, validate }: {
  create({ signal }: { signal: AbortSignal }): Promise<NaidanPipingPeerEndpoint>;
  signal: AbortSignal;
  validate({ bytes }: { bytes: Uint8Array }): void;
}): Promise<RpcLink> {
  const physical = new AbortController();
  const forward = () => physical.abort(signal.reason);
  signal.addEventListener('abort', forward, { once: true }); if (signal.aborted) forward();
  let owner: PersistentPipingOwner | undefined;
  try {
    const endpoint = await create({ signal: physical.signal });
    owner = new PersistentPipingOwner({ endpoint, validate, detach: () => signal.removeEventListener('abort', forward) });
    signal.throwIfAborted(); return await owner.next({ signal });
  } catch (error) {
    let cleanup: { error: unknown } | undefined;
    try {
      await owner?.stop({ reason: 'RPC endpoint opening rejected', notice: 'abort' });
    } catch (failure) {
      cleanup = { error: failure };
    } finally {
      signal.removeEventListener('abort', forward); physical.abort(error);
    }
    if (cleanup) throw new PipingRetirementError({ cause: cleanup.error, logicalError: error instanceof PipingRetirementError ? error.logicalError : error });
    throw error;
  }
}

class PersistentPipingOwner implements RpcPersistentOwner {
  private readonly endpoint: NaidanPipingPeerEndpoint;
  private readonly iterator: AsyncIterator<NaidanPipingPeerCandidate>;
  private readonly detach: () => void;
  private readonly validate: ({ bytes }: { bytes: Uint8Array }) => void;
  private pending: Promise<NaidanPipingPeerCandidate> | undefined;
  private held: NaidanPipingPeerCandidate | undefined;
  private current: NaidanPipingPeerSession | undefined;
  private stopping: Promise<void> | undefined;
  private physicallyEnded = false;
  private needsCycle = true;
  private waiting = false;
  constructor({ endpoint, validate, detach }: {
    endpoint: NaidanPipingPeerEndpoint; validate({ bytes }: { bytes: Uint8Array }): void; detach(): void;
  }) {
    this.endpoint = endpoint; this.iterator = endpoint.candidates[Symbol.asyncIterator](); this.validate = validate; this.detach = detach;
    void endpoint.closed.then(() => {
      this.physicallyEnded = true;
    }, () => {
      this.physicallyEnded = true;
    });
  }
  get usable(): boolean {
    return !this.physicallyEnded && !this.stopping;
  }
  get waitingForPeer(): boolean {
    return this.waiting;
  }
  adopt(): void {
    this.detach();
  }
  async resume(): Promise<void> {
    if (!this.waiting) return;
    await this.current?.closed;
    if (!this.usable) throw new Error('RPC endpoint stopped before explicit reconnect');
    if (this.waiting) {
      this.waiting = false; this.needsCycle = false; this.endpoint.beginCycle();
    }
  }
  private candidate(): Promise<NaidanPipingPeerCandidate> {
    if (!this.pending) {
      this.pending = this.iterator.next().then(result => {
        if (result.done) throw new Error('RPC physical endpoint stopped');
        this.held = result.value; return result.value;
      });
      void this.pending.catch(() => {});
    }
    return this.pending;
  }
  async next({ signal }: { signal: AbortSignal }): Promise<RpcLink> {
    signal.throwIfAborted();
    if (!this.usable) throw new Error('RPC physical endpoint is not available');
    if (this.needsCycle && !this.held) {
      this.endpoint.beginCycle(); this.needsCycle = false;
    }
    const cancelled = Promise.withResolvers<never>();
    const abort = () => cancelled.reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    let selected: NaidanPipingPeerCandidate | undefined;
    try {
      selected = await Promise.race([this.candidate(), cancelled.promise]); signal.throwIfAborted();
      this.validate({ bytes: selected.peerPublicHandshakeData });
      const session = await selected.activate({ signal });
      signal.throwIfAborted();
      this.pending = undefined; this.held = undefined; this.current = session; this.waiting = false; this.needsCycle = false;
      const ended = Promise.race([
        session.ended.then(outcome => {
          const waiting = (() => {
            switch (outcome.kind) {
            case 'peer-closed': return true;
            case 'local-stop': case 'response-unconfirmed': case 'record-exhausted':
            case 'authenticated-protocol-error': case 'authentication-budget-exhausted': case 'transport-fatal': return false;
            default: { const exhaustive: never = outcome.kind; throw new Error(String(exhaustive)); }
            }
          })();
          if (this.current === session) {
            this.waiting = waiting; this.needsCycle = !waiting;
          }
          return { error: waiting ? new RpcPeerClosedError() : outcome.error };
        }),
        this.candidate().then(() => ({ error: new RpcConnectionReplacedError() })),
      ]);
      void ended.catch(() => {});
      return {
        peerIdentity: session.peerIdentity,
        incomingStreams: session.incomingStreams,
        closed: session.closed,
        ended,
        openStream: ({ signal }) => session.openStream({ signal }),
        abort: ({ reason }) => session.abort({ reason }),
        persistent: {
          owner: this,
          get health() {
            return session.health;
          },
          subscribeHealth: ({ listener }) => session.subscribeHealth({ listener }),
        },
      };
    } catch (error) {
      if (selected) {
        let cleanup: { error: unknown } | undefined;
        try {
          selected.reject({ reason: 'RPC candidate rejected before admission' });
        } catch (failure) {
          cleanup = { error: failure };
        }
        try {
          await selected.closed;
        } catch (failure) {
          cleanup ??= { error: failure };
        }
        if (!cleanup && this.held === selected) {
          this.held = undefined; this.pending = undefined;
        }
        if (!this.waiting) this.needsCycle = true;
        if (cleanup) throw new PipingRetirementError({ cause: cleanup.error, logicalError: error });
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  stop({ reason, notice }: { reason: string; notice: 'notify-peer' | 'abort' }): Promise<void> {
    if (this.stopping) return this.stopping;
    const finished = Promise.withResolvers<void>(); this.stopping = finished.promise;
    void finished.promise.catch(() => {}); this.detach();
    void (async () => {
      let failure: { error: unknown } | undefined;
      try {
        await this.endpoint.pause({ reason });
        this.held?.reject({ reason });
        if (this.current) switch (notice) {
        case 'notify-peer': await this.current.close({ noticeTimeoutMs: 1000, signal: undefined }); break;
        case 'abort': this.current.abort({ reason }); break;
        default: { const exhaustive: never = notice; throw new Error(String(exhaustive)); }
        }
      } catch (error) {
        failure = { error };
      }
      try {
        this.endpoint.stop({ reason });
      } catch (error) {
        failure ??= { error };
      }
      const retired = await Promise.allSettled([this.endpoint.closed, this.current?.closed, this.held?.closed]);
      for (const result of retired) switch (result.status) {
      case 'rejected': failure ??= { error: result.reason }; break;
      case 'fulfilled': break;
      default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
      }
      if (failure) throw failure.error;
      this.current = undefined; this.held = undefined; this.pending = undefined;
    })().then(finished.resolve, finished.reject);
    return finished.promise;
  }
}

export const TEST_ONLY = {
};
