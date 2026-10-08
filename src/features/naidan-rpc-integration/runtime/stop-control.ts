import { z } from 'zod';

const token = z.string().min(1).max(128);
const messageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('probe'), requestId: token }),
  z.strictObject({ type: z.literal('owner'), requestId: token, ownerId: token }),
  z.strictObject({ type: z.literal('stop'), requestId: token, ownerId: token }),
  z.strictObject({ type: z.literal('applied'), requestId: token, ownerId: token }),
  z.strictObject({ type: z.literal('retired'), ownerId: token }),
  z.strictObject({ type: z.literal('retirement-failed'), ownerId: token }),
  z.strictObject({ type: z.literal('registry-changed') }),
]);
export type RpcControlMessage = z.infer<typeof messageSchema>;
export type RpcStopStatus = 'idle' | 'checking' | 'requested' | 'applied' | 'retired' | 'unconfirmed';

/** A same-origin, restriction-only control channel. It never carries RPC
 * calls, keys, headers, settings values, or a command that grants authority.
 * An acknowledgement describes logical admission, not physical GPU idleness. */
export function createRpcStopControl({ send, nextId, changed, registryChanged, timeoutMs }: {
  send({ message }: { message: RpcControlMessage }): void,
  nextId(): string,
  changed(): void,
  registryChanged(): void,
  timeoutMs: number,
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid control response timeout');
  type Owner = { id: string, stop(): Promise<void>, admission: 'idle' | 'starting' | 'closed' | 'failed', requestId: string | undefined, completion: 'pending' | 'retired' | 'failed' };
  let owner: Owner | undefined;
  let pending: { id: string, ownerId: string | undefined, status: RpcStopStatus } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const publish = () => {
    try {
      changed();
    } catch { /* Observation only. */ }
  };
  const clearTimer = () => {
    clearTimeout(timer); timer = undefined;
  };
  const post = ({ message }: { message: RpcControlMessage }) => {
    try {
      send({ message });
    } catch { /* No delivery means no acknowledgement. */ }
  };
  const status = () => pending?.status ?? 'idle';
  const applied = ({ requestId, ownerId }: { requestId: string, ownerId: string }) => {
    if (pending?.id !== requestId || pending.ownerId !== ownerId) return;
    switch (pending.status) {
    case 'retired': return;
    case 'idle': case 'checking': case 'requested': case 'applied': case 'unconfirmed': break;
    default: { const exhaustive: never = pending.status; throw new Error(String(exhaustive)); }
    }
    clearTimer(); pending.status = 'applied'; publish();
  };
  const retired = ({ ownerId }: { ownerId: string }) => {
    if (pending?.ownerId !== ownerId) return;
    clearTimer(); pending.status = 'retired'; publish();
  };
  const retirementFailed = ({ ownerId }: { ownerId: string }) => {
    if (pending?.ownerId !== ownerId) return;
    clearTimer(); pending.status = 'unconfirmed'; publish();
  };
  const stopOwner = ({ requestId, current }: { requestId: string, current: Owner }) => {
    // Keep only the latest acknowledgement request, not one unbounded pending
    // Promise per notification. stop() may synchronously notify observers which
    // request stopping again, before it has closed admission.
    current.requestId = requestId;
    switch (current.admission) {
    case 'idle': {
      current.admission = 'starting';
      try {
        const retirement = current.stop();
        current.admission = 'closed';
        void retirement.then(() => {
          current.completion = 'retired';
          if (disposed) return;
          post({ message: { type: 'retired', ownerId: current.id } }); retired({ ownerId: current.id });
        }, () => {
          current.completion = 'failed';
          if (disposed) return;
          post({ message: { type: 'retirement-failed', ownerId: current.id } }); retirementFailed({ ownerId: current.id });
        });
      } catch {
        // A partially executed synchronous boundary cannot safely be rerun or
        // acknowledged as applied. Retain uncertainty for subsequent requests.
        current.admission = 'failed'; current.completion = 'failed';
      }
      break;
    }
    case 'starting': case 'closed': case 'failed': break;
    default: { const exhaustive: never = current.admission; throw new Error(String(exhaustive)); }
    }
    switch (current.admission) {
    case 'starting': return;
    case 'failed':
      post({ message: { type: 'retirement-failed', ownerId: current.id } }); retirementFailed({ ownerId: current.id }); return;
    case 'closed': break;
    default: { const exhaustive: never = current.admission; throw new Error(String(exhaustive)); }
    }
    const acknowledgement = current.requestId;
    post({ message: { type: 'applied', requestId: acknowledgement, ownerId: current.id } });
    applied({ requestId: acknowledgement, ownerId: current.id });
    switch (current.completion) {
    case 'pending': break;
    case 'retired': post({ message: { type: 'retired', ownerId: current.id } }); retired({ ownerId: current.id }); break;
    case 'failed': post({ message: { type: 'retirement-failed', ownerId: current.id } }); retirementFailed({ ownerId: current.id }); break;
    default: { const exhaustive: never = current.completion; throw new Error(String(exhaustive)); }
    }
  };
  return {
    status,
    clearRequest(): void {
      clearTimer(); pending = undefined; publish();
    },
    registerOwner({ ownerId, stop }: { ownerId: string, stop(): Promise<void> }): () => void {
      if (disposed || owner) throw new Error('A control owner is already registered or closed');
      const current: Owner = { id: token.parse(ownerId), stop, admission: 'idle', requestId: undefined, completion: 'pending' }; owner = current;
      return () => {
        if (owner === current) owner = undefined;
      };
    },
    requestStop(): void {
      if (disposed) throw new Error('RPC stop control is closed');
      clearTimer();
      pending = { id: token.parse(nextId()), ownerId: owner?.id, status: 'checking' };
      const request = pending;
      timer = setTimeout(() => {
        if (pending !== request) return;
        pending.status = 'unconfirmed'; timer = undefined; publish();
      }, timeoutMs);
      publish();
      if (owner) stopOwner({ requestId: request.id, current: owner });
      else post({ message: { type: 'probe', requestId: request.id } });
    },
    receive({ value }: { value: unknown }): void {
      if (disposed) return;
      const parsed = messageSchema.safeParse(value); if (!parsed.success) return;
      const message = parsed.data;
      switch (message.type) {
      case 'probe':
        if (owner) post({ message: { type: 'owner', requestId: message.requestId, ownerId: owner.id } });
        break;
      case 'owner':
        if (pending?.id !== message.requestId || pending.ownerId !== undefined) return;
        pending.ownerId = message.ownerId;
        switch (pending.status) {
        case 'unconfirmed': break;
        case 'idle': case 'checking': case 'requested': case 'applied': case 'retired': pending.status = 'requested'; break;
        default: { const exhaustive: never = pending.status; throw new Error(String(exhaustive)); }
        }
        publish();
        post({ message: { type: 'stop', requestId: message.requestId, ownerId: message.ownerId } });
        break;
      case 'stop':
        // A delayed request addressed to a former lock holder cannot stop its successor.
        if (owner?.id === message.ownerId) stopOwner({ requestId: message.requestId, current: owner });
        break;
      case 'applied': applied(message); break;
      case 'retired': retired(message); break;
      case 'retirement-failed': retirementFailed(message); break;
      case 'registry-changed': registryChanged(); break;
      default: { const exhaustive: never = message; throw new Error(String(exhaustive)); }
      }
    },
    registryChanged(): void {
      post({ message: { type: 'registry-changed' } });
    },
    dispose(): void {
      disposed = true; clearTimer(); owner = undefined; pending = undefined;
    },
  };
}
export const TEST_ONLY = {
};
