import { nanoid } from 'nanoid';
import type { createRpcStopControl } from './stop-control';
import type { Settings } from '@/01-models/types';
import { naidanRpcStorage } from '@/00-storage/service/naidan-rpc';
import { NaidanPeerManager } from './manager';
import { createRpcIdentityLoader } from './identity';
import { acquireRpcOwner } from './owner';
import { openPipingRpc } from '@/features/naidan-peer-rpc/transports/piping';
import { createInferenceBudget } from '@/features/naidan-peer-rpc/handlers/inference/budget';
import { createInferenceLifetime } from './inference-lifetime';

export function createRpcManager({ settings, changed, control, stopping }: { settings(): Settings | undefined, changed(): void, control: ReturnType<typeof createRpcStopControl>, stopping(): void }): NaidanPeerManager {
  const identity = createRpcIdentityLoader({ read: () => naidanRpcStorage.readIdentity() });
  const inputBudget = createInferenceBudget({ capacity: 256 * 1024 * 1024 });
  const deliveryBudget = createInferenceBudget({ capacity: 128 * 1024 * 1024 });
  const inference = createInferenceLifetime({ budgets: [inputBudget, deliveryBudget], load: () => import('@/features/naidan-peer-rpc/handlers/inference/resources-factory')
    .then(({ createReadOnlyResources }) => createReadOnlyResources({ directories: () => settings()?.experimental?.hostModelDirectories ?? [] })) });
  const storage = {
    readIdentity: () => naidanRpcStorage.readIdentity(),
    list: () => naidanRpcStorage.list(),
    async remember({ ...args }: Parameters<typeof naidanRpcStorage.remember>[0]) {
      await naidanRpcStorage.remember(args); control.registryChanged();
    },
    async update({ ...args }: Parameters<typeof naidanRpcStorage.update>[0]) {
      const revision = await naidanRpcStorage.update(args); control.registryChanged(); return revision;
    },
    async remove({ ...args }: Parameters<typeof naidanRpcStorage.remove>[0]) {
      await naidanRpcStorage.remove(args); control.registryChanged();
    },
  };
  const manager: NaidanPeerManager = new NaidanPeerManager({ dependencies: { storage, identity: () => identity.load(),
    acquireOwner: async ({ signal }) => {
      const lease = await acquireRpcOwner({ signal });
      try {
        signal.throwIfAborted();
        const unregister = control.registerOwner({ ownerId: nanoid(), stop: () => {
          stopping(); return manager.setEnabled({ enabled: false });
        } });
        let released = false;
        return { release() {
          if (released) return; released = true; unregister(); lease.release();
        } };
      } catch (error) {
        lease.release(); throw error;
      }
    },
    open: openPipingRpc, changed, retireResources: () => inference.retire(), inference: { resources: inference.resources,
      inputBudget, deliveryBudget } } });
  return manager;
}
export const TEST_ONLY = {
};
