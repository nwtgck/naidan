import type { RpcLink } from './manager';

/** A local authenticated replacement notification, never a remote RPC error. */
export class RpcConnectionReplacedError extends Error {
  constructor() {
    super('An authenticated replacement connection is ready'); this.name = 'RpcConnectionReplacedError';
  }
}
export class RpcPeerClosedError extends Error {
  constructor() {
    super('The peer closed its connection'); this.name = 'RpcPeerClosedError';
  }
}
export type RpcLinkHealth = Readonly<{ state: 'healthy' | 'checking' }>;

/** The manager owns this physical endpoint independently of each admitted RPC
 * session. In particular, a session's closed barrier does not release its owner. */
export interface RpcPersistentOwner {
  readonly usable: boolean;
  readonly waitingForPeer: boolean;
  /** Record the owner in the manager before releasing the opening-signal fence. */
  adopt(): void;
  /** Explicit Connect may resume a peer-closed wait without another endpoint. */
  resume(): Promise<void>;
  next({ signal }: { signal: AbortSignal }): Promise<RpcLink>;
  stop({ reason, notice }: { reason: string; notice: 'notify-peer' | 'abort' }): Promise<void>;
}
export type RpcPersistentLink = {
  owner: RpcPersistentOwner;
  readonly health: RpcLinkHealth;
  subscribeHealth({ listener }: { listener({ health }: { health: RpcLinkHealth }): void }): () => void;
};

export const TEST_ONLY = {
};
