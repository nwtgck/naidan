import { z } from 'zod';
import { ascii, equalBytes, fields, ownBytes, Pulse, requireValue } from './bytes';
import { Deadline, FiniteEndpoint, sleep } from './finite';
import { PipingRetirementError } from './lifetime';
import type { NaidanPipingIdentity } from './noise-xx';
import { NaidanPipingDuplexSession, validateDuplexOptions } from './naidan-piping-duplex-session';
import type { NaidanPipingDuplexOptions } from './naidan-piping-duplex-session';
import { PeerMailbox } from './peer-mailbox';
import { pinnedPeerRoutes } from './peer-routes';
import { OwnedPeerSession } from './peer-session';
import type { NaidanPipingPeerCandidate } from './peer-session';
import { isInitiator } from './role';
import type { NaidanPipingRole } from './role';

type Hello = { cycle: Uint8Array; attempt: Uint8Array; echoCycle: Uint8Array; echoAttempt: Uint8Array };
const token = z.instanceof(Uint8Array).refine(bytes => bytes.length === 32 && bytes.some(Boolean));
const helloSchema = z.strictObject({ cycle: token, attempt: token, echoCycle: z.instanceof(Uint8Array).refine(bytes => bytes.length === 32), echoAttempt: z.instanceof(Uint8Array).refine(bytes => bytes.length === 32) });
type Slot = {
  peer: Hello; stop: AbortController; owner: OwnedPeerSession | undefined;
  state: 'preparing' | 'offered' | 'active'; delivered: boolean; done: Promise<void>;
};
function same({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  return equalBytes({ left, right });
}
function copyHello({ hello }: { hello: Hello }): Hello {
  return { cycle: hello.cycle.slice(), attempt: hello.attempt.slice(), echoCycle: hello.echoCycle.slice(), echoAttempt: hello.echoAttempt.slice() };
}

/** Long-lived pinned routing owner. RPC alone decides when a candidate may replace a link. */
export class NaidanPipingPeerEndpoint {
  private readonly stopController = new AbortController();
  private readonly changed = new Pulse();
  private readonly completion = Promise.withResolvers<void>();
  private readonly jobs = new Set<Promise<void>>();
  private mailbox!: PeerMailbox;
  private wanted = false;
  private cycle = new Uint8Array(32);
  private attempt = new Uint8Array(32);
  private peer: Hello | undefined;
  private nextReplyAt = 0;
  private replyTimer: ReturnType<typeof setTimeout> | undefined;
  private candidate: Slot | undefined;
  private current: Slot | undefined;
  private fencedPeerCycle: Uint8Array | undefined;
  private terminalFailure: unknown;
  private iteratorOwned = false;
  private nextOwned = false;
  private restart = Promise.resolve();
  private cycleStarting = false;
  readonly closed = this.completion.promise;
  private readonly options: {
    piping: NaidanPipingDuplexOptions; identity: NaidanPipingIdentity; expectedPeer: Uint8Array;
    purpose: string; role: NaidanPipingRole; publicHandshakeData: Uint8Array | undefined; handshakeData: Uint8Array | undefined;
  };
  private constructor({ options }: { options: NaidanPipingPeerEndpoint['options'] }) {
    this.options = options;
    void this.closed.catch(() => {});
  }

  static async create({ piping, identity, expectedPeer, purpose, publicHandshakeData, handshakeData, signal }: {
    piping: NaidanPipingDuplexOptions; identity: NaidanPipingIdentity; expectedPeer: Uint8Array; purpose: string;
    publicHandshakeData: Uint8Array | undefined; handshakeData: Uint8Array | undefined; signal: AbortSignal;
  }): Promise<NaidanPipingPeerEndpoint> {
    const settings = validateDuplexOptions({ piping });
    const local = { privateKey: identity.privateKey, publicKey: ownBytes({ bytes: identity.publicKey, maxBytes: 32 }) };
    const pin = ownBytes({ bytes: expectedPeer, maxBytes: 32 });
    const publicData = publicHandshakeData === undefined ? undefined : ownBytes({ bytes: publicHandshakeData, maxBytes: 256 });
    const privateData = handshakeData === undefined ? undefined : ownBytes({ bytes: handshakeData, maxBytes: 463 });
    const routes = await pinnedPeerRoutes({ identity: local, expectedPeer: pin, origin: settings.baseUrl, purpose, signal });
    signal.throwIfAborted();
    const endpoint = new NaidanPipingPeerEndpoint({
      options: {
        piping: settings,
        identity: local,
        expectedPeer: pin,
        purpose,
        role: routes.role,
        publicHandshakeData: publicData,
        handshakeData: privateData,
      },
    });
    const transport = new FiniteEndpoint({
      baseUrl: settings.baseUrl,
      policy: settings.policy,
      timeoutMs: settings.requestTimeoutMs,
      repairTimeoutMs: settings.repairTimeoutMs,
      headers: settings.headers,
    });
    const forward = () => endpoint.stop({ reason: 'Pinned endpoint parent stopped' });
    signal.addEventListener('abort', forward, { once: true });
    endpoint.mailbox = new PeerMailbox({
      endpoint: transport,
      sendRoute: routes.send,
      receiveRoute: routes.receive,
      signal: endpoint.stopController.signal,
      minimumMs: settings.pacing.minimumMs,
      helloIntervalMs: settings.pacing.idleResendIntervalMs,
      onHello: ({ bytes }) => endpoint.receiveHello({ bytes }),
    });
    void endpoint.mailbox.closed.then(() => endpoint.stop({ reason: 'Pinned mailbox stopped' }), error => {
      endpoint.terminalFailure ??= error; endpoint.stop({ reason: 'Pinned mailbox failed' });
    });
    if (signal.aborted) forward();
    void (async () => {
      if (!endpoint.stopController.signal.aborted) await new Promise<void>(resolve => endpoint.stopController.signal.addEventListener('abort', () => resolve(), { once: true }));
      const results = await Promise.allSettled([endpoint.mailbox.closed, endpoint.restart, ...endpoint.jobs]);
      for (const result of results) if (result.status === 'rejected' && result.reason instanceof PipingRetirementError) endpoint.terminalFailure ??= result.reason;
      signal.removeEventListener('abort', forward);
      endpoint.options.publicHandshakeData?.fill(0); endpoint.options.handshakeData?.fill(0);
      endpoint.changed.fire();
      if (endpoint.terminalFailure !== undefined) endpoint.completion.reject(endpoint.terminalFailure); else endpoint.completion.resolve();
    })();
    return endpoint;
  }
  beginCycle(): void {
    this.stopController.signal.throwIfAborted();
    if (this.wanted && (this.candidate || (this.current?.owner && !this.current.owner.hasEnded))) return;
    this.wanted = true;
    if (this.cycleStarting) return;
    this.cycleStarting = true;
    this.restart = this.restart.then(async () => {
      if (this.candidate) {
        this.candidate.stop.abort(new Error('Local cycle changed')); this.candidate.owner?.reject({ reason: 'Local cycle changed' }); await this.candidate.done;
      }
      if (this.current) await this.current.owner?.closed;
      this.stopController.signal.throwIfAborted();
      this.cycle = crypto.getRandomValues(new Uint8Array(32)); this.attempt = crypto.getRandomValues(new Uint8Array(32)); this.fencedPeerCycle = undefined;
      this.publishHello();
    }).catch(error => {
      if (!this.stopController.signal.aborted || error instanceof PipingRetirementError) {
        this.terminalFailure ??= error; this.stop({ reason: 'Local cycle retirement failed' });
      }
    }).finally(() => {
      this.cycleStarting = false;
    });
  }
  private publishHello(): void {
    if (!this.wanted || this.stopController.signal.aborted || !this.cycle.some(Boolean)) return;
    const bytes = new Uint8Array(128); bytes.set(this.cycle); bytes.set(this.attempt, 32);
    if (this.peer) {
      bytes.set(this.peer.cycle, 64); bytes.set(this.peer.attempt, 96);
    }
    this.mailbox.setHello({ bytes });
  }
  private replyHello(): void {
    if (this.candidate || this.stopController.signal.aborted || !this.wanted) return;
    const remaining = this.nextReplyAt - performance.now();
    if (remaining <= 0) {
      clearTimeout(this.replyTimer); this.replyTimer = undefined;
      this.nextReplyAt = performance.now() + this.options.piping.pacing.retryBaseMs; this.publishHello();
    } else if (this.replyTimer === undefined) this.replyTimer = setTimeout(() => {
      this.replyTimer = undefined; this.replyHello();
    }, remaining);
  }
  private receiveHello({ bytes }: { bytes: Uint8Array }): void {
    if (!this.wanted || this.stopController.signal.aborted || !this.cycle.some(Boolean)) return;
    const result = helloSchema.safeParse({ cycle: bytes.slice(0, 32), attempt: bytes.slice(32, 64), echoCycle: bytes.slice(64, 96), echoAttempt: bytes.slice(96, 128) });
    if (!result.success) return;
    const hello = result.data;
    if (this.current && same({ left: this.current.peer.cycle, right: hello.cycle })) return;
    if (this.fencedPeerCycle && same({ left: this.fencedPeerCycle, right: hello.cycle })) return;
    const changed = !this.peer || !same({ left: this.peer.cycle, right: hello.cycle }) || !same({ left: this.peer.attempt, right: hello.attempt });
    this.peer = copyHello({ hello });
    if (this.candidate) return;
    if (changed) this.replyHello();
    // A tuple is selected only after this peer echoed our current offer. It is
    // still untrusted: no old session ends until fresh pinned Noise succeeds.
    if (!same({ left: hello.echoCycle, right: this.cycle }) || !same({ left: hello.echoAttempt, right: this.attempt })) return;
    this.startCandidate({ peer: hello });
  }
  private startCandidate({ peer }: { peer: Hello }): void {
    const stop = new AbortController();
    const slot: Slot = { peer: copyHello({ hello: peer }), stop, owner: undefined, state: 'preparing', delivered: false, done: Promise.resolve() };
    this.candidate = slot;
    const localCycle = this.cycle.slice(), localAttempt = this.attempt.slice();
    const job = (async () => {
      const deadline = new Deadline({ parent: AbortSignal.any([this.stopController.signal, stop.signal]), milliseconds: this.options.piping.handshakeResponseTimeoutMs });
      let established = false;
      try {
        const ordered = isInitiator({ role: this.options.role }) ? [localCycle, localAttempt, peer.cycle, peer.attempt] : [peer.cycle, peer.attempt, localCycle, localAttempt];
        const binding = new Uint8Array(await crypto.subtle.digest('SHA-256', fields({ parts: [ascii({ text: 'naidan-pinned-candidate/v2' }), ascii({ text: this.options.purpose }), ...ordered] })));
        deadline.signal.throwIfAborted();
        const channel = btoa(String.fromCharCode(...binding)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
        const code = 'peer-' + Array.from(binding, byte => byte.toString(16).padStart(2, '0')).join('');
        const owner = new OwnedPeerSession({
          options: {
            contextId: binding,
            activationTimeoutMs: this.options.piping.handshakeResponseTimeoutMs,
            interrupt: () => this.mailbox.interrupt({ channel }),
            abortTransport: ({ reason }) => stop.abort(new Error(reason)),
            onEnded: ({ end }) => {
              switch (end.kind) {
              case 'peer-closed':
                this.fencedPeerCycle = peer.cycle.slice();
                if (this.current === slot && !this.stopController.signal.aborted) this.mailbox.setHello({ bytes: undefined });
                break;
              case 'local-stop': case 'response-unconfirmed': case 'record-exhausted': case 'authenticated-protocol-error': case 'authentication-budget-exhausted': case 'transport-fatal': break;
              default: { const exhaustive: never = end.kind; throw new Error(String(exhaustive)); }
              }
              this.changed.fire();
            },
          },
        });
        slot.owner = owner;
        const origin = new URL(this.options.piping.baseUrl).origin;
        const connection = await NaidanPipingDuplexSession.connectWithTransport({
          ...this.options,
          code,
          role: this.options.role,
          signal: deadline.signal,
          transports: { bootstrap: this.mailbox.transport({ channel, origin, signal: deadline.signal }), traffic: this.mailbox.transport({ channel, origin, signal: deadline.signal }) },
          onStreams: ({ streams }) => owner.attach({ streams }),
        });
        established = true;
        // Keep the lifetime parent but remove the finite establishment timer.
        deadline.stopTimer(); owner.established({ connection });
        if (this.stopController.signal.aborted || stop.signal.aborted) {
          owner.reject({ reason: 'Candidate no longer wanted' }); await owner.closed; return;
        }
        slot.state = 'offered'; this.mailbox.setHello({ bytes: undefined }); this.changed.fire();
        await owner.closed;
      } catch (error) {
        if (error instanceof PipingRetirementError) {
          this.terminalFailure ??= error; this.stop({ reason: 'Candidate physical retirement failed' });
        }
        slot.owner?.failed({ error });
      } finally {
        deadline.dispose();
        if (this.candidate === slot) this.candidate = undefined;
        if (this.current === slot) this.current = undefined;
        this.changed.fire();
      }
      if (!established && this.wanted && !stop.signal.aborted && !this.stopController.signal.aborted) {
        await sleep({ milliseconds: this.options.piping.pacing.retryBaseMs, signal: this.stopController.signal });
        this.attempt = crypto.getRandomValues(new Uint8Array(32)); this.publishHello();
      }
    })();
    slot.done = job; this.jobs.add(job);
    void job.catch(error => {
      if (!this.stopController.signal.aborted) {
        this.terminalFailure ??= error; this.stop({ reason: 'Candidate task failed' });
      }
    }).finally(() => this.jobs.delete(job));
  }
  get candidates(): AsyncIterable<NaidanPipingPeerCandidate> {
    return {
      [Symbol.asyncIterator]: () => {
        requireValue({ condition: !this.iteratorOwned, message: 'One peer candidate consumer' }); this.iteratorOwned = true;
        return {
          next: async (): Promise<IteratorResult<NaidanPipingPeerCandidate>> => {
            requireValue({ condition: !this.nextOwned, message: 'One pending candidate read' }); this.nextOwned = true;
            try {
              for (;;) {
                const revision = this.changed.revision;
                if (this.terminalFailure !== undefined) throw this.terminalFailure;
                if (this.stopController.signal.aborted) return { done: true, value: undefined };
                const slot = this.candidate;
                if (slot?.state === 'offered' && !slot.delivered && slot.owner) {
                  slot.delivered = true; const owner = slot.owner;
                  return {
                    done: false,
                    value: {
                      get peerIdentity() {
                        return owner.peerIdentity;
                      },
                      get peerPublicHandshakeData() {
                        return owner.peerPublicHandshakeData;
                      },
                      get peerHandshakeData() {
                        return owner.peerHandshakeData;
                      },
                      get contextId() {
                        return owner.contextId;
                      },
                      closed: owner.closed,
                      activate: async ({ signal }) => {
                        requireValue({ condition: this.current === undefined, message: 'Old logical session must retire before activation' });
                        const session = await owner.activate({ signal });
                        if (this.candidate !== slot || this.stopController.signal.aborted) {
                          owner.reject({ reason: 'Stale candidate activation' }); throw new Error('Stale candidate activation');
                        }
                        requireValue({ condition: this.current === undefined, message: 'Old logical session must retire before activation' });
                        slot.state = 'active'; this.current = slot; this.candidate = undefined; return session;
                      },
                      reject: ({ reason }) => owner.reject({ reason }),
                    },
                  };
                }
                await this.changed.wait({ revision, signal: undefined });
              }
            } finally {
              this.nextOwned = false;
            }
          },
        };
      },
    };
  }
  /** Fence new candidates while retaining the active transport for a bounded close notice. */
  async pause({ reason }: { reason: string }): Promise<void> {
    this.wanted = false;
    if (!this.stopController.signal.aborted) this.mailbox.setHello({ bytes: undefined });
    const candidate = this.candidate;
    candidate?.stop.abort(new Error(reason)); candidate?.owner?.reject({ reason });
    this.changed.fire();
    await candidate?.done;
  }
  stop({ reason }: { reason: string }): void {
    if (this.stopController.signal.aborted) return;
    this.wanted = false; clearTimeout(this.replyTimer); this.replyTimer = undefined; this.stopController.abort(new Error(reason));
    this.candidate?.stop.abort(new Error(reason)); this.candidate?.owner?.abort({ reason }); this.current?.stop.abort(new Error(reason)); this.current?.owner?.abort({ reason });
    this.mailbox?.abort({ reason: new Error(reason) }); this.changed.fire();
  }
}
export const TEST_ONLY = {
};
