import { nanoid } from 'nanoid';
import { createRpcStopControl } from './stop-control';
import type { RpcStopStatus } from './stop-control';
import type { Settings } from '@/01-models/types';
import type { NaidanPeerManager } from './manager';
import { scheduleIdleTask } from '@/utils/idle-task';
import type { ScheduledIdleTask } from '@/utils/idle-task';
import { naidanRpcStorage } from '@/00-storage/service/naidan-rpc';
import { storageService } from '@/00-storage/service';

let enabled = false;

let readSettings: () => Settings | undefined = () => undefined;

let loaded: Promise<NaidanPeerManager> | undefined;
const listeners = new Set<() => void>();
let control: ReturnType<typeof createRpcStopControl> | undefined;
let channel: BroadcastChannel | undefined;
let automaticRegistration: object | undefined;
let automaticEpoch = 0;
let automaticScheduled: ScheduledIdleTask | undefined;

function cancelAutomaticCheck(): void {
  automaticEpoch++; automaticScheduled?.cancel(); automaticScheduled = undefined;
}

function scheduleAutomaticCheck(): void {
  cancelAutomaticCheck();
  if (!automaticRegistration || !enabled) return;
  const epoch = automaticEpoch;
  automaticScheduled = scheduleIdleTask({
    timeoutMs: 1000,
    fallbackDelayMs: 100,
    task: async () => {
      automaticScheduled = undefined;
      const current = () => epoch === automaticEpoch && automaticRegistration !== undefined && enabled;
      try {
      // A feature flag is not connection intent. An empty/disabled registry
      // does not import runtime, acquire an owner, read keys or create identity.
        const { access, registrations } = await naidanRpcStorage.list();
        if (!current() || access.persistence !== 'durable' || !registrations.some(connection => connection.connectOnStartup === 'enabled')) return;
        const manager = await getRpcManager();
        if (current()) await manager.startAutomaticConnections();
      } catch {
      // Failed reads/identity checks are not absence and are not retried in a
      // tight loop. A later readiness/registry hint may try again.
        notifyRpcState();
      }
    },
  });
}

/** Install only after app-ready. Startup continues without awaiting peers. */
export function startRpcAutomaticConnections(): () => void {
  const registration = {}; automaticRegistration = registration;
  const unsubscribe = storageService.subscribeNaidanRpcRegistryChanges({ listener: revalidate });
  const resume = () => revalidate();
  window.addEventListener('focus', resume); window.addEventListener('pageshow', resume); window.addEventListener('online', resume);
  scheduleAutomaticCheck();
  return () => {
    unsubscribe(); window.removeEventListener('focus', resume); window.removeEventListener('pageshow', resume); window.removeEventListener('online', resume);
    if (automaticRegistration !== registration) return;
    automaticRegistration = undefined; cancelAutomaticCheck();
    if (loaded) void loaded.then(manager => {
      manager.stopAutomaticConnections(); return manager.setEnabled({ enabled: false });
    }).catch(notifyRpcState);
  };
}

function revalidate(): void {
  if (!enabled) return;
  if (loaded) void loaded.then(async manager => {
    await manager.revalidate();
    if (enabled) {
      manager.wakeDesiredConnections();
      if (automaticRegistration) await manager.startAutomaticConnections();
    }
  }).catch(notifyRpcState);
  else if (automaticRegistration) scheduleAutomaticCheck();
}

function controls(): ReturnType<typeof createRpcStopControl> {
  if (control) return control;
  control = createRpcStopControl({
    nextId: () => nanoid(),
    timeoutMs: 2000,
    send: ({ message }) => channel?.postMessage(message),
    changed: notifyRpcState,
    registryChanged: revalidate,
  });
  // Lazy and optional transport: lack of BroadcastChannel cannot be mistaken
  // for a successful remote stop. The finite timer reports unconfirmed.
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('naidan-peer-rpc-control/v1');
      channel.onmessage = event => control?.receive({ value: event.data });
    }
  } catch {
    channel = undefined;
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', revalidate);
    window.addEventListener('pageshow', revalidate);
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
    const visibility = document.visibilityState;
    switch (visibility) {
    case 'visible': revalidate(); break;
    case 'hidden': break;
    default: { const exhaustive: never = visibility; throw new Error(String(exhaustive)); }
    }
  });
  return control;
}

export function rpcStopStatus(): RpcStopStatus {
  return control?.status() ?? 'idle';
}

/** Explicit OFF only. Passive settings hydration must never send a stop probe. */
export function requestRpcStop(): void {
  enabled = false; cancelAutomaticCheck(); controls().requestStop(); notifyRpcState();
  // A manager still acquiring its lock cannot yet answer as an owner.
  // Closing it also fences that pending acquisition and any pending pairing.
  if (loaded) void loaded.then(manager => manager.setEnabled({ enabled: false })).catch(notifyRpcState);
}

export function subscribeRpcState({ listener }: { listener(): void }): () => void {
  listeners.add(listener); return () => listeners.delete(listener);
}

export function notifyRpcState(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch { /* Observation only. */ }
  }
}

/** Settings hydration cannot connect before app-ready. Enabling after ready
 * retries startup readiness; the manager owns the once-per-registry decision. */
export function configureRpcFeature({ status, settings }: { status: 'enabled' | 'disabled', settings(): Settings }): Promise<void> {
  const nextEnabled = status === 'enabled', wasEnabled = enabled;
  if (nextEnabled && !enabled) control?.clearRequest();
  enabled = nextEnabled; readSettings = settings;
  if (!nextEnabled) cancelAutomaticCheck();
  else if (!wasEnabled) scheduleAutomaticCheck();
  notifyRpcState();
  if (!loaded) return Promise.resolve();
  const desired = enabled;
  return loaded.then(manager => manager.setEnabled({ enabled: desired }));
}

export async function getRpcManager(): Promise<NaidanPeerManager> {
  if (!enabled) throw new Error('Enable Naidan RPC in Developer settings first');
  if (!loaded) {
    const initializing = import('./state').then(({ createRpcManager }) => createRpcManager({
      settings: () => readSettings(),
      changed: notifyRpcState,
      control: controls(),
      stopping: () => {
        enabled = false; cancelAutomaticCheck(); notifyRpcState();
      },
    }));
    loaded = initializing;
    // Share pending/successful initialization, but do not permanently poison
    // later opt-in use after a failed import or factory. Passive hydration
    // still does not import runtime; app-ready hints require saved opt-in. An existing manager's teardown failures
    // are deliberately not cleared here: it continues to own its resources.
    void initializing.catch(() => {
      if (loaded === initializing) loaded = undefined;
    });
  }
  const manager = await loaded;
  await manager.setEnabled({ enabled });
  if (!enabled) throw new Error('Naidan RPC is disabled');
  return manager;
}

export const TEST_ONLY = {
};
