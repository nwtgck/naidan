import { nanoid } from 'nanoid';
import { createRpcStopControl } from './stop-control';
import type { RpcStopStatus } from './stop-control';
import type { Settings } from '@/01-models/types';
import type { NaidanPeerManager } from './manager';

let enabled = false;
let readSettings: () => Settings | undefined = () => undefined;
let loaded: Promise<NaidanPeerManager> | undefined;
const listeners = new Set<() => void>();
let control: ReturnType<typeof createRpcStopControl> | undefined;
let channel: BroadcastChannel | undefined;
function revalidate(): void {
  if (enabled && loaded) void loaded.then(manager => manager.revalidate()).catch(notifyRpcState);
}
function controls(): ReturnType<typeof createRpcStopControl> {
  if (control) return control;
  control = createRpcStopControl({ nextId: () => nanoid(), timeoutMs: 2000,
    send: ({ message }) => channel?.postMessage(message), changed: notifyRpcState, registryChanged: revalidate });
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
  enabled = false; controls().requestStop(); notifyRpcState();
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
/** Called by settings synchronization. Enabling alone does not import the
 * runtime, generate keys, read a catalog, connect or replay old calls. */
export function configureRpcFeature({ status, settings }: { status: 'enabled' | 'disabled', settings(): Settings }): Promise<void> {
  const nextEnabled = status === 'enabled';
  if (nextEnabled && !enabled) control?.clearRequest();
  enabled = nextEnabled; readSettings = settings;
  notifyRpcState();
  if (!loaded) return Promise.resolve();
  const desired = enabled;
  return loaded.then(manager => manager.setEnabled({ enabled: desired }));
}
export async function getRpcManager(): Promise<NaidanPeerManager> {
  if (!enabled) throw new Error('Enable Naidan RPC in Developer settings first');
  if (!loaded) {
    const initializing = import('./state').then(({ createRpcManager }) => createRpcManager({ settings: () => readSettings(), changed: notifyRpcState, control: controls(), stopping: () => {
      enabled = false; notifyRpcState();
    } }));
    loaded = initializing;
    // Share pending/successful initialization, but do not permanently poison
    // explicit use after a failed import or factory. Passive hydration and focus
    // still cannot retry initialization. An existing manager's teardown failures
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
