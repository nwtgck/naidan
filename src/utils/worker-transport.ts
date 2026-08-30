import * as Comlink from 'comlink';

export type WorkerRemote<Api> = Comlink.Remote<Api>;
export type WorkerProxy<T extends object> = T & Comlink.ProxyMarked;

declare const workerTransferMarker: unique symbol;
export interface WorkerTransferMarked {
  readonly [workerTransferMarker]: true,
}
export type WorkerTransfer<T extends object> = T & WorkerTransferMarked;

export type WorkerCloneCapability =
  | 'file-system-handle-clone'
  | 'file-system-handle-and-storage-directory-worker-mount-grant-clone';

declare const workerCapabilityMarker: unique symbol;
export interface WorkerCapabilityMarked<Capability extends WorkerCloneCapability> {
  readonly [workerCapabilityMarker]: Capability,
}
export type WorkerCapability<
  T extends object,
  Capability extends WorkerCloneCapability,
> = T & WorkerCapabilityMarked<Capability>;

type WorkerServerArgument<T> =
  T extends WorkerCapabilityMarked<WorkerCloneCapability>
    ? Omit<T, keyof WorkerCapabilityMarked<WorkerCloneCapability>>
    : T extends WorkerTransferMarked
      ? Omit<T, keyof WorkerTransferMarked>
      : T extends Comlink.ProxyMarked
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors an external Comlink positional callback boundary.
        ? T extends (...args: infer Args) => infer Result
          // eslint-disable-next-line local-rules-named-args/require-named-args -- Preserves the external Comlink positional callback signature.
          ? (...args: Args) => Result
          : Omit<T, keyof Comlink.ProxyMarked>
        : T;

export type WorkerServerApi<Api> = {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors Worker RPC positional signatures declared at the Comlink boundary.
  [Key in keyof Api]: Api[Key] extends (...args: infer Args) => infer Result
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Preserves Worker RPC positional signatures while removing wire-only markers.
    ? (...args: { [Index in keyof Args]: WorkerServerArgument<Args[Index]> }) => Result
    : Api[Key];
};

export function wrapWorkerRemote<Api>({
  endpoint,
}: {
  endpoint: Comlink.Endpoint,
}): WorkerRemote<Api> {
  return Comlink.wrap<Api>(endpoint);
}

export function exposeWorkerRemote<Api>({
  api,
  endpoint,
}: {
  api: WorkerServerApi<Api>,
  endpoint: Comlink.Endpoint | undefined,
}): void {
  Comlink.expose(api, endpoint);
}

export function workerProxy<T extends object>({
  value,
}: {
  value: T,
}): WorkerProxy<T> {
  return Comlink.proxy(value);
}

export function workerTransfer<T extends object>({
  value,
  transferables,
}: {
  value: T,
  transferables: Transferable[],
}): WorkerTransfer<T> {
  return Comlink.transfer(value, transferables) as WorkerTransfer<T>;
}

export function workerCapability<
  T extends object,
  Capability extends WorkerCloneCapability,
>({
  value,
  capability: _capability,
}: {
  value: T,
  capability: Capability,
}): WorkerCapability<T, Capability> {
  return value as WorkerCapability<T, Capability>;
}

export function releaseWorkerRemote<Api>({
  remote,
}: {
  remote: WorkerRemote<Api>,
}): unknown {
  return remote[Comlink.releaseProxy]();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
