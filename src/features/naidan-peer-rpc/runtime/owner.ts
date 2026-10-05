export type RpcOwnerLease = { release(): void };
/** The lock belongs to the manager, not a Settings component. Never steal an
 * existing owner: a frozen tab may still own native work and relay readers. */
export function acquireRpcOwner({ signal }: { signal: AbortSignal }): Promise<RpcOwnerLease> {
  signal.throwIfAborted();
  if (!navigator.locks) return Promise.reject(new Error('RPC connection ownership is unavailable in this browser'));
  return new Promise((resolve, reject) => {
    const released = Promise.withResolvers<void>();
    // Web Locks rejects signal together with ifAvailable. Keep conditional
    // acquisition (no queue or stealing), and fence the asynchronous grant
    // ourselves. Do not settle an aborted attempt before this callback: a late
    // grant must return without publishing a lease before the manager retires.
    const pending = navigator.locks.request('naidan-peer-rpc-owner/v1', { ifAvailable: true }, async lock => {
      if (!lock) {
        reject(new Error('Naidan RPC is managed by another tab')); return;
      }
      if (signal.aborted) {
        reject(signal.reason); return;
      }
      resolve({ release: () => released.resolve() });
      await released.promise;
    });
    void pending.catch(reject);
  });
}
export const TEST_ONLY = {
};
