import type * as Comlink from "comlink";

declare function wrapWorkerRemote<Api>(endpoint: Comlink.Endpoint): Comlink.Remote<Api>;
declare const endpoint: Comlink.Endpoint;

interface UnsafeTsxApi {
  run(request: { callback: () => void }): Promise<void>;
}
wrapWorkerRemote<UnsafeTsxApi>(endpoint);

export const probe = <div />;
