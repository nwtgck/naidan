import { ConnectionOpenPermits } from '@/features/naidan-rpc';
import type { ConnectionInitiation } from '@/features/naidan-rpc';

/** One lease reserves a complete GET/POST pair for one origin. Held leases
 * survive connection establishment; failed retirement deliberately retains them. */
export class RpcConnectionPermits {
  private readonly origins = new Map<string, ConnectionOpenPermits>();

  acquire({ origin, signal, mode }: { origin: string; signal: AbortSignal; mode: ConnectionInitiation }): ReturnType<ConnectionOpenPermits['acquire']> {
    const key = new URL(origin).origin;
    let permits = this.origins.get(key);
    if (!permits) {
      permits = new ConnectionOpenPermits({ capacity: 2, maximumWaiting: 32 }); this.origins.set(key, permits);
    }
    const current = permits;
    const forget = () => {
      if (current.idle && this.origins.get(key) === current) this.origins.delete(key);
    };
    try {
      const admission = current.acquire({ signal, mode });
      return {
        promote: admission.promote,
        ready: admission.ready.then(release => () => {
          release(); forget();
        }, error => {
          forget(); throw error;
        }),
      };
    } catch (error) {
      forget(); throw error;
    }
  }
}
export const TEST_ONLY = {
};
