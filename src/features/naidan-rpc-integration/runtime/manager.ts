import { RpcConnectionPermits } from './connection-permits';
import { RpcPeerClosedError } from './link-lifecycle';
import type { RpcLinkHealth } from './link-lifecycle';
import { describePipingRpcProtocolFailure, RpcTransportInterruptedError } from '@/features/naidan-rpc-integration/transports/piping';
import { HandshakeResponseUnconfirmedError, ResponseUnconfirmedError, PipingRetirementError, RecordExhaustedError } from '@/features/naidan-piping-duplex';
import { nanoid } from 'nanoid';
import { ConnectionMaintenance, maintenanceClock, expose, NaidanRpcCallBudget, NaidanRpcByteBudget, NaidanRpcPeer } from '@/features/naidan-rpc';
import type { ConnectionLease, ConnectionInitiation, NaidanRpcTransport } from '@/features/naidan-rpc';
import type { NaidanPipingIdentity, NaidanPipingPeerVerifier } from '@/features/naidan-piping-duplex';
import type { NaidanRpcRegistration, NaidanRpcTransportSettings } from '@/01-models/naidan-rpc';
import { idToRaw, toNaidanRpcRegistrationId, toNaidanRpcPeerPublicKey } from '@/01-models/ids';
import type { NaidanRpcRegistrationId } from '@/01-models/ids';
import type { NaidanRpcStorage, NaidanRpcRegistryAccess, NaidanRpcRegistrySnapshot } from '@/00-storage/service/naidan-rpc';
import { validateRpcTransport, sameNaidanRpcRegistry } from '@/00-storage/service/naidan-rpc';
import { describePeerMethods, naidanPeerContract, peerAllowedMethodsSchema } from '@/features/naidan-rpc-integration/contract';
import type { NaidanPeerClient, NaidanPeerControlledMethodName, PeerProvidedMethods } from '@/features/naidan-rpc-integration/contract';
import { createNaidanPeerImplementation } from '@/features/naidan-rpc-integration/implementation';
import type { InferenceDependencies } from '@/features/naidan-rpc-integration/handlers/inference/handlers';
import { createMethodAccess } from '@/features/naidan-rpc-integration/access/method-access';
import { encodePeerKey, decodePeerKey } from './identity';
import { normalizeRpcPairingCode } from './pairing-code';
import type { RpcOwnerLease } from './owner';
import { RpcOwnerBusyError } from './owner';
import { AttemptError } from '@/features/naidan-piping-duplex/finite';

type Names = readonly NaidanPeerControlledMethodName[];
export type RpcPreparedLink = { assertAvailable(): void; finish(): Promise<RpcLink>; dispose(): Promise<void> };
export type RpcLink = NaidanRpcTransport & { readonly peerIdentity: Uint8Array, readonly session?: { prepareReplacement?({ signal }: { signal: AbortSignal }): Promise<RpcPreparedLink | undefined>; adopt(): void; close(): Promise<void>; readonly health: RpcLinkHealth; subscribeHealth({ listener }: { listener({ health }: { health: RpcLinkHealth }): void }): () => void }, abort({ reason }: { reason: string }): void };
/** A caller is pinned to one authenticated session, never a reconnecting lookup.
 * Labels are display metadata; peerPublicKey is the identity used for provenance. */
export type RpcClientBinding = {
  readonly registration: Readonly<Pick<NaidanRpcRegistration, 'id' | 'peerPublicKey' | 'label'>>,
  readonly client: NaidanPeerClient,
  readonly signal: AbortSignal,
};
export type RpcConnectionPhase = 'disconnected' | 'connecting' | 'connected' | 'stopping';
export type RpcRegistrationView = {
  registration: NaidanRpcRegistration,
  phase: RpcConnectionPhase,
  persistence: 'temporary' | 'saved',
  registryPersistence: NaidanRpcRegistryAccess['persistence'] | undefined,
  access: ReturnType<typeof createMethodAccess>['state'] extends () => infer T ? T : never,
  failure: string | undefined,
  desiredConnection: 'connected' | 'disconnected',
  recoveryStatus: 'ready' | 'waiting-peer' | 'waiting-capacity' | 'blocked',
  health: RpcLinkHealth | undefined,
  /** Opaque live-session identity, never persisted or used as authority. */
  connectionToken: object | undefined,
};
type RegistryLoadOutcome = { status: 'published'; epoch: number; access: NaidanRpcRegistryAccess; startupRegistrationIds: NaidanRpcRegistrationId[] } | { status: 'discarded' };
type Entry = {
  registration: NaidanRpcRegistration, persistence: 'temporary' | 'saved', phase: RpcConnectionPhase,
  registryAccess: NaidanRpcRegistryAccess | undefined,
  stale: boolean, removed: boolean,
  intentGeneration: number, maintenance: ConnectionMaintenance<RpcLink>, intentOrigin: 'unseen' | 'startup' | 'explicit',
  identity: NaidanPipingIdentity | undefined,
  waitingForPeer: boolean, unsubscribeHealth: (() => void) | undefined,
  stop: AbortController, link: RpcLink | undefined, rpc: NaidanRpcPeer | undefined,
  access: ReturnType<typeof createMethodAccess>, startup: Promise<ConnectionLease<RpcLink>> | undefined,
  disconnecting: Promise<void> | undefined, closing: Promise<void> | undefined, mutation: Promise<void> | undefined, change: 'idle' | 'remembering' | 'editing' | 'forgetting', failure: string | undefined,
};
export type RpcManagerDependencies = {
  storage: NaidanRpcStorage,
  identity(): Promise<NaidanPipingIdentity>,
  acquireOwner({ signal }: { signal: AbortSignal }): Promise<RpcOwnerLease>,
  open({ settings, identity, peerKey, code, verifyPeer, signal }: {
    settings: NaidanRpcTransportSettings, identity: NaidanPipingIdentity, peerKey: string | undefined,
    code: string | undefined, verifyPeer: NaidanPipingPeerVerifier | undefined, signal: AbortSignal,
  }): Promise<RpcLink>,
  inference: InferenceDependencies,
  retireResources(): Promise<void>,
  changed(): void,
};

function isCapacityWaiting({ entry }: { entry: Entry }): boolean {
  const phase = entry.maintenance.phase;
  switch (phase) {
  case 'queued': return true;
  case 'idle': case 'opening': case 'connected': case 'retiring': case 'backoff': case 'blocked': return false;
  default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
  }
}

function isSaved({ persistence }: { persistence: Entry['persistence'] }): boolean {
  switch (persistence) {
  case 'saved': return true;
  case 'temporary': return false;
  default: { const exhaustive: never = persistence; throw new Error(String(exhaustive)); }
  }
}

function copyRegistration({ registration }: { registration: NaidanRpcRegistration }): NaidanRpcRegistration {
  const { id, peerPublicKey, localPublicKey, label, transport, inboundAllowedMethods, connectOnStartup, revision, ...rest } = registration;
  rest satisfies Record<PropertyKey, never>;
  return { id, peerPublicKey, localPublicKey, label, transport: validateRpcTransport({ value: transport }), inboundAllowedMethods: [...inboundAllowedMethods], connectOnStartup, revision };
}

function sessionSettings({ registration }: { registration: NaidanRpcRegistration }): string {
  const { label: _label, connectOnStartup: _connectOnStartup, revision: _revision, ...settings } = copyRegistration({ registration });
  const { id, peerPublicKey, localPublicKey, transport, inboundAllowedMethods, ...rest } = settings;
  rest satisfies Record<PropertyKey, never>;
  return JSON.stringify({ id, peerPublicKey, localPublicKey, transport, inboundAllowedMethods });
}

function retryableAutomaticError({ error }: { error: unknown }): boolean {
  if (error instanceof RpcTransportInterruptedError || error instanceof RpcOwnerBusyError || error instanceof RecordExhaustedError || error instanceof HandshakeResponseUnconfirmedError || error instanceof ResponseUnconfirmedError) return true;
  if (!(error instanceof AttemptError)) return false;
  switch (error.kind) {
  case 'waiting-sender': case 'waiting-receiver': case 'transient': return true;
  case 'established': case 'fatal': return false;
  default: { const exhaustive: never = error.kind; throw new Error(String(exhaustive)); }
  }
}

/** Owns registrations independently of Settings, Chat and image components.
 * Explicit commands and the app-ready automatic policy acquire ownership.
 * Reading a client, loading settings or listing records never reconnects. */
export class NaidanPeerManager {
  private readonly entries = new Map<NaidanRpcRegistrationId, Entry>();
  private enabled = false;
  private registryEpoch = 0;
  private reloadSequence = 0;
  private registryLoad: { task: Promise<RegistryLoadOutcome> } | undefined;
  private registryReadinessChanged = Promise.withResolvers<void>();
  private validation: Promise<void> | undefined;
  private validationHints = 0;
  private readonly registryMutations = new Set<Promise<void>>();
  private lifetime = new AbortController();
  private owner: Promise<RpcOwnerLease> | undefined;
  private ownerEpoch = 0;
  private stopping: Promise<void> = Promise.resolve();
  private retirementFailure: { error: unknown } | undefined;
  private pairing: { stop: AbortController, task: Promise<NaidanRpcRegistrationId> } | undefined;
  private startupApplied: NaidanRpcRegistryAccess | undefined;
  private startupTaskEpoch = 0;
  private startupEpoch = 0;
  private startupTask: Promise<void> | undefined;
  private startupPending = false;
  private readonly startupStops = new Set<NaidanRpcRegistrationId>();
  private readonly openingPermits = new RpcConnectionPermits();
  private readonly callBudget = new NaidanRpcCallBudget({ capacity: 32 });
  private readonly byteBudget = new NaidanRpcByteBudget();
  private readonly retiringRpcs = new Set<Promise<void>>();
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

  /** App-ready and later hints may retry readiness. Only a successfully read
   * registry is applied, once per storage generation; explicit stops remain final. */
  startAutomaticConnections(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.startupTask && this.startupTaskEpoch === this.startupEpoch) return this.startupTask;
    const epoch = ++this.startupEpoch, signal = this.lifetime.signal;
    this.startupPending = true; this.startupTaskEpoch = epoch;
    const task = this.seedStartupConnections({ signal, epoch });
    this.startupTask = task.finally(() => {
      if (this.startupTaskEpoch === epoch) {
        this.startupTask = undefined; this.startupPending = false; this.startupStops.clear();
      }
    }); return this.startupTask;
  }

  stopAutomaticConnections(): void {
    this.startupEpoch++; this.wakeRegistryReadiness();
    for (const entry of this.entries.values()) {
      switch (entry.intentOrigin) {
      case 'startup': void this.disconnect({ id: entry.registration.id }).catch(() => {}); break;
      case 'unseen': case 'explicit': break;
      default: { const exhaustive: never = entry.intentOrigin; throw new Error(String(exhaustive)); }
      }
    }
  }

  wakeDesiredConnections(): void {
    if (!this.enabled) return;
    for (const entry of this.entries.values()) entry.maintenance.wake();
  }

  private createMaintenance({ factory, changed, settings }: {
    factory({ signal, mode }: { signal: AbortSignal; mode: ConnectionInitiation }): Promise<ConnectionLease<RpcLink>>;
    changed(): void;
    settings(): NaidanRpcTransportSettings;
  }): ConnectionMaintenance<RpcLink> {
    const owner = new ConnectionMaintenance({
      factory,
      permits: { acquire: ({ signal, mode }) => this.openingPermits.acquire({ signal, mode, origin: settings().serverUrl }) },
      clock: maintenanceClock,
      retryDelay: ({ attempt }) => Math.min(30000, Math.round(1000 * 2 ** (Math.min(6, attempt) - 1) * (0.8 + Math.random() * 0.4))),
      classify: ({ error, source }) => {
        if (error instanceof PipingRetirementError || this.retirementFailure) return 'retirement-failed';
        if (error instanceof RpcPeerClosedError) return 'retry';
        return (source === 'connection' && error === undefined) || retryableAutomaticError({ error }) ? 'retry' : 'blocked';
      },
      changed: () => {
        const block = owner.blocked;
        if (block) switch (block.kind) {
        case 'retirement': this.retirementFailure ??= { error: block.error }; break;
        case 'terminal': break;
        default: { const exhaustive: never = block.kind; throw new Error(String(exhaustive)); }
        }
        changed(); this.changed();
      },
    });
    return owner;
  }

  list(): RpcRegistrationView[] {
    return [...this.entries.values()].map(entry => ({
      registration: copyRegistration({ registration: entry.registration }),
      phase: entry.phase,
      desiredConnection: entry.maintenance.desiredConnection,
      recoveryStatus: entry.maintenance.blocked ? 'blocked' : isCapacityWaiting({ entry }) ? 'waiting-capacity' : entry.waitingForPeer && entry.maintenance.desiredConnection === 'connected' ? 'waiting-peer' : 'ready',
      health: (() => {
        switch (entry.phase) {
        case 'connected': return entry.link?.session?.health;
        case 'disconnected': case 'connecting': case 'stopping': return undefined;
        default: { const exhaustive: never = entry.phase; throw new Error(String(exhaustive)); }
        }
      })(),
      persistence: entry.persistence,
      registryPersistence: entry.registryAccess?.persistence,
      access: entry.access.state(),
      failure: entry.failure,
      connectionToken: entry.rpc === undefined || entry.maintenance.value !== entry.link ? undefined : entry.stop.signal,
    }));
  }

  reload(): Promise<void> {
    return this.beginRegistryLoad().task.then(() => {});
  }

  private wakeRegistryReadiness(): void {
    const previous = this.registryReadinessChanged;
    this.registryReadinessChanged = Promise.withResolvers<void>(); previous.resolve();
  }

  private beginRegistryLoad(): { task: Promise<RegistryLoadOutcome> } {
    const epoch = this.registryEpoch, sequence = ++this.reloadSequence;
    const load = { task: this.loadRegistry({ epoch, sequence }) };
    this.registryLoad = load; this.wakeRegistryReadiness();
    return load;
  }

  /** A catalogue read may complete without publishing. Startup needs the latest
   * adopted snapshot, not merely the completion of the read it first started.
   * UI reloads remain latest-wins and never seed connection intent themselves. */
  private async seedStartupConnections({ signal, epoch }: { signal: AbortSignal; epoch: number }): Promise<void> {
    const current = () => !signal.aborted && this.enabled && epoch === this.startupEpoch;
    if (!current()) return;
    let load = this.beginRegistryLoad();
    let startupRegistrationIds: NaidanRpcRegistrationId[] = [];
    while (current()) {
      let outcome: RegistryLoadOutcome | undefined;
      try {
        // A newer read or stop must wake startup even if this old read stalls.
        outcome = await Promise.race([load.task, this.registryReadinessChanged.promise.then(() => undefined)]);
      } catch (error) {
        if (!current()) return;
        if (this.registryLoad !== load && this.registryLoad) {
          load = this.registryLoad; continue;
        }
        throw error;
      }
      if (!current()) return;
      if (this.registryLoad !== load && this.registryLoad) {
        load = this.registryLoad; continue;
      }
      if (outcome?.status === 'published' && outcome.epoch === this.registryEpoch && this.registryMutations.size === 0) {
        if (this.startupApplied && sameNaidanRpcRegistry({ left: this.startupApplied, right: outcome.access })) return;
        this.startupApplied = outcome.access;
        startupRegistrationIds = outcome.startupRegistrationIds; break;
      }
      // A write invalidates older reads. Join it before asking for a fresh
      // snapshot; never recreate deleted rows or spin on an unfinished write.
      await Promise.race([Promise.all([...this.registryMutations].map(mutation => mutation.catch(() => {}))), this.registryReadinessChanged.promise]);
      if (!current()) return;
      load = this.registryLoad !== load && this.registryLoad ? this.registryLoad : this.beginRegistryLoad();
    }
    // Consume readiness in this same turn. Another reload must not slip
    // between publishing the barrier result and seeding startup intent.
    for (const id of startupRegistrationIds) {
      if (!current()) break;
      const entry = this.entries.get(id);
      if (!entry || entry.stale) continue;
      if (this.startupStops.has(entry.registration.id)) {
        entry.intentOrigin = 'explicit'; continue;
      }
      if (entry.intentOrigin !== 'unseen' || entry.persistence !== 'saved' || entry.registryAccess?.persistence !== 'durable') continue;
      entry.intentOrigin = 'startup'; void entry.maintenance.connect({ mode: 'background' }).catch(() => {});
    }
  }

  private async loadRegistry({ epoch, sequence }: { epoch: number; sequence: number }): Promise<RegistryLoadOutcome> {
    const { registrations: records, access } = await this.dependencies.storage.list();
    // Reads started before or during a write must never recreate deleted rows.
    // A second explicit reload also supersedes the older read, even if empty.
    if (epoch !== this.registryEpoch || sequence !== this.reloadSequence) return { status: 'discarded' };
    for (const registration of records) {
      // A stale reload must not overwrite a live session or a dirty restriction.
      const entry = this.entries.get(registration.id);
      if (!entry) this.add({ registration, persistence: 'saved', registryAccess: access });
      else if (isSaved({ persistence: entry.persistence })) {
        if (!sameNaidanRpcRegistry({ left: this.requireRegistryAccess({ entry }), right: access })) {
          entry.stale = true; entry.failure = 'RPC storage changed. Reload and reconnect explicitly.';
          void this.blockEntry({ entry, error: new Error(entry.failure) }).catch(() => this.changed());
        }
        if (entry.stale && entry.phase === 'disconnected' && entry.change === 'idle') {
          // Explicit reload may update registration details, but never expands the
          // effective authority left by a failed restriction or external edit.
          if (entry.registration.peerPublicKey !== registration.peerPublicKey || entry.registration.localPublicKey !== registration.localPublicKey) continue;
          const parsed = peerAllowedMethodsSchema.safeParse(registration.inboundAllowedMethods);
          const initial = parsed.success ? entry.access.state().effective.filter(name => parsed.data.includes(name)) : [];
          entry.access.close(); entry.registration = copyRegistration({ registration }); entry.registryAccess = access; entry.stale = false;
          entry.access = this.access({ entry, initial });
          entry.failure = parsed.success ? (entry.maintenance.blocked ? entry.failure : undefined) : 'Stored methods are not supported; no methods are provided';
        }
      }
    }
    const publishedEpoch = this.registryEpoch;
    // Reload is additive for presentation, so retained rows are not proof that
    // the current snapshot still asks to start those registrations.
    const startupRegistrationIds = (() => {
      switch (access.persistence) {
      case 'durable': return records.filter(record => record.connectOnStartup === 'enabled').map(record => record.id);
      case 'session': return [];
      default: { const exhaustive: never = access.persistence; throw new Error(String(exhaustive)); }
      }
    })();
    this.changed();
    return { status: 'published', epoch: publishedEpoch, access, startupRegistrationIds };
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
        let records: NaidanRpcRegistrySnapshot | undefined;
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
        const byId = new Map(records.registrations.map(record => [record.id, record]));
        const closing: Promise<void>[] = [];
        for (const entry of entries) {
          if (this.entries.get(entry.registration.id) !== entry) continue;
          const record = byId.get(entry.registration.id);
          if (sameNaidanRpcRegistry({ left: this.requireRegistryAccess({ entry }), right: records.access }) && record && !entry.stale && entry.phase !== 'stopping' &&
              sessionSettings({ registration: record }) === sessionSettings({ registration: entry.registration })) {
            // Metadata is not session authority. Preserve both a running call
            // and any unsaved restriction when another page edits its name or
            // automatic policy, while advancing the common storage revision.
            entry.access.adoptStoredRevision({ revision: record.revision });
            entry.registration = copyRegistration({ registration: record });
            if (entry.rpc && !entry.stop.signal.aborted) entry.rpc.setIncomingAdmission({ status: 'open' });
            continue;
          }
          if (!sameNaidanRpcRegistry({ left: this.requireRegistryAccess({ entry }), right: records.access }) || !record || JSON.stringify(copyRegistration({ registration: record })) !== JSON.stringify(copyRegistration({ registration: entry.registration }))) {
            entry.stale = true; entry.removed = record === undefined; entry.failure = 'RPC settings changed. Reload and reconnect explicitly.';
            switch (entry.phase) {
            case 'connecting': void this.blockEntry({ entry, error: new Error(entry.failure) }).catch(() => {}); break;
            case 'disconnected': case 'connected': case 'stopping': closing.push(this.blockEntry({ entry, error: new Error(entry.failure) }).then(() => {
              // Keep the row until physical retirement so master OFF also waits
              // for this entry before releasing the transport owner.
              if (!record && this.entries.get(entry.registration.id) === entry) {
                this.entries.delete(entry.registration.id); this.registryEpoch++;
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
          if (this.entries.get(entry.registration.id) !== entry) continue;
          entry.stale = true; entry.failure = 'RPC settings could not be verified. Reload before reconnecting.';
          switch (entry.phase) {
          case 'connecting': void this.blockEntry({ entry, error: new Error(entry.failure) }).catch(() => {}); break;
          case 'disconnected': case 'connected': case 'stopping': void this.blockEntry({ entry, error }).catch(() => {}); break;
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

  /** Validation belongs to the manager, not to the contact. A cancelled
   * candidate must dispose its cipher even while the shared storage read stalls.
   * The validation remains observed and fences its own eventual publication. */
  private async revalidateCandidate({ signal }: { signal: AbortSignal }): Promise<void> {
    signal.throwIfAborted();
    const validation = this.revalidate(), cancelled = Promise.withResolvers<never>();
    const abort = () => cancelled.reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) abort();
      await Promise.race([validation, cancelled.promise]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
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
    this.startupEpoch++; this.wakeRegistryReadiness();
    const closing = ids.map(id => this.disconnect({ id }));
    this.lifetime.abort(); pendingPair?.stop.abort();
    void (async () => {
      const retirements = await Promise.allSettled([...closing, pairing?.catch(() => {}), ...[...this.registryMutations].map(task => task.catch(() => {}))]);
      // One failed iterator cleanup must not skip other links or cached native
      // resources. Report failure only after all owned cleanup has settled;
      // retaining the owner on failure prevents unsafe replacement/reconnection.
      // Network joins above cannot release the shared owner while old handlers
      // or source cleanup still hold reservations from an earlier connection.
      const jobs = await Promise.allSettled([...this.retiringRpcs]);
      const resources = await Promise.allSettled([Promise.resolve().then(() => this.dependencies.retireResources())]);
      for (const result of [...retirements, ...jobs, ...resources]) {
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

  private requireEntry({ id }: { id: NaidanRpcRegistrationId }): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Select an RPC registration');
    return entry;
  }

  private requireRegistryAccess({ entry }: { entry: Entry }): NaidanRpcRegistryAccess {
    if (!entry.registryAccess) throw new Error('The saved RPC registry is unavailable. Reload before saving.');
    return entry.registryAccess;
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
    const stored = peerAllowedMethodsSchema.safeParse(entry.registration.inboundAllowedMethods);
    return createMethodAccess({
      initial,
      stored: stored.success ? stored.data : [],
      revision: entry.registration.revision,
      persist: isSaved({ persistence: entry.persistence }) ? async ({ allowedMethods, expectedRevision }) => {
        const registration = { ...copyRegistration({ registration: entry.registration }), inboundAllowedMethods: allowedMethods, revision: expectedRevision + 1 };
        const revision = await this.dependencies.storage.update({ access: this.requireRegistryAccess({ entry }), registration, expectedRevision });
        entry.registration = registration;
        return revision;
      } : undefined,
      apply: ({ allowedMethods }) => {
        if (!entry.stop.signal.aborted) entry.rpc?.setAllowedMethods({ contract: naidanPeerContract, allowedMethods: ['getProvidedMethods', ...allowedMethods] });
      },
      changed: () => this.changed(),
    });
  }

  private add({ registration, persistence, registryAccess, maintenance }: { maintenance?: ConnectionMaintenance<RpcLink>; registration: NaidanRpcRegistration, persistence: 'temporary' | 'saved', registryAccess: NaidanRpcRegistryAccess | undefined }): Entry {
    if (this.entries.size >= 32) throw new Error('Too many RPC registration records');
    const parsed = peerAllowedMethodsSchema.safeParse(registration.inboundAllowedMethods);
    const owner = maintenance ?? this.createMaintenance({
      settings: () => entry.registration.transport,
      factory: ({ signal, mode }) => this.connectEntry({ id: registration.id, signal, mode }),
      changed: () => {
        if (entry.maintenance.value !== undefined) {
          entry.phase = 'connected'; entry.failure = undefined;
        }
      },
    });
    const entry: Entry = {
      registration: copyRegistration({ registration }),
      persistence,
      registryAccess,
      phase: 'disconnected',
      stale: false,
      removed: false,
      stop: new AbortController(),
      intentGeneration: 0,
      maintenance: owner,
      intentOrigin: 'unseen',
      identity: undefined,
      waitingForPeer: false,
      unsubscribeHealth: undefined,
      link: undefined,
      rpc: undefined,
      startup: undefined,
      disconnecting: undefined,
      closing: undefined,
      mutation: undefined,
      change: 'idle',
      failure: parsed.success ? undefined : 'Stored methods are not supported; no methods are provided',
      access: createMethodAccess({ initial: [], stored: [], revision: registration.revision, persist: undefined, apply: () => {}, changed: () => {} }),
    };
    entry.access = this.access({ entry, initial: parsed.success ? parsed.data : [] });
    this.entries.set(registration.id, entry); this.registryEpoch++; return entry;
  }

  private checkRoute({ peerKey, settings, except }: { peerKey: string, settings: NaidanRpcTransportSettings, except: Entry | undefined }): void {
    const origin = validateRpcTransport({ value: settings }).serverUrl;
    for (const entry of this.entries.values()) {
      if (entry !== except && entry.phase !== 'disconnected' && idToRaw({ id: entry.registration.peerPublicKey }) === peerKey &&
        entry.registration.transport.serverUrl === origin) throw new Error('This peer and server already have an active connection');
    }
  }

  private async discardUnacceptedLink({ link, reason, rpc }: { link: RpcLink; reason: string; rpc: NaidanRpcPeer | undefined }): Promise<void> {
    let failure: { error: unknown } | undefined;
    for (const stop of [() => rpc?.dispose(), () => link.abort({ reason })]) {
      try {
        stop();
      } catch (error) {
        failure ??= { error }; this.retirementFailure ??= { error };
      }
    }
    const retired = await Promise.allSettled([rpc?.retire(), link.closed]);
    for (const result of retired) {
      switch (result.status) {
      case 'rejected': failure ??= { error: result.reason }; this.retirementFailure ??= { error: result.reason }; break;
      case 'fulfilled': break;
      default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
      }
    }
    if (failure) throw failure.error;
  }

  private ready({ entry, link, signal }: { entry: Entry, link: RpcLink; signal: AbortSignal }): void {
    signal.throwIfAborted(); entry.stop.signal.throwIfAborted();
    if (this.entries.get(entry.registration.id) !== entry || entry.change === 'forgetting') throw new Error('The registration is no longer current');
    if (!this.enabled) throw new Error('Naidan RPC is disabled');
    if (encodePeerKey({ bytes: link.peerIdentity }) !== idToRaw({ id: entry.registration.peerPublicKey })) throw new Error('The peer identity changed');
    this.checkRoute({ peerKey: idToRaw({ id: entry.registration.peerPublicKey }), settings: entry.registration.transport, except: entry });
    entry.link = link; entry.waitingForPeer = false; link.session?.adopt();
    entry.unsubscribeHealth = link.session?.subscribeHealth({
      listener: () => {
        if (entry.link === link) this.changed();
      },
    });
    signal.throwIfAborted(); entry.stop.signal.throwIfAborted();
    entry.rpc = new NaidanRpcPeer({
      callBudget: this.callBudget,
      byteBudget: this.byteBudget,
      transport: link,
      exports: [expose({
        contract: naidanPeerContract,
        allowedMethods: ['getProvidedMethods', ...entry.access.state().effective],
        implementation: createNaidanPeerImplementation({
          inference: this.dependencies.inference,
          providedMethods: () => {
            entry.stop.signal.throwIfAborted();
            if (this.validation && isSaved({ persistence: entry.persistence })) return { status: 'checking', methods: [] };
            return { status: 'ready', methods: describePeerMethods({ names: [...entry.access.state().effective] }) };
          },
        }),
      })],
      limits: { maxCalls: 6, maxCallTimeoutMs: undefined },
      signal: AbortSignal.any([signal, entry.stop.signal]),
    });
    entry.rpc.allowIncomingWhileSuspended({ contract: naidanPeerContract, allowedMethods: ['getProvidedMethods'] });
    // Revalidation may start after transport opening began. The constructor's
    // receive loop resumes asynchronously; suspend before publishing this peer.
    if (this.validation && isSaved({ persistence: entry.persistence })) entry.rpc.setIncomingAdmission({ status: 'suspended' });
  }

  private lease({ entry, link }: { entry: Entry; link: RpcLink }): ConnectionLease<RpcLink> {
    const rpc = entry.rpc; if (!rpc) throw new Error('RPC engine was not prepared');
    const ended = Promise.race([link.ended.then(({ error }) => ({ error, protocolError: undefined })), rpc.ended]).then(outcome => {
      if (outcome.error !== undefined && !(outcome.error instanceof RpcPeerClosedError) && this.entries.get(entry.registration.id) === entry && entry.link === link && entry.maintenance.desiredConnection === 'connected') {
        entry.failure = outcome.protocolError?.message ?? 'RPC connection interrupted'; this.changed();
      }
      if (this.entries.get(entry.registration.id) === entry && entry.link === link) entry.waitingForPeer = outcome.error instanceof RpcPeerClosedError;
      return outcome;
    });
    return {
      value: link,
      ended,
      retire: ({ replacement }) => this.closeEntry({ id: entry.registration.id, notifyPeer: !replacement }),
      ...(link.session?.prepareReplacement ? {
        prepareReplacement: async ({ signal }: { signal: AbortSignal }) => {
          // A verified temporary pairing is usable, but it is not persisted
          // authority for the stable contact listener until Remember succeeds.
          if (!isSaved({ persistence: entry.persistence }) || entry.change !== 'idle') return undefined;
          const candidate = await link.session!.prepareReplacement!({ signal });
          if (!candidate) return undefined;
          const current = () => {
            signal.throwIfAborted();
            if (!this.enabled || this.retirementFailure || this.entries.get(entry.registration.id) !== entry || entry.link !== link || entry.stale || entry.removed || entry.change !== 'idle')
              throw new Error('Obsolete connection candidate');
          };
          try {
            current(); await this.revalidateCandidate({ signal }); current(); candidate.assertAvailable();
          } catch (error) {
            await candidate.dispose(); throw error;
          }
          return {
            assertAvailable: () => {
              current(); candidate.assertAvailable();
            },
            dispose: () => candidate.dispose(),
            finish: async ({ signal: nextSignal }: { signal: AbortSignal }) => {
              let consumed = false;
              try {
                return await this.connectEntry({
                  id: entry.registration.id,
                  signal: nextSignal,
                  mode: 'background',
                  prepared: {
                    finish: () => {
                      consumed = true; return candidate.finish();
                    },
                  },
                });
              } finally {
                if (!consumed) await candidate.dispose();
              }
            },
          };
        },
      } : {}),
    };
  }

  async connect({ id }: { id: NaidanRpcRegistrationId }): Promise<void> {
    if (!this.enabled) throw new Error('Naidan RPC is disabled');
    const entry = this.requireEntry({ id }); entry.intentOrigin = 'explicit'; const generation = ++entry.intentGeneration;
    const lifetime = this.lifetime.signal; entry.disconnecting = undefined;
    if (!this.enabled || lifetime.aborted || entry.intentGeneration !== generation || this.entries.get(id) !== entry)
      throw new Error('Connection request was superseded');
    await entry.maintenance.connect({ mode: 'explicit' });
  }

  private async connectEntry({ id, signal: requestedSignal, mode, prepared }: { id: NaidanRpcRegistrationId; signal: AbortSignal; mode: ConnectionInitiation; prepared?: Pick<RpcPreparedLink, 'finish'> }): Promise<ConnectionLease<RpcLink>> {
    const entry = this.requireEntry({ id });
    await entry.mutation?.catch(() => {}); requestedSignal.throwIfAborted();
    if (entry.stale) throw new Error('Reload the changed RPC registration before reconnecting');
    if (entry.phase !== 'disconnected' || entry.change !== 'idle') throw new Error('The registration is already active or being edited');
    // Reserve synchronously before awaiting either storage or ownership.
    entry.phase = 'connecting'; entry.stop = new AbortController(); entry.closing = undefined; entry.disconnecting = undefined; entry.failure = undefined; this.changed();
    const signal = AbortSignal.any([entry.stop.signal, this.lifetime.signal, requestedSignal]);
    entry.startup = (async () => {
      let link: RpcLink | undefined;
      try {
        await this.ensureOwner(); signal.throwIfAborted();
        await this.revalidate(); signal.throwIfAborted();
        if (entry.stale) throw new Error('Reload the changed RPC registration before reconnecting');
        this.checkRoute({ peerKey: idToRaw({ id: entry.registration.peerPublicKey }), settings: entry.registration.transport, except: entry });
        switch (mode) {
        case 'explicit': break;
        case 'background': {
          if (isSaved({ persistence: entry.persistence })) {
            const stored = await this.dependencies.storage.readIdentity(); signal.throwIfAborted();
            if (!stored || stored.publicKey !== entry.registration.localPublicKey) throw new Error('The saved RPC identity is unavailable or changed');
          } else if (!entry.identity) throw new Error('The temporary RPC identity is unavailable');
          break;
        }
        default: { const exhaustive: never = mode; throw new Error(String(exhaustive)); }
        }
        const identity = entry.persistence === 'temporary' && entry.identity ? entry.identity : await this.dependencies.identity(); signal.throwIfAborted();
        if (encodePeerKey({ bytes: identity.publicKey }) !== entry.registration.localPublicKey) throw new Error('This registration belongs to a different local identity');
        entry.identity = identity;
        link = prepared ? await prepared.finish() : await this.dependencies.open({
          settings: copyRegistration({ registration: entry.registration }).transport,
          identity,
          peerKey: idToRaw({ id: entry.registration.peerPublicKey }),
          code: undefined,
          verifyPeer: undefined,
          signal,
        });
        signal.throwIfAborted(); this.ready({ entry, link, signal });
        return this.lease({ entry, link });
      } catch (error) {
        // A failed factory may still own resources even though it returned no link.
        if (error instanceof PipingRetirementError) this.retirementFailure ??= { error };
        let failure = error;
        try {
          if (link) await this.discardUnacceptedLink({ link, rpc: entry.rpc, reason: 'RPC connection was not accepted' });
        } catch (cleanupError) {
          failure = cleanupError;
        }
        entry.unsubscribeHealth?.(); entry.unsubscribeHealth = undefined;
        entry.rpc = undefined; entry.link = undefined;
        if (!signal.aborted) entry.failure = failure instanceof RpcOwnerBusyError ? undefined : describePipingRpcProtocolFailure({ error: failure }) ?? 'RPC connection could not be established';
        switch (entry.phase) {
        case 'stopping': break;
        case 'connecting': case 'connected': case 'disconnected': entry.phase = 'disconnected'; break;
        default: { const exhaustive: never = entry.phase; throw new Error(String(exhaustive)); }
        }
        if (entry.removed && !this.retirementFailure && entry.phase === 'disconnected' && this.entries.get(id) === entry) {
          this.entries.delete(id); this.registryEpoch++;
        }
        this.changed(); throw failure;
      }
    })();
    return entry.startup;
  }

  async pair({ settings, code, verifyPeer, signal }: {
    settings: NaidanRpcTransportSettings; code: string;
    verifyPeer: NaidanPipingPeerVerifier; signal: AbortSignal;
  }): Promise<NaidanRpcRegistrationId> {
    if (!this.enabled || this.pairing) throw new Error('RPC is disabled or another pairing is pending');
    let initial: { code: string; transport: NaidanRpcTransportSettings; verifyPeer: NaidanPipingPeerVerifier } | undefined = {
      code: normalizeRpcPairingCode({ code }),
      transport: validateRpcTransport({ value: settings }),
      verifyPeer,
    };
    let entry: Entry | undefined;
    const stop = new AbortController();
    const owner = this.createMaintenance({
      settings: () => initial?.transport ?? entry!.registration.transport,
      factory: async ({ signal: attempt, mode }) => {
        if (entry) return this.connectEntry({ id: entry.registration.id, signal: attempt, mode });
        const setup = initial; if (!setup) throw new Error('Pairing setup is no longer available');
        const combined = AbortSignal.any([attempt, stop.signal, this.lifetime.signal]);
        let link: RpcLink | undefined;
        try {
          // Unsupported persisted authority must not be treated as a fresh pairing.
          await this.dependencies.storage.list(); combined.throwIfAborted();
          await this.ensureOwner(); combined.throwIfAborted();
          const identity = await this.dependencies.identity(); combined.throwIfAborted();
          link = await this.dependencies.open({ settings: setup.transport, identity, peerKey: undefined, code: setup.code, verifyPeer: setup.verifyPeer, signal: combined });
          combined.throwIfAborted();
          const publicKey = encodePeerKey({ bytes: link.peerIdentity }), localPublicKey = encodePeerKey({ bytes: identity.publicKey });
          decodePeerKey({ value: publicKey });
          if (publicKey === localPublicKey) throw new Error('Cannot connect to this device itself');
          this.checkRoute({ peerKey: publicKey, settings: setup.transport, except: undefined });
          const id = toNaidanRpcRegistrationId({ raw: nanoid() });
          entry = this.add({
            registration: {
              id,
              peerPublicKey: toNaidanRpcPeerPublicKey({ raw: publicKey }),
              localPublicKey,
              label: `Peer ${publicKey.slice(0, 8)}`,
              transport: setup.transport,
              inboundAllowedMethods: [],
              connectOnStartup: 'disabled',
              revision: 0,
            },
            persistence: 'temporary',
            registryAccess: undefined,
            maintenance: owner,
          });
          entry.phase = 'connecting'; entry.identity = identity; entry.intentOrigin = 'explicit';
          this.ready({ entry, link, signal: combined }); initial = undefined;
          return this.lease({ entry, link });
        } catch (error) {
          if (error instanceof PipingRetirementError) this.retirementFailure ??= { error };
          if (link) await this.discardUnacceptedLink({ link, rpc: entry?.rpc, reason: 'RPC pairing was not accepted' });
          throw error;
        }
      },
      changed: () => {
        if (entry && owner.phase === 'connected') {
          entry.phase = 'connected'; entry.failure = undefined;
        }
      },
    });
    const completed = Promise.withResolvers<NaidanRpcRegistrationId>(), task = completed.promise;
    void task.catch(() => {});
    // Reserve pairing before observers can synchronously issue another command.
    this.pairing = { stop, task };
    const stopOwner = () => {
      void owner.disconnect().catch(() => {});
    };
    stop.signal.addEventListener('abort', stopOwner, { once: true });
    const requestAbort = () => stop.abort(signal.reason);
    signal.addEventListener('abort', requestAbort, { once: true }); if (signal.aborted) requestAbort();
    void (async () => {
      try {
        stop.signal.throwIfAborted(); await owner.connect({ mode: 'explicit' }); stop.signal.throwIfAborted();
        if (!entry) throw new Error('Pairing did not create a registration');
        return entry.registration.id;
      } catch (error) {
        const original = stop.signal.aborted ? stop.signal.reason : error;
        try {
          await owner.disconnect();
        } catch (cleanup) {
          throw new PipingRetirementError({ cause: cleanup, logicalError: original });
        }
        if (entry && this.entries.get(entry.registration.id) === entry && entry.persistence === 'temporary') {
          this.entries.delete(entry.registration.id); this.registryEpoch++;
        }
        throw original;
      } finally {
        signal.removeEventListener('abort', requestAbort); stop.signal.removeEventListener('abort', stopOwner);
        if (this.pairing?.task === task) this.pairing = undefined; this.changed();
      }
    })().then(completed.resolve, completed.reject);
    this.changed(); return task;
  }

  cancelPairing(): void {
    this.pairing?.stop.abort();
  }

  /** Confirmation dialogs may outlive the session they describe. Capture an
   * opaque stop command, not a late ID lookup which could stop a reconnect. */
  prepareDisconnect({ id }: { id: NaidanRpcRegistrationId }): () => Promise<void> {
    const entry = this.requireEntry({ id }), session = entry.maintenance.token;
    return () => {
      if (this.entries.get(id) !== entry || entry.maintenance.token !== session) return Promise.reject(new Error('The RPC session changed; confirm stopping it again'));
      return this.disconnect({ id });
    };
  }

  disconnect({ id }: { id: NaidanRpcRegistrationId }): Promise<void> {
    if (this.startupPending) {
      if (this.startupStops.size >= 32 && !this.startupStops.has(id)) this.startupEpoch++;
      else this.startupStops.add(id);
    }
    const entry = this.entries.get(id); if (!entry) return Promise.resolve();
    entry.intentOrigin = 'explicit';
    if (entry.disconnecting && entry.maintenance.desiredConnection === 'disconnected') return entry.disconnecting;
    const generation = ++entry.intentGeneration;
    const done = Promise.withResolvers<void>(); entry.disconnecting = done.promise; void done.promise.catch(() => {});
    const logical = entry.maintenance.disconnect();
    void logical.then(() => {
      if (this.entries.get(id) === entry && entry.intentGeneration === generation && entry.persistence === 'temporary' && entry.maintenance.desiredConnection === 'disconnected') {
        this.entries.delete(id); this.registryEpoch++;
      }
      this.changed();
    }).then(done.resolve, done.reject);
    return done.promise;
  }

  private blockEntry({ entry, error }: { entry: Entry; error: unknown }): Promise<void> {
    return entry.maintenance.block({ error }).then(() => {
      if (entry.removed && this.entries.get(entry.registration.id) === entry) {
        this.entries.delete(entry.registration.id); this.registryEpoch++;
      }
    });
  }

  private trackRpcRetirement({ rpc }: { rpc: NaidanRpcPeer }): void {
    const retiring = rpc.retire(); this.retiringRpcs.add(retiring);
    void retiring.then(() => {
      this.retiringRpcs.delete(retiring); this.changed();
    }, error => {
      this.retiringRpcs.delete(retiring); this.retirementFailure ??= { error };
      // A late cleanup failure invalidates later admission, not only the old
      // row. Keep global ownership; never issue the old result on a new peer.
      for (const entry of this.entries.values()) void this.blockEntry({ entry, error }).catch(() => {});
      this.changed();
    });
  }

  private closeEntry({ id, notifyPeer = true }: { id: NaidanRpcRegistrationId; notifyPeer?: boolean }): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    switch (entry.phase) {
    case 'disconnected': return Promise.resolve();
    case 'connecting': case 'connected': case 'stopping': break;
    default: { const exhaustive: never = entry.phase; throw new Error(String(exhaustive)); }
    }
    if (entry.closing) return entry.closing;
    const restricted = entry.access.state().effective;
    // Reserve the teardown before invoking synchronous cancellation listeners.
    // Reentrant disconnect/feature-OFF joins the same operation, not a second
    // abort or a false success. Synchronous lower failures still join all work.
    const closed = Promise.withResolvers<void>(); entry.closing = closed.promise;
    void closed.promise.catch(() => {});
    const failures: unknown[] = [];
    entry.phase = 'stopping';
    let notification: Promise<void> | undefined;
    const stopOperations = [() => {
      if (notifyPeer && entry.link?.session && !entry.maintenance.blocked) {
        notification = entry.link.session.close(); void notification.catch(() => {});
      }
    }, () => entry.stop.abort(), () => entry.access.close(),
    () => entry.rpc?.dispose(), () => {
      entry.unsubscribeHealth?.(); entry.unsubscribeHealth = undefined;
      if (!notification)
        entry.link?.abort({ reason: 'RPC logical connection retired' });
    }];
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
      if (entry.rpc) this.trackRpcRetirement({ rpc: entry.rpc });
      const cleanup = await Promise.allSettled([
        entry.mutation?.catch(() => {}), entry.rpc?.retireNetwork(),
        entry.link?.closed, entry.access.settled(), notification,
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
      if ((!isSaved({ persistence: entry.persistence }) && entry.maintenance.desiredConnection === 'disconnected') || entry.removed) {
        this.entries.delete(id); this.registryEpoch++;
      }
      this.changed();
    })().then(closed.resolve, error => {
      this.retirementFailure ??= { error }; closed.reject(error); this.changed();
    });
    return closed.promise;
  }

  client({ id }: { id: NaidanRpcRegistrationId }): NaidanPeerClient {
    return this.bindClient({ id }).client;
  }

  /** Discovery does not depend on inference grants and remains available while
   * saved settings are checked. All inference bindings keep their stricter gate. */
  async getPeerProvidedMethods({ id, signal }: { id: NaidanRpcRegistrationId, signal: AbortSignal }): Promise<PeerProvidedMethods> {
    const entry = this.requireEntry({ id }), rpc = entry.rpc, session = entry.stop.signal;
    if (!this.enabled || entry.stale || entry.phase !== 'connected' || !rpc || session.aborted) throw new Error('Connect before checking peer capabilities');
    const call = rpc.client({ contract: naidanPeerContract }).getProvidedMethods({ input: {}, on: {}, signal: AbortSignal.any([session, signal]), timeoutMs: undefined });
    void call.closed.catch(() => {});
    const result = await call.result;
    await call.closed; signal.throwIfAborted(); session.throwIfAborted();
    if (this.entries.get(id) !== entry || entry.rpc !== rpc) throw new Error('RPC session changed');
    return result;
  }

  bindClient({ id }: { id: NaidanRpcRegistrationId }): RpcClientBinding {
    if (!this.enabled) throw new Error('Naidan RPC is disabled');
    const entry = this.requireEntry({ id });
    if (entry.stale || this.validation) throw new Error('RPC settings need verification');
    if (entry.phase !== 'connected' || !entry.rpc || entry.stop.signal.aborted) throw new Error('Connect explicitly in the Naidan RPC settings tab first');
    return {
      registration: Object.freeze({ id, peerPublicKey: entry.registration.peerPublicKey, label: entry.registration.label }),
      client: entry.rpc.client({ contract: naidanPeerContract }),
      signal: entry.stop.signal,
    };
  }

  async updateInboundAllowedMethods({ id, inboundAllowedMethods }: { id: NaidanRpcRegistrationId, inboundAllowedMethods: Names }): Promise<void> {
    const names = peerAllowedMethodsSchema.parse(inboundAllowedMethods);
    await this.ensureOwner();
    const entry = this.requireEntry({ id });
    if (entry.stale) throw new Error('Reload the changed RPC registration first');
    if (entry.change !== 'idle' || entry.phase === 'stopping') throw new Error('The registration is being changed');
    return this.trackRegistryMutation({
      task: (async () => {
        await entry.access.update({ allowedMethods: names });
        if (!isSaved({ persistence: entry.persistence })) entry.registration = { ...entry.registration, inboundAllowedMethods: [...entry.access.state().effective] };
        this.changed();
      })(),
    });
  }

  async remember({ id, label }: { id: NaidanRpcRegistrationId, label: string | undefined }): Promise<void> {
    await this.ensureOwner();
    const entry = this.requireEntry({ id });
    if (entry.persistence !== 'temporary' || entry.phase !== 'connected' || entry.change !== 'idle') throw new Error('Only a verified live temporary connection can be remembered');
    entry.change = 'remembering';
    entry.mutation = this.trackRegistryMutation({
      task: (async () => {
        try {
          await entry.access.settled();
          const { access } = await this.dependencies.storage.list();
          const identity = await this.dependencies.identity(); entry.stop.signal.throwIfAborted();
          const registration = {
            ...copyRegistration({ registration: entry.registration }),
            label: label?.trim() || entry.registration.label,
            inboundAllowedMethods: [...entry.access.state().effective],
            revision: 0,
          };
          const registryAccess = await this.dependencies.storage.remember({ access, registration, identity: { privateKey: identity.privateKey, publicKey: encodePeerKey({ bytes: identity.publicKey }) } });
          // Remembering does not grant any additional method or initiate a connection.
          entry.registration = registration; entry.registryAccess = registryAccess; entry.persistence = 'saved';
          if (!entry.stop.signal.aborted) entry.access = this.access({ entry, initial: peerAllowedMethodsSchema.parse(registration.inboundAllowedMethods) });
        } finally {
          entry.change = 'idle'; this.changed();
        }
      })(),
    });
    return entry.mutation;
  }

  async edit({ id, label, transport }: { id: NaidanRpcRegistrationId, label: string, transport: NaidanRpcTransportSettings }): Promise<void> {
    const nextTransport = validateRpcTransport({ value: transport });
    await this.ensureOwner(); const entry = this.requireEntry({ id });
    if (entry.stale) throw new Error('Reload the changed RPC registration first');
    if (entry.change !== 'idle' || entry.phase !== 'disconnected') throw new Error('Disconnect before changing registration settings');
    entry.change = 'editing';
    return this.trackRegistryMutation({
      task: (async () => {
        try {
          await entry.access.settled();
          const next = {
            ...copyRegistration({ registration: entry.registration }),
            label: label.trim() || entry.registration.label,
            transport: nextTransport,
            inboundAllowedMethods: [...entry.access.state().effective],
            revision: entry.registration.revision + 1,
          };
          if (isSaved({ persistence: entry.persistence })) await this.dependencies.storage.update({ access: this.requireRegistryAccess({ entry }), registration: next, expectedRevision: entry.registration.revision });
          if (sessionSettings({ registration: next }) !== sessionSettings({ registration: entry.registration }))
            await this.blockEntry({ entry, error: new Error('Connection settings changed; reconnect explicitly') });
          entry.registration = next; entry.access = this.access({ entry, initial: peerAllowedMethodsSchema.parse(next.inboundAllowedMethods) });
        } finally {
          entry.change = 'idle'; this.changed();
        }
      })(),
    });
  }

  /** Names are local display metadata. Renaming never changes transport,
   * identity, or inbound authority, and does not require reconnecting. */
  async rename({ id, label }: { id: NaidanRpcRegistrationId, label: string }): Promise<void> {
    if (label.trim().length > 100) throw new Error('The registration name is too long');
    await this.ensureOwner(); const entry = this.requireEntry({ id });
    if (entry.stale) throw new Error('Reload the changed RPC registration first');
    switch (entry.change) {
    case 'idle': break;
    case 'remembering': case 'editing': case 'forgetting': throw new Error('The registration is being changed');
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
    entry.mutation = this.trackRegistryMutation({
      task: (async () => {
        try {
          await entry.access.settled(); session?.throwIfAborted();
          const allowedMethods = [...entry.access.state().effective];
          const next = {
            ...copyRegistration({ registration: entry.registration }),
            label: label.trim() || entry.registration.label,
            inboundAllowedMethods: allowedMethods,
            revision: entry.registration.revision + 1,
          };
          if (isSaved({ persistence: entry.persistence })) await this.dependencies.storage.update({ access: this.requireRegistryAccess({ entry }), registration: next, expectedRevision: entry.registration.revision });
          entry.registration = next;
          // Disconnect recreates its access controller after this write retires.
          // Do not replace the closed controller while that shutdown is pending.
          if (!session?.aborted) entry.access = this.access({ entry, initial: allowedMethods });
        } finally {
          entry.change = 'idle'; this.changed();
        }
      })(),
    });
    return entry.mutation;
  }

  async setConnectOnStartup({ id, connectOnStartup }: { id: NaidanRpcRegistrationId, connectOnStartup: NaidanRpcRegistration['connectOnStartup'] }): Promise<void> {
    const entry = this.requireEntry({ id });
    const enabling = entry.registration.connectOnStartup === 'disabled' && connectOnStartup === 'enabled';
    const generation = entry.intentGeneration, lifetime = this.lifetime.signal;
    switch (entry.intentOrigin) {
    case 'unseen': entry.intentOrigin = 'explicit'; break;
    case 'startup': case 'explicit': break;
    default: { const exhaustive: never = entry.intentOrigin; throw new Error(String(exhaustive)); }
    }
    if (entry.persistence !== 'saved' || this.requireRegistryAccess({ entry }).persistence !== 'durable') throw new Error('Startup connections require a saved persistent registration');
    await this.ensureOwner();
    if (entry.stale || this.entries.get(id) !== entry || entry.change !== 'idle' || entry.phase === 'stopping') throw new Error('Wait for the registration settings to be verified');
    entry.change = 'editing';
    entry.mutation = this.trackRegistryMutation({
      task: (async () => {
        try {
          await entry.access.settled();
          const allowedMethods = [...entry.access.state().effective];
          const next = { ...copyRegistration({ registration: entry.registration }), connectOnStartup, inboundAllowedMethods: allowedMethods, revision: entry.registration.revision + 1 };
          await this.dependencies.storage.update({ access: this.requireRegistryAccess({ entry }), registration: next, expectedRevision: entry.registration.revision });
          entry.registration = next;
          // Rebuild after commit without granting anything beyond the current
          // effective authority, including an earlier failed revocation.
          switch (entry.phase) {
          case 'connected': case 'connecting': case 'disconnected': entry.access = this.access({ entry, initial: allowedMethods }); break;
          case 'stopping': break;
          default: { const exhaustive: never = entry.phase; throw new Error(String(exhaustive)); }
          }
        } finally {
          entry.change = 'idle'; this.changed();
        }
      })(),
    });
    await entry.mutation;
    // An explicit ON transition also requests a connection on this page, but
    // only after saving. A newer stop or feature lifetime always takes priority.
    // Leave an existing attempt/backoff alone, and do not await a remote peer
    // from this settings command or make the opener join its own mutation.
    if (enabling && this.enabled && !lifetime.aborted && this.entries.get(id) === entry &&
        entry.intentGeneration === generation && !entry.stale && entry.registration.connectOnStartup === 'enabled' &&
        entry.maintenance.desiredConnection === 'disconnected') {
      void this.connect({ id }).catch(() => {});
    }
  }

  async forget({ id }: { id: NaidanRpcRegistrationId }): Promise<void> {
    await this.ensureOwner(); const entry = this.requireEntry({ id });
    switch (entry.change) {
    case 'idle': break;
    case 'remembering': case 'editing': case 'forgetting': throw new Error('The registration is being changed');
    default: { const exhaustive: never = entry.change; throw new Error(String(exhaustive)); }
    }
    // Reserve the row synchronously, but do not put deletion in entry.mutation:
    // disconnect waits for that promise and deletion must not wait for itself.
    entry.change = 'forgetting';
    return this.trackRegistryMutation({
      task: (async () => {
        try {
          await this.disconnect({ id });
          // Disconnected records may still have a queued allowed-methods write.
          await entry.access.settled();
          if (isSaved({ persistence: entry.persistence })) await this.dependencies.storage.remove({ access: this.requireRegistryAccess({ entry }), id, expectedRevision: entry.registration.revision });
          if (this.entries.get(id) === entry) this.entries.delete(id);
        } finally {
          entry.change = 'idle'; this.changed();
        }
      })(),
    });
  }
}
export const TEST_ONLY = {
};
