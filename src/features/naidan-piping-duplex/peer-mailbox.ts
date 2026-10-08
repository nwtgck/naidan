import { AttemptError, needsSenderRepair, sleep, Deadline } from './finite';
import type { FiniteTransport } from './finite';
import { PipingRetirementError } from './lifetime';
import { ownBytes, Pulse, requireValue } from './bytes';
import { decodePeerEnvelope, encodePeerEnvelope } from './peer-envelope';
import type { PeerEnvelope } from './peer-envelope';

type Send = {
  bytes: Uint8Array; channel: string; signal: AbortSignal; completion: PromiseWithResolvers<void>;
  cancel(): void; state: 'queued' | 'active' | 'settled';
};
type Receive = { completion: PromiseWithResolvers<Uint8Array>; cancel(): void };

/** Exactly one real GET and POST owner; virtual transports never issue fetches. */
export class PeerMailbox {
  private readonly stop = new AbortController();
  private readonly pulse = new Pulse();
  private readonly sends: Send[] = [];
  private readonly receives = new Map<string, Receive>();
  private readonly routeOwners = new Map<string, { signal: AbortSignal; cancel(): void }>();
  private readonly buffered = new Map<string, Uint8Array>();
  private active: { entry: Send | undefined; stop: AbortController } | undefined;
  private hello: Uint8Array | undefined;
  private nextHello = 0;
  private helloTurn = false;
  private failure: unknown;
  readonly closed: Promise<void>;

  constructor({ endpoint, sendRoute, receiveRoute, signal, minimumMs, helloIntervalMs, onHello }: {
    endpoint: FiniteTransport; sendRoute: string; receiveRoute: string; signal: AbortSignal;
    minimumMs: number; helloIntervalMs: number; onHello({ bytes }: { bytes: Uint8Array }): void;
  }) {
    const forward = () => this.stop.abort(signal.reason);
    signal.addEventListener('abort', forward, { once: true }); if (signal.aborted) forward();
    this.stop.signal.addEventListener('abort', () => this.pulse.fire(), { once: true });
    const guard = async ({ task }: { task(): Promise<void> }) => {
      try {
        await task();
      } catch (error) {
        if (!this.stop.signal.aborted || error instanceof PipingRetirementError) this.failure ??= error;
        this.stop.abort(error);
      }
    };
    const sender = async () => {
      while (!this.stop.signal.aborted) {
        const revision = this.pulse.revision;
        const helloDue = this.hello !== undefined && performance.now() >= this.nextHello;
        const useHello = helloDue && (!this.helloTurn || this.sends.length === 0);
        const entry = useHello ? undefined : this.sends.shift();
        const bytes = useHello ? this.hello : entry?.bytes;
        if (!bytes) {
          const wait = new Deadline({ parent: this.stop.signal, milliseconds: this.hello ? Math.max(1, Math.ceil(this.nextHello - performance.now())) : helloIntervalMs });
          try {
            await this.pulse.wait({ revision, signal: wait.signal });
          } catch {
            this.stop.signal.throwIfAborted();
          } finally {
            wait.dispose();
          }
          continue;
        }
        this.helloTurn = useHello;
        if (entry) entry.state = 'active'; else this.nextHello = performance.now() + helloIntervalMs;
        const sending = new AbortController(); this.active = { entry, stop: sending };
        const activeSignal = AbortSignal.any([this.stop.signal, sending.signal]);
        let failure: unknown;
        try {
          await endpoint.send({ route: sendRoute, bytes, signal: activeSignal });
        } catch (error) {
          failure = error;
          if (error instanceof PipingRetirementError) throw error;
          if (!activeSignal.aborted && error instanceof AttemptError && needsSenderRepair({ kind: error.kind })) {
            // The failed POST is joined before this same send lane becomes a repair GET.
            await endpoint.repair({ route: sendRoute, signal: activeSignal });
          }
          if (!activeSignal.aborted && (!(error instanceof AttemptError) || error.kind === 'fatal')) throw error;
        } finally {
          this.active = undefined;
          if (entry) {
            entry.state = 'settled'; entry.cancel();
            if (entry.signal.aborted) entry.completion.reject(entry.signal.reason);
            else if (failure !== undefined) entry.completion.reject(failure);
            else entry.completion.resolve();
          }
        }
        await sleep({ milliseconds: minimumMs, signal: this.stop.signal });
      }
    };
    const receiver = async () => {
      while (!this.stop.signal.aborted) {
        try {
          const envelope = decodePeerEnvelope({ bytes: await endpoint.receive({ route: receiveRoute, signal: this.stop.signal }) });
          if (envelope) {
            switch (envelope.kind) {
            case 'hello': onHello({ bytes: envelope.body }); break;
            case 'routed': {
              const key = `${envelope.channel}/${envelope.route}`, receiver = this.receives.get(key);
              if (receiver) {
                this.receives.delete(key); receiver.cancel(); receiver.completion.resolve(envelope.body);
              } else if (this.routeOwners.has(key)) this.buffered.set(key, envelope.body);
              break;
            }
            default: { const exhaustive: never = envelope; throw new Error(String(exhaustive)); }
            }
          }
        } catch (error) {
          if (error instanceof PipingRetirementError) throw error;
          this.stop.signal.throwIfAborted();
          if (!(error instanceof AttemptError) || error.kind === 'fatal') throw error;
        }
        // Includes malformed envelopes and unknown virtual routes.
        await sleep({ milliseconds: minimumMs, signal: this.stop.signal });
      }
    };
    this.closed = Promise.all([guard({ task: sender }), guard({ task: receiver })]).then(() => {
      for (const entry of this.sends.splice(0)) {
        entry.state = 'settled'; entry.cancel(); entry.completion.reject(this.stop.signal.reason);
      }
      for (const receiver of this.receives.values()) {
        receiver.cancel(); receiver.completion.reject(this.stop.signal.reason);
      }
      this.receives.clear(); this.buffered.clear(); for (const owner of this.routeOwners.values()) owner.cancel(); this.routeOwners.clear(); this.hello = undefined; signal.removeEventListener('abort', forward);
      if (this.failure !== undefined) throw this.failure;
    });
    void this.closed.catch(() => {});
  }
  setHello({ bytes }: { bytes: Uint8Array | undefined }): void {
    this.stop.signal.throwIfAborted();
    this.hello = bytes === undefined ? undefined : encodePeerEnvelope({ envelope: { kind: 'hello', body: ownBytes({ bytes, maxBytes: 128 }) } });
    this.nextHello = 0;
    // Fresh local intent/candidate selection may wake a POST carrying obsolete peer data.
    this.active?.stop.abort(new AttemptError({ kind: 'transient' })); this.pulse.fire();
  }
  interrupt({ channel }: { channel: string }): void {
    if (this.active?.entry?.channel === channel) this.active.stop.abort(new AttemptError({ kind: 'transient' }));
  }
  abort({ reason }: { reason: unknown }): void {
    this.stop.abort(reason);
  }

  transport({ channel, origin, signal }: { channel: string; origin: string; signal: AbortSignal }): FiniteTransport {
    const parent = AbortSignal.any([signal, this.stop.signal]); let sending = false;
    const enqueue = ({ envelope, signal }: { envelope: PeerEnvelope; signal: AbortSignal }): Promise<void> => {
      signal.throwIfAborted(); requireValue({ condition: this.sends.length < 4, message: 'Bounded physical send owners' });
      const completion = Promise.withResolvers<void>(); void completion.promise.catch(() => {});
      const abort = () => {
        switch (entry.state) {
        case 'settled': return;
        case 'active': if (this.active?.entry === entry) this.active.stop.abort(signal.reason); return;
        case 'queued': break;
        default: { const exhaustive: never = entry.state; throw new Error(String(exhaustive)); }
        }
        const index = this.sends.indexOf(entry); if (index >= 0) this.sends.splice(index, 1);
        entry.state = 'settled'; entry.cancel(); completion.reject(signal.reason);
      };
      const entry: Send = { bytes: encodePeerEnvelope({ envelope }), channel, signal, completion, state: 'queued', cancel: () => signal.removeEventListener('abort', abort) };
      signal.addEventListener('abort', abort, { once: true }); this.sends.push(entry); if (signal.aborted) abort(); this.pulse.fire();
      return completion.promise;
    };
    return {
      origin,
      send: async ({ route, bytes, signal }) => {
        requireValue({ condition: !sending, message: 'One virtual POST owner' }); sending = true;
        try {
          await enqueue({ envelope: { kind: 'routed', channel, route, body: new Uint8Array(bytes) }, signal: AbortSignal.any([parent, signal]) });
        } finally {
          sending = false;
        }
      },
      receive: ({ route, signal }) => {
        const receiveSignal = AbortSignal.any([parent, signal]); receiveSignal.throwIfAborted();
        const key = `${channel}/${route}`;
        if (!this.routeOwners.has(key)) {
          requireValue({ condition: this.routeOwners.size < 8, message: 'Bounded virtual route owners' });
          const retire = () => {
            this.routeOwners.get(key)?.cancel(); this.routeOwners.delete(key); this.buffered.delete(key);
          };
          this.routeOwners.set(key, { signal: receiveSignal, cancel: () => receiveSignal.removeEventListener('abort', retire) });
          receiveSignal.addEventListener('abort', retire, { once: true });
        }
        const buffered = this.buffered.get(key);
        if (buffered) {
          this.buffered.delete(key); return Promise.resolve(buffered);
        }
        requireValue({ condition: !this.receives.has(key) && this.receives.size < 8, message: 'Bounded virtual GET owners' });
        const completion = Promise.withResolvers<Uint8Array>(); void completion.promise.catch(() => {});
        const abort = () => {
          if (this.receives.get(key) === receiver) this.receives.delete(key); receiver.cancel(); completion.reject(receiveSignal.reason);
        };
        const receiver: Receive = { completion, cancel: () => receiveSignal.removeEventListener('abort', abort) };
        this.receives.set(key, receiver); receiveSignal.addEventListener('abort', abort, { once: true }); if (receiveSignal.aborted) abort();
        return completion.promise;
      },
      // Physical send already performed and joined any required sender repair.
      repair: async ({ signal }) => {
        AbortSignal.any([parent, signal]).throwIfAborted();
      },
    };
  }
}
export const TEST_ONLY = {
};
