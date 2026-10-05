import { nanoid } from 'nanoid';
import { expose, NaidanRpcPeer } from '@/features/naidan-rpc';
import type { NaidanRpcTransport } from '@/features/naidan-rpc';
import type { NaidanPipingIdentity, NaidanPipingPeerVerifier, NaidanPipingRole } from '@/features/naidan-piping-duplex';
import type { NaidanRpcConnection, NaidanRpcTransportSettings } from '@/01-models/naidan-rpc';
import { idToRaw, toNaidanRpcConnectionId, toNaidanRpcPeerId } from '@/01-models/ids';
import type { NaidanRpcConnectionId } from '@/01-models/ids';
import type { NaidanRpcStorage } from '@/00-storage/service/naidan-rpc';
import { validateRpcTransport } from '@/00-storage/service/naidan-rpc';
import { naidanPeerContract, peerAllowedMethodsSchema } from '@/features/naidan-peer-rpc/contract';
import type { NaidanPeerClient, NaidanPeerMethodName } from '@/features/naidan-peer-rpc/contract';
import { createNaidanPeerImplementation } from '@/features/naidan-peer-rpc/implementation';
import type { InferenceDependencies } from '@/features/naidan-peer-rpc/handlers/inference/handlers';
import { createMethodAccess } from '@/features/naidan-peer-rpc/access/method-access';
import { encodePeerKey, decodePeerKey } from './identity';
import type { RpcOwnerLease } from './owner';

type Names = readonly NaidanPeerMethodName[];
export type RpcLink = NaidanRpcTransport & { readonly peerIdentity: Uint8Array, abort({ reason }: { reason: string }): void };
/** A caller is pinned to one authenticated session, never a reconnecting lookup.
 * Labels are display metadata; peerId is the identity used for provenance. */
export type RpcClientBinding = {
  readonly connection: Readonly<Pick<NaidanRpcConnection, 'id' | 'peerId' | 'label'>>,
  readonly client: NaidanPeerClient,
  readonly signal: AbortSignal,
};
export type RpcConnectionPhase = 'disconnected' | 'connecting' | 'connected' | 'stopping';
export type RpcConnectionView = {
  connection: NaidanRpcConnection,
  phase: RpcConnectionPhase,
  persistence: 'temporary' | 'saved',
  access: ReturnType<typeof createMethodAccess>['state'] extends () => infer T ? T : never,
  failure: string | undefined,
};
type Entry = {
  connection: NaidanRpcConnection, persistence: 'temporary' | 'saved', phase: RpcConnectionPhase,
  stale: boolean, removed: boolean,
  stop: AbortController, link: RpcLink | undefined, rpc: NaidanRpcPeer | undefined,
  access: ReturnType<typeof createMethodAccess>, startup: Promise<void> | undefined,
  closing: Promise<void> | undefined, mutation: Promise<void> | undefined, change: 'idle' | 'remembering' | 'editing' | 'forgetting', failure: string | undefined,
};
export type RpcManagerDependencies = {
  storage: NaidanRpcStorage,
  identity(): Promise<NaidanPipingIdentity>,
  acquireOwner({ signal }: { signal: AbortSignal }): Promise<RpcOwnerLease>,
  open({ settings, identity, peerKey, code, role, verifyPeer, signal }: {
    settings: NaidanRpcTransportSettings, identity: NaidanPipingIdentity, peerKey: string | undefined,
    code: string | undefined, role: NaidanPipingRole | undefined, verifyPeer: NaidanPipingPeerVerifier | undefined, signal: AbortSignal,
  }): Promise<RpcLink>,
  inference: InferenceDependencies,
  retireResources(): Promise<void>,
  changed(): void,
};
function isSaved({ persistence }: { persistence: Entry['persistence'] }): boolean {
  switch (persistence) {
  case 'saved': return true;
  case 'temporary': return false;
  default: { const exhaustive: never = persistence; throw new Error(String(exhaustive)); }
  }
}
function copyConnection({ connection }: { connection: NaidanRpcConnection }): NaidanRpcConnection {
  const { id, peerId, localPublicKey, label, transport, allowedMethods, revision, ...rest } = connection;
  rest satisfies Record<PropertyKey, never>;
  return { id, peerId, localPublicKey, label, transport: validateRpcTransport({ value: transport }), allowedMethods: [...allowedMethods], revision };
}

/** Owns connections independently of Settings, Chat and image components.
 * Only explicit commands acquire transport/identity ownership. Reading a
 * client, loading settings or listing records never reconnects. */
export class NaidanPeerManager {
  private readonly entries = new Map<NaidanRpcConnectionId, Entry>();
  private enabled = false;
  private registryEpoch = 0;
  private reloadSequence = 0;
  private validation: Promise<void> | undefined;
  private validationHints = 0;
  private readonly registryMutations = new Set<Promise<void>>();
  private lifetime = new AbortController();
  private owner: Promise<RpcOwnerLease> | undefined;
  private ownerEpoch = 0;
  private stopping: Promise<void> = Promise.resolve();
  private retirementFailure: { error: unknown } | undefined;
  private pairing: { stop: AbortController, task: Promise<NaidanRpcConnectionId> } | undefined;
  private readonly dependencies: RpcManagerDependencies;

  constructor({ dependencies }: { dependencies: RpcManagerDependencies }) {
    this.dependencies = dependencies;
  }
  private changed(): void {
    try {
      this.dependencies.changed();
    } catch { /* UI observation cannot own a session. */ }
  }
  isEnabled(): boolean {
    return this.enabled;
  }
  isPairing(): boolean {
    return this.pairing !== undefined;
  }
  list(): RpcConnectionView[] {
    return [...this.entries.values()].map(entry => ({ connection: copyConnection({ connection: entry.connection }),
      phase: entry.phase, persistence: entry.persistence, access: entry.access.state(), failure: entry.failure }));
  }
  async reload(): Promise<void> {
    const epoch = this.registryEpoch, sequence = ++this.reloadSequence;
    const records = await this.dependencies.storage.list();
    // Reads started before or during a write must never recreate deleted rows.
    // A second explicit reload also supersedes the older read, even if empty.
    if (epoch !== this.registryEpoch || sequence !== this.reloadSequence) return;
    for (const connection of records) {
      // A stale reload must not overwrite a live session or a dirty restriction.
      const entry = this.entries.get(connection.id);
      if (!entry) this.add({ connection, persistence: 'saved' });
      else if (entry.stale && entry.phase === 'disconnected' && entry.change === 'idle') {
        // Explicit reload may update connection details, but never expands the
        // effective authority left by a failed restriction or external edit.
        if (entry.connection.peerId !== connection.peerId || entry.connection.localPublicKey !== connection.localPublicKey) continue;
        const parsed = peerAllowedMethodsSchema.safeParse(connection.allowedMethods);
        const initial = parsed.success ? entry.access.state().effective.filter(name => parsed.data.includes(name)) : [];
        entry.access.close(); entry.connection = copyConnection({ connection }); entry.stale = false;
        entry.access = this.access({ entry, initial });
        entry.failure = parsed.success ? undefined : 'Stored methods are not supported; no methods are provided';
      }
    }
    this.changed();
  }
  /** A hint from another tab or a resumed page is not authority. Suspend new
   * inbound calls before the read, then compare against this session's record.
   * Changed records require an explicit reload/reconnect; never adopt new grants. */
  revalidate(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const lifetime = this.lifetime.signal; this.validationHints++;
    if (this.validation) return this.validation;
    const entries = [...this.entries.values()].filter(entry => isSaved({ persistence: entry.persistence }));
    if (entries.length === 0) return Promise.resolve();
    for (const entry of entries) {
      if (entry.rpc && !entry.stop.signal.aborted) entry.rpc.setIncomingAdmission({ status: 'suspended' });
    }
    const task = (async () => {
      try {
        let records: NaidanRpcConnection[] | undefined;
        // Coalesce focus/pageshow/visibility hints. A hint arriving during the
        // storage read requires a newer read, not adoption of that stale result.
        for (let attempt = 0; attempt < 4; attempt++) {
          await Promise.all([...this.registryMutations].map(mutation => mutation.catch(() => {})));
          const epoch = this.registryEpoch, hint = this.validationHints;
          const listed = await this.dependencies.storage.list();
          if (lifetime.aborted) return;
          if (epoch === this.registryEpoch && hint === this.validationHints) {
            records = listed; break;
          }
        }
        if (!records) throw new Error('RPC settings changed repeatedly during validation');
        const byId = new Map(records.map(record => [record.id, record]));
        const closing: Promise<void>[] = [];
        for (const entry of entries) {
          if (this.entries.get(entry.connection.id) !== entry) continue;
          const record = byId.get(entry.connection.id);
          if (!record || JSON.stringify(copyConnection({ connection: record })) !== JSON.stringify(copyConnection({ connection: entry.connection }))) {
            entry.stale = true; entry.removed = record === undefined; entry.failure = 'RPC settings changed. Reload and reconnect explicitly.';
            switch (entry.phase) {
            case 'connecting': entry.stop.abort(); break;
            case 'disconnected': case 'connected': case 'stopping': closing.push(this.disconnect({ id: entry.connection.id }).then(() => {
              // Keep the row until physical retirement so master OFF also waits
              // for this entry before releasing the transport owner.
              if (!record && this.entries.get(entry.connection.id) === entry) {
                this.entries.delete(entry.connection.id); this.registryEpoch++;
              }
            })); break;
            default: { const exhaustive: never = entry.phase; throw new Error(String(exhaustive)); }
            }
          } else if (!entry.stale && entry.rpc && !entry.stop.signal.aborted) {
            entry.rpc.setIncomingAdmission({ status: 'open' });
          }
        }
        // Admission is already closed synchronously. A slow native retirement
        // must not block a newer storage check for another live connection.
        // disconnect keeps each row/owner until its actual work retires.
        void Promise.all(closing).catch(() => this.changed());
      } catch (error) {
        if (lifetime.aborted) return;
        for (const entry of entries) {
          if (this.entries.get(entry.connection.id) !== entry) continue;
          entry.stale = true; entry.failure = 'RPC settings could not be verified. Reload before reconnecting.';
          switch (entry.phase) {
          case 'connecting': entry.stop.abort(); break;
          case 'disconnected': case 'connected': case 'stopping': void this.disconnect({ id: entry.connection.id }).catch(() => {}); break;
          default: { const exhaustive: never = entry.phase; throw new Error(String(exhaustive)); }
          }
        }
        throw error;
      } finally {
        this.changed();
      }
    })();
    this.validation = task;
    const settled = () => {
      if (this.validation === task) this.validation = undefined;
    };
    void task.then(settled, settled); return task;
  }
  private trackRegistryMutation({ task }: { task: Promise<void> }): Promise<void> {
    this.registryEpoch++;
    this.registryMutations.add(task);
    const settled = () => {
      this.registryMutations.delete(task);
      this.registryEpoch++;
    };
    void task.then(settled, settled);
    return task;
  }
  setEnabled({ enabled }: { enabled: boolean }): Promise<void> {
    if (this.enabled === enabled) return this.stopping;
    this.enabled = enabled;
    if (enabled) {
      this.lifetime = new AbortController(); this.changed(); return this.stopping;
    }
    // Abort observers and lower links may synchronously reenter. Publish this
    // generation's join before calling them; OFF must never return an older,
    // already-resolved barrier while this generation is still retiring.
    const stopped = Promise.withResolvers<void>(); this.stopping = stopped.promise;
    void stopped.promise.catch(() => {});
    const previous = this.owner; this.owner = undefined; this.ownerEpoch++;
    const pairing = this.pairing?.task, pendingPair = this.pairing;
    const ids = [...this.entries.keys()];
    this.lifetime.abort(); pendingPair?.stop.abort();
    const closing = ids.map(id => this.disconnect({ id }));
    void (async () => {
      const connections = await Promise.allSettled([...closing, pairing?.catch(() => {}), ...[...this.registryMutations].map(task => task.catch(() => {}))]);
      // One failed iterator cleanup must not skip other links or cached native
      // resources. Report failure only after all owned cleanup has settled;
      // retaining the owner on failure prevents unsafe replacement/reconnection.
      const resources = await Promise.allSettled([Promise.resolve().then(() => this.dependencies.retireResources())]);
      for (const result of [...connections, ...resources]) {
        switch (result.status) {
        case 'fulfilled': break;
        case 'rejected': throw result.reason;
        default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
        }
      }
      if (this.retirementFailure) throw this.retirementFailure.error;
      const lease = await previous?.catch(() => undefined);
      lease?.release();
    })().then(stopped.resolve, stopped.reject);
    this.changed(); return stopped.promise;
  }
  private requireEntry({ id }: { id: NaidanRpcConnectionId }): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Select a registered RPC connection');
    return entry;
  }
  private async ensureOwner(): Promise<void> {
    if (!this.enabled) throw new Error('Naidan RPC is disabled');
    const epoch = this.ownerEpoch, signal = this.lifetime.signal;
    await this.stopping; await this.validation; signal.throwIfAborted();
    if (this.retirementFailure) throw this.retirementFailure.error;
    this.owner ??= this.dependencies.acquireOwner({ signal }).catch(error => {
      if (epoch === this.ownerEpoch) this.owner = undefined;
      throw error;
    });
    await this.owner;
    if (signal.aborted || epoch !== this.ownerEpoch) {
      // OFF owns the captured acquisition and releases it only after every
      // session/resource has retired. A late starter must not release it early.
      throw new Error('RPC ownership changed');
    }
  }
  private access({ entry, initial }: { entry: Entry, initial: Names }) {
    const stored = peerAllowedMethodsSchema.safeParse(entry.connection.allowedMethods);
    return createMethodAccess({ initial, stored: stored.success ? stored.data : [], revision: entry.connection.revision,
      persist: isSaved({ persistence: entry.persistence }) ? async ({ allowedMethods, expectedRevision }) => {
        const connection = { ...copyConnection({ connection: entry.connection }), allowedMethods, revision: expectedRevision + 1 };
        const revision = await this.dependencies.storage.update({ connection, expectedRevision });
        entry.connection = connection;
        return revision;
      } : undefined,
      apply: ({ allowedMethods }) => {
        if (!entry.stop.signal.aborted) entry.rpc?.setAllowedMethods({ contract: naidanPeerContract, allowedMethods });
      }, changed: () => this.changed(),
    });
  }
  private add({ connection, persistence }: { connection: NaidanRpcConnection, persistence: 'temporary' | 'saved' }): Entry {
    if (this.entries.size >= 32) throw new Error('Too many RPC connection records');
    const parsed = peerAllowedMethodsSchema.safeParse(connection.allowedMethods);
    const entry: Entry = { connection: copyConnection({ connection }), persistence, phase: 'disconnected', stale: false, removed: false, stop: new AbortController(),
      link: undefined, rpc: undefined, startup: undefined, closing: undefined, mutation: undefined, change: 'idle',
      failure: parsed.success ? undefined : 'Stored methods are not supported; no methods are provided',
      access: createMethodAccess({ initial: [], stored: [], revision: connection.revision, persist: undefined, apply: () => {}, changed: () => {} }),
    };
    entry.access = this.access({ entry, initial: parsed.success ? parsed.data : [] });
    this.entries.set(connection.id, entry); this.registryEpoch++; return entry;
  }
  private checkRoute({ peerKey, settings, except }: { peerKey: string, settings: NaidanRpcTransportSettings, except: Entry | undefined }): void {
    const origin = validateRpcTransport({ value: settings }).serverUrl;
    for (const entry of this.entries.values()) {
      if (entry !== except && entry.phase !== 'disconnected' && idToRaw({ id: entry.connection.peerId }) === peerKey &&
        entry.connection.transport.serverUrl === origin) throw new Error('This peer and server already have an active connection');
    }
  }
  private async discardUnacceptedLink({ link, reason }: { link: RpcLink, reason: string }): Promise<void> {
    let failure: { error: unknown } | undefined;
    try {
      link.abort({ reason });
    } catch (error) {
      failure = { error }; this.retirementFailure ??= failure;
    }
    // A startup error is not proof of lower retirement. Even a synchronous
    // abort failure must join the late link before startup stops owning it.
    await link.closed.catch(() => {});
    if (failure) throw failure.error;
  }
  private ready({ entry, link }: { entry: Entry, link: RpcLink }): void {
    entry.stop.signal.throwIfAborted();
    if (this.entries.get(entry.connection.id) !== entry || entry.change === 'forgetting') throw new Error('The connection is no longer current');
    if (!this.enabled) throw new Error('Naidan RPC is disabled');
    if (encodePeerKey({ bytes: link.peerIdentity }) !== idToRaw({ id: entry.connection.peerId })) throw new Error('The peer identity changed');
    this.checkRoute({ peerKey: idToRaw({ id: entry.connection.peerId }), settings: entry.connection.transport, except: entry });
    entry.link = link;
    entry.rpc = new NaidanRpcPeer({ transport: link, exports: [expose({ contract: naidanPeerContract,
      allowedMethods: entry.access.state().effective, implementation: createNaidanPeerImplementation({ inference: this.dependencies.inference }) })],
    limits: { maxCalls: 6, maxCallTimeoutMs: undefined }, signal: entry.stop.signal });
    // Revalidation may start after transport opening began. The constructor's
    // receive loop resumes asynchronously; suspend before publishing this peer.
    if (this.validation && isSaved({ persistence: entry.persistence })) entry.rpc.setIncomingAdmission({ status: 'suspended' });
    entry.phase = 'connected'; entry.failure = undefined; this.changed();
    const rpc = entry.rpc;
    const current = () => this.entries.get(entry.connection.id) === entry && entry.rpc === rpc;
    void rpc.closed.then(() => {
      if (current()) return this.disconnect({ id: entry.connection.id });
      return undefined;
    }, () => {
      if (!current()) return;
      entry.failure = 'RPC connection interrupted'; return this.disconnect({ id: entry.connection.id });
    }).catch(() => {});
  }
  async connect({ id }: { id: NaidanRpcConnectionId }): Promise<void> {
    const entry = this.requireEntry({ id });
    if (entry.stale) throw new Error('Reload the changed RPC connection before reconnecting');
    if (entry.phase !== 'disconnected' || entry.change !== 'idle') throw new Error('The connection is already active or being edited');
    // Reserve synchronously before awaiting either storage or ownership.
    entry.phase = 'connecting'; entry.stop = new AbortController(); entry.closing = undefined; entry.failure = undefined; this.changed();
    const signal = AbortSignal.any([entry.stop.signal, this.lifetime.signal]);
    entry.startup = (async () => {
      let link: RpcLink | undefined;
      try {
        await this.ensureOwner(); signal.throwIfAborted();
        await this.revalidate(); signal.throwIfAborted();
        if (entry.stale) throw new Error('Reload the changed RPC connection before reconnecting');
        this.checkRoute({ peerKey: idToRaw({ id: entry.connection.peerId }), settings: entry.connection.transport, except: entry });
        const identity = await this.dependencies.identity(); signal.throwIfAborted();
        if (encodePeerKey({ bytes: identity.publicKey }) !== entry.connection.localPublicKey) throw new Error('This connection belongs to a different local identity');
        link = await this.dependencies.open({ settings: copyConnection({ connection: entry.connection }).transport, identity,
          peerKey: idToRaw({ id: entry.connection.peerId }), code: undefined, role: undefined, verifyPeer: undefined, signal });
        signal.throwIfAborted(); this.ready({ entry, link });
      } catch (error) {
        let failure = error;
        try {
          if (link) await this.discardUnacceptedLink({ link, reason: 'RPC connection was not accepted' });
        } catch (cleanupError) {
          failure = cleanupError;
        }
        if (!entry.stop.signal.aborted) entry.failure = 'RPC connection could not be established';
        switch (entry.phase) {
        case 'stopping': break;
        case 'connecting': case 'connected': case 'disconnected': entry.phase = 'disconnected'; break;
        default: { const exhaustive: never = entry.phase; throw new Error(String(exhaustive)); }
        }
        if (entry.removed && entry.phase === 'disconnected' && this.entries.get(id) === entry) {
          this.entries.delete(id); this.registryEpoch++;
        }
        this.changed(); throw failure;
      }
    })();
    return entry.startup;
  }
  async pair({ settings, code, role, verifyPeer, signal }: {
    settings: NaidanRpcTransportSettings, code: string, role: NaidanPipingRole,
    verifyPeer: NaidanPipingPeerVerifier, signal: AbortSignal,
  }): Promise<NaidanRpcConnectionId> {
    if (!this.enabled || this.pairing) throw new Error('RPC is disabled or another pairing is pending');
    if (!/^[0-9]{4,8}$/.test(code)) throw new Error('Enter the same 4–8 digit number');
    const transport = validateRpcTransport({ value: settings });
    const stop = new AbortController(), combined = AbortSignal.any([stop.signal, this.lifetime.signal]);
    const requestAbort = () => stop.abort(signal.reason);
    signal.addEventListener('abort', requestAbort, { once: true });
    if (signal.aborted) requestAbort();
    const task = (async () => {
      let link: RpcLink | undefined;
      try {
        await this.ensureOwner(); combined.throwIfAborted();
        const identity = await this.dependencies.identity(); combined.throwIfAborted();
        link = await this.dependencies.open({ settings: transport, identity, peerKey: undefined, code, role, verifyPeer, signal: combined });
        combined.throwIfAborted();
        const publicKey = encodePeerKey({ bytes: link.peerIdentity }), localPublicKey = encodePeerKey({ bytes: identity.publicKey });
        decodePeerKey({ value: publicKey });
        if (publicKey === localPublicKey) throw new Error('Cannot connect to this device itself');
        this.checkRoute({ peerKey: publicKey, settings: transport, except: undefined });
        const id = toNaidanRpcConnectionId({ raw: nanoid() });
        const entry = this.add({ connection: { id, peerId: toNaidanRpcPeerId({ raw: publicKey }), localPublicKey,
          label: `Peer ${publicKey.slice(0, 8)}`, transport, allowedMethods: [], revision: 0 }, persistence: 'temporary' });
        this.ready({ entry, link });
        return id;
      } catch (error) {
        if (link) await this.discardUnacceptedLink({ link, reason: 'RPC pairing was not accepted' });
        throw error;
      }
    })();
    this.pairing = { stop, task }; this.changed();
    try {
      return await task;
    } finally {
      signal.removeEventListener('abort', requestAbort); if (this.pairing?.task === task) this.pairing = undefined; this.changed();
    }
  }
  cancelPairing(): void {
    this.pairing?.stop.abort();
  }
  /** Confirmation dialogs may outlive the session they describe. Capture an
   * opaque stop command, not a late ID lookup which could stop a reconnect. */
  prepareDisconnect({ id }: { id: NaidanRpcConnectionId }): () => Promise<void> {
    const entry = this.requireEntry({ id }), session = entry.stop;
    return () => {
      if (this.entries.get(id) !== entry || entry.stop !== session) return Promise.reject(new Error('The RPC session changed; confirm stopping it again'));
      return this.disconnect({ id });
    };
  }
  disconnect({ id }: { id: NaidanRpcConnectionId }): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.phase === 'disconnected') return Promise.resolve();
    if (entry.closing) return entry.closing;
    const restricted = entry.access.state().effective;
    // Reserve the teardown before invoking synchronous cancellation listeners.
    // Reentrant disconnect/feature-OFF joins the same operation, not a second
    // abort or a false success. Synchronous lower failures still join all work.
    const closed = Promise.withResolvers<void>(); entry.closing = closed.promise;
    void closed.promise.catch(() => {});
    const failures: unknown[] = [];
    entry.phase = 'stopping';
    const stopOperations = [() => entry.stop.abort(), () => entry.access.close(),
      () => entry.rpc?.dispose(), () => entry.link?.abort({ reason: 'RPC connection stopped explicitly' })];
    for (const stop of stopOperations) {
      try {
        stop();
      } catch (error) {
        failures.push(error);
      }
    }
    this.changed();
    void (async () => {
      await entry.startup?.catch(() => {});
      const cleanup = await Promise.allSettled([
        entry.mutation?.catch(() => {}), entry.rpc?.retire(),
        entry.link?.closed.catch(() => {}), entry.access.settled(),
      ]);
      for (const result of cleanup) {
        switch (result.status) {
        case 'fulfilled': break;
        case 'rejected': failures.push(result.reason); break;
        default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
        }
      }
      if (failures.length) throw failures[0];
      entry.rpc = undefined; entry.link = undefined; entry.phase = 'disconnected'; entry.startup = undefined;
      // A failed restriction save must not resurrect the old stored grants on reconnect.
      entry.access = this.access({ entry, initial: restricted });
      if (!isSaved({ persistence: entry.persistence }) || entry.removed) {
        this.entries.delete(id); this.registryEpoch++;
      }
      this.changed();
    })().then(closed.resolve, closed.reject);
    return closed.promise;
  }
  client({ id }: { id: NaidanRpcConnectionId }): NaidanPeerClient {
    return this.bindClient({ id }).client;
  }
  bindClient({ id }: { id: NaidanRpcConnectionId }): RpcClientBinding {
    if (!this.enabled) throw new Error('Naidan RPC is disabled');
    const entry = this.requireEntry({ id });
    if (entry.stale || this.validation) throw new Error('RPC settings need verification');
    if (entry.phase !== 'connected' || !entry.rpc || entry.stop.signal.aborted) throw new Error('Connect explicitly in the Naidan RPC settings tab first');
    return { connection: Object.freeze({ id, peerId: entry.connection.peerId, label: entry.connection.label }),
      client: entry.rpc.client({ contract: naidanPeerContract }), signal: entry.stop.signal };
  }
  async updateAllowedMethods({ id, allowedMethods }: { id: NaidanRpcConnectionId, allowedMethods: Names }): Promise<void> {
    const names = peerAllowedMethodsSchema.parse(allowedMethods);
    await this.ensureOwner();
    const entry = this.requireEntry({ id });
    if (entry.stale) throw new Error('Reload the changed RPC connection first');
    if (entry.change !== 'idle' || entry.phase === 'stopping') throw new Error('The connection is being changed');
    return this.trackRegistryMutation({ task: (async () => {
      await entry.access.update({ allowedMethods: names });
      if (!isSaved({ persistence: entry.persistence })) entry.connection = { ...entry.connection, allowedMethods: [...entry.access.state().effective] };
      this.changed();
    })() });
  }
  async remember({ id, label }: { id: NaidanRpcConnectionId, label: string | undefined }): Promise<void> {
    await this.ensureOwner();
    const entry = this.requireEntry({ id });
    if (entry.persistence !== 'temporary' || entry.phase !== 'connected' || entry.change !== 'idle') throw new Error('Only a verified live temporary connection can be remembered');
    entry.change = 'remembering';
    entry.mutation = this.trackRegistryMutation({ task: (async () => {
      try {
        await entry.access.settled();
        const identity = await this.dependencies.identity(); entry.stop.signal.throwIfAborted();
        const connection = { ...copyConnection({ connection: entry.connection }), label: label?.trim() || entry.connection.label,
          allowedMethods: [...entry.access.state().effective], revision: 0 };
        await this.dependencies.storage.remember({ connection, identity: { privateKey: identity.privateKey, publicKey: encodePeerKey({ bytes: identity.publicKey }) } });
        // Remembering does not grant any additional method or initiate a connection.
        entry.connection = connection; entry.persistence = 'saved';
        if (!entry.stop.signal.aborted) entry.access = this.access({ entry, initial: peerAllowedMethodsSchema.parse(connection.allowedMethods) });
      } finally {
        entry.change = 'idle'; this.changed();
      }
    })() });
    return entry.mutation;
  }

  async edit({ id, label, transport }: { id: NaidanRpcConnectionId, label: string, transport: NaidanRpcTransportSettings }): Promise<void> {
    const nextTransport = validateRpcTransport({ value: transport });
    await this.ensureOwner(); const entry = this.requireEntry({ id });
    if (entry.stale) throw new Error('Reload the changed RPC connection first');
    if (entry.change !== 'idle' || entry.phase !== 'disconnected') throw new Error('Disconnect before changing connection settings');
    entry.change = 'editing';
    return this.trackRegistryMutation({ task: (async () => {
      try {
        await entry.access.settled();
        const next = { ...copyConnection({ connection: entry.connection }), label: label.trim() || entry.connection.label,
          transport: nextTransport, allowedMethods: [...entry.access.state().effective], revision: entry.connection.revision + 1 };
        if (isSaved({ persistence: entry.persistence })) await this.dependencies.storage.update({ connection: next, expectedRevision: entry.connection.revision });
        entry.connection = next; entry.access = this.access({ entry, initial: peerAllowedMethodsSchema.parse(next.allowedMethods) });
      } finally {
        entry.change = 'idle'; this.changed();
      }
    })() });
  }
  /** Names are local display metadata. Renaming never changes transport,
   * identity, or inbound authority, and does not require reconnecting. */
  async rename({ id, label }: { id: NaidanRpcConnectionId, label: string }): Promise<void> {
    if (label.trim().length > 100) throw new Error('The connection name is too long');
    await this.ensureOwner(); const entry = this.requireEntry({ id });
    if (entry.stale) throw new Error('Reload the changed RPC connection first');
    switch (entry.change) {
    case 'idle': break;
    case 'remembering': case 'editing': case 'forgetting': throw new Error('The connection is being changed');
    default: { const exhaustive: never = entry.change; throw new Error(String(exhaustive)); }
    }
    const session = (() => {
      switch (entry.phase) {
      case 'connected': return entry.stop.signal;
      case 'disconnected': return undefined;
      case 'connecting': case 'stopping': throw new Error('Wait for the connection operation to finish');
      default: { const exhaustive: never = entry.phase; throw new Error(String(exhaustive)); }
      }
    })();
    entry.change = 'editing';
    entry.mutation = this.trackRegistryMutation({ task: (async () => {
      try {
        await entry.access.settled(); session?.throwIfAborted();
        const allowedMethods = [...entry.access.state().effective];
        const next = { ...copyConnection({ connection: entry.connection }), label: label.trim() || entry.connection.label,
          allowedMethods, revision: entry.connection.revision + 1 };
        if (isSaved({ persistence: entry.persistence })) await this.dependencies.storage.update({ connection: next, expectedRevision: entry.connection.revision });
        entry.connection = next;
        // Disconnect recreates its access controller after this write retires.
        // Do not replace the closed controller while that shutdown is pending.
        if (!session?.aborted) entry.access = this.access({ entry, initial: allowedMethods });
      } finally {
        entry.change = 'idle'; this.changed();
      }
    })() });
    return entry.mutation;
  }
  async forget({ id }: { id: NaidanRpcConnectionId }): Promise<void> {
    await this.ensureOwner(); const entry = this.requireEntry({ id });
    switch (entry.change) {
    case 'idle': break;
    case 'remembering': case 'editing': case 'forgetting': throw new Error('The connection is being changed');
    default: { const exhaustive: never = entry.change; throw new Error(String(exhaustive)); }
    }
    // Reserve the row synchronously, but do not put deletion in entry.mutation:
    // disconnect waits for that promise and deletion must not wait for itself.
    entry.change = 'forgetting';
    return this.trackRegistryMutation({ task: (async () => {
      try {
        await this.disconnect({ id });
        // Disconnected records may still have a queued allowed-methods write.
        await entry.access.settled();
        if (isSaved({ persistence: entry.persistence })) await this.dependencies.storage.remove({ id, expectedRevision: entry.connection.revision });
        if (this.entries.get(id) === entry) this.entries.delete(id);
      } finally {
        entry.change = 'idle'; this.changed();
      }
    })() });
  }
}
export const TEST_ONLY = {
};
