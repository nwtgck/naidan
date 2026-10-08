import type { PeerControl, Snapshot } from './wire';
import { PrivateResponses } from '@/features/naidan-piping-duplex/private-responses';
import type { LivenessPolicy } from '@/features/naidan-piping-duplex/private-responses';
import { systemResponseClock } from '@/features/naidan-piping-duplex/response-window';
import type { ResponseClock } from '@/features/naidan-piping-duplex/response-window';
import { AuthenticatedProtocolError, AuthenticationBudgetExhaustedError, ConnectionLifetime, ResponseUnconfirmedError } from '@/features/naidan-piping-duplex/lifetime';
import type { NaidanPipingConnectionEndKind } from '@/features/naidan-piping-duplex/lifetime';
import { isInitiator } from '@/features/naidan-piping-duplex/role';
import { Pulse, requireValue } from '@/features/naidan-piping-duplex/bytes';
import { Machine, isFinished } from '@/features/naidan-piping-duplex/machine';
import { Records } from '@/features/naidan-piping-duplex/records';
import { encodeRecordPayload, receiptRequested } from '@/features/naidan-piping-duplex/wire';
import type { NaidanPipingKeyContext } from '@/features/naidan-piping-duplex/key-context';
export type NaidanPipingDuplexStream = {
    readonly id: number;
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly closed: Promise<void>;
    abort({ reason }: {
        reason: string;
    }): void;
};
export type PreparedTransmission = {
  kind: 'snapshot' | 'receipt-only';
  bytes: Uint8Array;
  /** Register ownership immediately before handing these bytes to the transport. */
  start({ onReceived }: { onReceived(): void }): () => void;
};
export class StreamSession {
  private responseHealthListener: (({ state }: { state: 'healthy' | 'checking' }) => void) | undefined;
  subscribeResponseHealth({ listener }: { listener({ state }: { state: 'healthy' | 'checking' }): void }): void {
    this.responseHealthListener = listener;
  }
  private peerControls: { snapshot(): PeerControl; validate({ control, snapshot }: { control: PeerControl | undefined; snapshot: Snapshot }): boolean; accept({ control }: { control: PeerControl | undefined }): void } | undefined;
  setPeerControls({ policy }: { policy: NonNullable<StreamSession['peerControls']> }): void {
    requireValue({ condition: this.peerControls === undefined, message: 'Peer controls already owned' }); this.peerControls = policy;
  }
  stopApplication(): void {
    this.internalMachine.abort(); this.internalNotify();
  }
  controlChanged(): void {
    this.internalTransportPulse.fire();
  }

  private internalMachine: Machine;
  private internalPulse = new Pulse();
  private internalTransportPulse = new Pulse();
  private internalStop = new AbortController();
  private internalSend: Records;
  private internalReceive: Records;
  private readonly lifetime = new ConnectionLifetime();
  readonly ended = this.lifetime.ended;
  private internalIncomingOwned = false;
  private internalIncomingEnded = false;
  private internalNextPending = false;
  private internalSnapshotBusy = false;
  private internalContextId: Uint8Array;
  private internalTransportOwner: object | undefined;
  private internalFacadeUpdates = new Map<number, () => void>();
  private internalLastSnapshotRevision = -1;
  private internalHighestOffered = -1n;
  private internalPeerReceived = -1n;
  private internalResponses: PrivateResponses | undefined;
  private internalEcho: Uint8Array | undefined;
  private internalTransmission: { number: bigint, receipt: 'waiting' | 'received', onReceived(): void } | undefined;
  readonly routes: {
        send: string;
        receive: string;
    };
  private constructor({ machine, send, receive, routes, contextId }: {
        machine: Machine;
        send: Records;
        receive: Records;
        routes: {
            send: string;
            receive: string;
        };
        contextId: Uint8Array;
    }) {
    this.internalMachine = machine; this.internalSend = send; this.internalReceive = receive; this.routes = Object.freeze({ ...routes }); this.internalContextId = contextId.slice();
  }
  static async create({ keys }: {
        keys: NaidanPipingKeyContext;
    }): Promise<StreamSession> {
    const domain = keys.createDomain({ label: 'piping-duplex-record/v3', context: keys.contextId });
    const tx = isInitiator({ role: keys.role }) ? 1 : 2, rx = isInitiator({ role: keys.role }) ? 2 : 1;
    const sendRoute = await domain.route({ direction: tx }), receiveRoute = await domain.route({ direction: rx });
    return new StreamSession({
      machine: new Machine({ role: keys.role }),
      contextId: keys.contextId,
      routes: { send: sendRoute, receive: receiveRoute },
      send: new Records({ domain, context: keys.contextId, direction: tx, usage: 'encrypt' }),
      receive: new Records({ domain, context: keys.contextId, direction: rx, usage: 'decrypt' }),
    });
  }
  get contextId(): Uint8Array {
    return this.internalContextId.slice();
  }
  claimTransport(): () => void {
    this.internalCheckSession();
    requireValue({ condition: this.internalTransportOwner === undefined, message: 'Session transport already owned' });
    const owner = {};
    this.internalTransportOwner = owner;
    return () => {
      if (this.internalTransportOwner === owner)
        this.internalTransportOwner = undefined;
    };
  }
  get failureReason(): Error | undefined {
    return this.lifetime.end?.error;
  }
  get stopped(): boolean {
    return this.lifetime.end !== undefined;
  }
  get revision(): number {
    return this.internalPulse.revision;
  }
  get transportRevision(): number {
    return this.internalTransportPulse.revision;
  }
  get stoppedSignal(): AbortSignal {
    return this.internalStop.signal;
  }
  waitForTransportChange({ revision, signal }: { revision: number, signal: AbortSignal }): Promise<void> {
    return this.internalTransportPulse.wait({ revision, signal });
  }
  debug(): object {
    return { ...this.internalMachine.debug(), sentRecords: this.internalSend.next.toString(), receivedRecord: this.internalReceive.high.toString() };
  }
  private internalNotify(): void {
    for (const update of [...this.internalFacadeUpdates.values()])
      update();
    this.internalPulse.fire();
    this.internalTransportPulse.fire();
  }
  private internalCheckSession(): void {
    const failure = this.lifetime.end;
    if (failure)
      throw failure.error;
  }
  private internalCheckStream({ id }: {
        id: number;
    }): void {
    const status = this.internalMachine.status({ id });
    switch (status) {
    case 'finished': return;
    case 'reset': throw new Error('Stream reset');
    case 'active': this.internalCheckSession(); return;
    default: { const unreachable: never = status; throw new Error(`Invalid stream state: ${unreachable}`); }
    }
  }
  async openStream({ signal }: {
        signal: AbortSignal | undefined;
    }): Promise<NaidanPipingDuplexStream> {
    this.internalCheckSession();
    signal?.throwIfAborted();
    const id = this.internalMachine.open();
    this.internalNotify();
    try {
      while (true) {
        const revision = this.internalPulse.revision;
        signal?.throwIfAborted();
        this.internalCheckStream({ id });
        if (this.internalMachine.accepted({ id }))
          return this.internalFacade({ id });
        await this.internalPulse.wait({ revision, signal });
      }
    } catch (error) {
      this.internalMachine.resetStream({ id });
      this.internalNotify();
      throw error;
    }
  }
  get incomingStreams(): AsyncIterable<NaidanPipingDuplexStream> {
    return {
      [Symbol.asyncIterator]: () => {
        requireValue({ condition: !this.internalIncomingOwned, message: 'Only one incoming iterator' });
        this.internalIncomingOwned = true;
        return {
          next: async (): Promise<IteratorResult<NaidanPipingDuplexStream>> => {
            requireValue({ condition: !this.internalNextPending, message: 'Only one pending incoming next' });
            this.internalNextPending = true;
            try {
              while (true) {
                const revision = this.internalPulse.revision;
                if (this.internalIncomingEnded)
                  return { done: true, value: undefined };
                this.internalCheckSession();
                const id = this.internalMachine.takeIncoming();
                if (id !== undefined) {
                  this.internalNotify();
                  return { done: false, value: this.internalFacade({ id }) };
                }
                if (this.internalMachine.incomingClosed()) {
                  this.internalIncomingEnded = true;
                  return { done: true, value: undefined };
                }
                await this.internalPulse.wait({ revision, signal: undefined });
              }
            } finally {
              this.internalNextPending = false;
            }
          },
          return: async (): Promise<IteratorResult<NaidanPipingDuplexStream>> => {
            this.internalIncomingEnded = true;
            this.internalMachine.stopIncoming();
            this.internalNotify();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }
  private internalFacade({ id }: {
        id: number;
    }): NaidanPipingDuplexStream {
    const closed = (async () => {
      while (true) {
        const revision = this.internalPulse.revision;
        this.internalCheckStream({ id });
        if (isFinished({ status: this.internalMachine.status({ id }) }))
          return;
        await this.internalPulse.wait({ revision, signal: undefined });
      }
    })();
    // The caller may choose not to observe this separate status promise.
    void closed.catch(() => { });
    const abort = ({ reason }: {
            reason: string;
        }) => {
      void reason;
      this.internalMachine.resetStream({ id });
      this.internalNotify();
    };
    let readCancelled = false, readEnded = false;
    let readController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let writeController: WritableStreamDefaultController | undefined;
    const readable = new ReadableStream<Uint8Array>({
      start: controller => {
        readController = controller;
      },
      // Standard callback signatures are positional by contract; own helpers are named.
      pull: async (controller) => {
        while (true) {
          if (readCancelled || readEnded)
            return;
          const revision = this.internalPulse.revision;
          this.internalCheckStream({ id });
          const result = this.internalMachine.read({ id });
          switch (result.kind) {
          case 'data':
            controller.enqueue(result.bytes);
            this.internalNotify();
            return;
          case 'end':
            if (!readEnded) {
              readEnded = true;
              controller.close();
            }
            return;
          case 'wait':
            await this.internalPulse.wait({ revision, signal: undefined });
            break;
          default: {
            const unreachable: never = result;
            throw new Error(String(unreachable));
          }
          }
        }
      },
      cancel: () => {
        readCancelled = true; this.internalMachine.cancelRead({ id }); this.internalNotify();
      },
    }, { highWaterMark: 0 });
    const writable = new WritableStream<Uint8Array>({
      start: controller => {
        writeController = controller;
        const stop = () => abort({ reason: 'Writer aborted' });
        controller.signal.addEventListener('abort', stop, { once: true });
        const remove = () => controller.signal.removeEventListener('abort', stop);
        void closed.then(remove, remove);
      },
      write: async (chunk) => {
        try {
          this.internalCheckStream({ id });
          requireValue({
            condition: chunk instanceof Uint8Array && chunk.buffer instanceof ArrayBuffer,
            message: 'A non-shared Uint8Array is required',
          });
          // A fixed-length view validates detachment without copying an arbitrarily large caller buffer.
          const input = chunk.subarray(0, chunk.byteLength), length = input.byteLength;
          this.internalMachine.checkWrite({ id, length });
          // The caller keeps its whole input immutable until this native write settles.
          for (let at = 0; at < length; at += 65536) {
            this.internalCheckStream({ id });
            requireValue({ condition: input.byteLength === length, message: 'Write input resized or detached' });
            // Copy only one bounded window before awaiting its peer acceptance.
            const end = this.internalMachine.write({ id, bytes: input.subarray(at, Math.min(length, at + 65536)) });
            this.internalNotify();
            while (true) {
              const revision = this.internalPulse.revision;
              this.internalCheckStream({ id });
              if (this.internalMachine.acknowledged({ id, end }))
                break;
              await this.internalPulse.wait({ revision, signal: undefined });
            }
          }
        } catch (error) {
          abort({ reason: 'Write failed' });
          throw error;
        }
      },
      close: async () => {
        this.internalCheckStream({ id });
        this.internalMachine.closeWrite({ id });
        this.internalNotify();
        while (true) {
          const revision = this.internalPulse.revision;
          this.internalCheckStream({ id });
          if (this.internalMachine.finalSeen({ id }))
            return;
          await this.internalPulse.wait({ revision, signal: undefined });
        }
      },
      abort: () => abort({ reason: 'Writer aborted' }),
    }, { highWaterMark: 65536, size: chunk => chunk.byteLength });
    const update = () => {
      try {
        this.internalCheckStream({ id });
        if (!readCancelled && !readEnded && this.internalMachine.readEnded({ id })) {
          readEnded = true;
          readController?.close();
        }
        if (isFinished({ status: this.internalMachine.status({ id }) }) && (readEnded || readCancelled))
          this.internalFacadeUpdates.delete(id);
      } catch (error) {
        readEnded = true;
        readController?.error(error);
        // Native abort owns its state transition. Do not error reentrantly from its signal listener.
        if (writeController && !writeController.signal.aborted)
          writeController.error(error);
        this.internalFacadeUpdates.delete(id);
      }
    };
    this.internalFacadeUpdates.set(id, update);
    update();
    return { id, readable, writable, closed, abort };
  }
  /** Internal readiness is available only after the managed owner starts responses. */
  get firstResponse(): Promise<void> {
    if (!this.internalResponses) throw new Error('Response owner not started');
    return this.internalResponses.ready;
  }
  /** Managed owner starts this once, before the runner's first payload snapshot. */
  startResponses({ policy, clock = systemResponseClock }: { policy: LivenessPolicy; clock?: ResponseClock }): void {
    this.internalCheckSession();
    requireValue({ condition: this.internalResponses === undefined, message: 'Response owner already started' });
    const responses = new PrivateResponses({
      policy,
      clock,
      wake: () => this.internalTransportPulse.fire(),
      onFailure: ({ error }) => {
        this.fail({ kind: error instanceof ResponseUnconfirmedError ? 'response-unconfirmed' : 'transport-fatal', error });
      },
    });
    this.internalResponses = responses;
    responses.subscribe({ listener: ({ state }) => this.responseHealthListener?.({ state }) });
    responses.start();
  }
  retireResponses(): void {
    this.internalResponses?.retire();
  }
  async makeCapsule({ reason }: { reason: 'update' | 'idle-resend' }): Promise<PreparedTransmission> {
    this.internalCheckSession();
    requireValue({ condition: !this.internalSnapshotBusy, message: 'Only one snapshot writer' });
    this.internalSnapshotBusy = true;
    try {
      const revision = this.internalPulse.revision;
      const fullSnapshot = (() => {
        switch (reason) {
        case 'idle-resend': return true;
        case 'update': return revision !== this.internalLastSnapshotRevision;
        default: { const unreachable: never = reason; throw new Error(String(unreachable)); }
        }
      })();
      // A receipt-only transmission does not advance Machine's DATA cursor or
      // offered offsets. Regular idle resends still carry the complete snapshot.
      const snapshot = fullSnapshot ? this.internalMachine.snapshot()
        : this.internalMachine.receiptSnapshot();
      const receiptRequest = fullSnapshot ? 'requested' : 'not-requested';
      const challenge = this.internalResponses?.challenge(), echo = this.internalEcho?.slice(), control = this.peerControls?.snapshot();
      const number = this.internalSend.next;
      const receivedRecord = this.internalReceive.high < 0n ? undefined : this.internalReceive.high;
      const bytes = await this.internalSend.seal({ plaintext: encodeRecordPayload({ payload: { snapshot, receiptRequest, receivedRecord, challenge, echo, ...(control === undefined ? {} : { control }) } }) });
      this.internalCheckSession();
      let started = false;
      return {
        kind: fullSnapshot ? 'snapshot' : 'receipt-only',
        bytes,
        start: ({ onReceived }) => {
          this.internalCheckSession();
          requireValue({
            condition: !started && this.internalTransmission === undefined && number > this.internalHighestOffered,
            message: 'Transmission already offered or owned',
          });
          started = true;
          const owner = { number, receipt: 'waiting' as const, onReceived };
          this.internalTransmission = owner;
          this.internalHighestOffered = number;
          this.internalMachine.markOffered({ snapshot });
          if (fullSnapshot) this.internalLastSnapshotRevision = revision;
          return () => {
            if (this.internalTransmission === owner) this.internalTransmission = undefined;
          };
        },
      };
    } finally {
      this.internalSnapshotBusy = false;
    }
  }
  async acceptCapsule({ capsule }: {
        capsule: Uint8Array;
    }): Promise<'accepted' | 'stale' | 'unauthenticated'> {
    this.internalCheckSession();
    try {
      let changed = false, reply = false, challenge: Uint8Array | undefined, echo: Uint8Array | undefined, control: PeerControl | undefined;
      const outcome = await this.internalReceive.accept({
        capsule,
        apply: ({ snapshot, receiptRequest, receivedRecord, challenge: incomingChallenge, echo: incomingEcho, control: incomingControl }) => {
          this.internalCheckSession();
          // Validate before Machine commits; malformed stream state and receipts
          // must never partially confirm a response or advance offsets.
          requireValue({ condition: receivedRecord === undefined || receivedRecord <= this.internalHighestOffered, message: 'Receipt for an unoffered record' });
          const applyApplication = this.peerControls?.validate({ control: incomingControl, snapshot }) !== false;
          changed = applyApplication && this.internalMachine.accept({ snapshot });
          control = incomingControl;
          if (receivedRecord !== undefined && receivedRecord > this.internalPeerReceived) this.internalPeerReceived = receivedRecord;
          reply = receiptRequested({ request: receiptRequest });
          challenge = incomingChallenge; echo = incomingEcho;
        },
      });
      switch (outcome) {
      case 'accepted': {
        this.peerControls?.accept({ control });
        // Only after Records commits its authenticated high number can metadata
        // confirm readiness. Malformed snapshots/receipts never reach this point.
        this.internalResponses?.accept({ echo });
        if (challenge !== undefined) this.internalEcho = challenge.slice();
        // Same-token requests in newer records can recover a lost echo. An
        // echo-only record does not recursively request another control record.
        if (changed) this.internalNotify(); else if (reply || challenge !== undefined) this.internalTransportPulse.fire();
        const owner = this.internalTransmission;
        if (owner?.receipt === 'waiting' && this.internalPeerReceived === owner.number) {
          owner.receipt = 'received';
          owner.onReceived();
        }
        break;
      }
      case 'stale': case 'unauthenticated': break;
      default: { const unreachable: never = outcome; throw new Error(String(unreachable)); }
      }
      return outcome;
    } catch (error) {
      this.fail({
        kind: error instanceof AuthenticationBudgetExhaustedError ? 'authentication-budget-exhausted'
          : error instanceof AuthenticatedProtocolError ? 'authenticated-protocol-error' : 'transport-fatal',
        error,
      });
      throw this.lifetime.end?.error;
    }
  }
  async drain({ signal }: {
        signal: AbortSignal | undefined;
    }): Promise<void> {
    this.internalCheckSession();
    this.internalMachine.drain();
    this.internalNotify();
    while (true) {
      const revision = this.internalPulse.revision;
      this.internalCheckSession();
      signal?.throwIfAborted();
      if (!this.internalMachine.hasActive())
        return;
      await this.internalPulse.wait({ revision, signal });
    }
  }
  abort({ reason }: {
        reason: string;
    }): void {
    this.fail({ kind: 'local-stop', error: new Error(reason) });
  }
  /** Internal owners supply a local classification; incoming bytes cannot select it. */
  fail({ kind, error }: { kind: NaidanPipingConnectionEndKind; error: unknown }): void {
    if (this.lifetime.end) return;
    const outcome = this.lifetime.commit({ kind, error });
    this.internalStop.abort(outcome.error);
    this.internalMachine.abort();
    this.internalResponses?.stop({ error: outcome.error });
    this.internalEcho = undefined;
    this.internalNotify();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
