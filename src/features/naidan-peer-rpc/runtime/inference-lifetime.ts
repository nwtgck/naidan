import type { InferenceBudget } from '@/features/naidan-peer-rpc/handlers/inference/budget';
import type { OwnedInferenceResources, ReadOnlyInferenceResources } from '@/features/naidan-peer-rpc/handlers/inference/resources';

/** Native imports are owned by the manager, not by a view or one connection.
 * Retiring a pending load prevents its handlers from running when it arrives.
 * It never loads a provider just to turn an unused feature off. */
export function createInferenceLifetime({ load, budgets = [] }: { load(): Promise<OwnedInferenceResources>; budgets?: readonly InferenceBudget[] }): {
  resources: ReadOnlyInferenceResources,
  retire(): Promise<void>,
} {
  let current: { value: Promise<OwnedInferenceResources> } | undefined;
  const retiring = new Set<Promise<void>>();
  const deliveryOwners = [...budgets];
  let retirementFailure: { error: unknown } | undefined;
  const acquire = async ({ signal }: { signal: AbortSignal }) => {
    signal.throwIfAborted();
    if (retirementFailure) throw retirementFailure.error;
    if (!current) {
      const entry = { value: Promise.resolve().then(load) };
      current = entry;
      void entry.value.catch(() => {
        if (current === entry) current = undefined;
      });
    }
    const entry = current;
    const resources = await entry.value;
    signal.throwIfAborted();
    const active = () => {
      signal.throwIfAborted();
      if (retirementFailure) throw retirementFailure.error;
      if (current !== entry) throw new DOMException('Inference resources were retired', 'AbortError');
      return resources;
    };
    // Recheck immediately before dispatch too: retiring may run between this
    // Promise settling and the awaiting wrapper's continuation.
    return active;
  };
  return {
    resources: {
      async listChatModels({ ...args }) {
        return (await acquire({ signal: args.signal }))().listChatModels(args);
      },
      async generateChat({ ...args }) {
        return (await acquire({ signal: args.signal }))().generateChat(args);
      },
      async listImageModels({ ...args }) {
        return (await acquire({ signal: args.signal }))().listImageModels(args);
      },
      async generateImage({ ...args }) {
        return (await acquire({ signal: args.signal }))().generateImage(args);
      },
    },
    retire() {
      const previous = current; current = undefined;
      if (previous) {
        // A failed import has no owner to dispose; its original caller sees the
        // failure. A disposal failure still propagates to the shutdown owner.
        const task = previous.value.then(resources => resources.dispose(), () => {});
        retiring.add(task);
        const settled = () => retiring.delete(task);
        void task.then(settled, error => {
          retirementFailure ??= { error }; settled();
        });
      }
      // The manager closes admission and retires protocol calls first. Source
      // controllers may already be errored, in which case reader.cancel() does
      // not join outstanding Blob reads. Their budgets own that remaining work.
      return Promise.allSettled([...retiring, ...deliveryOwners.map(budget => budget.whenIdle())]).then(results => {
        for (const result of results) {
          switch (result.status) {
          case 'fulfilled': break;
          case 'rejected': throw result.reason;
          default: { const unreachable: never = result; throw new Error(String(unreachable)); }
          }
        }
        // Repeated retirement cannot silently report a failed disposal as done.
        if (retirementFailure) throw retirementFailure.error;
      });
    },
  };
}
export const TEST_ONLY = {
};
