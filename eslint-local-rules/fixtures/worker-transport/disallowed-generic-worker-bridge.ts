import type * as Comlink from "comlink";
declare function wrapWorkerRemote<Api>(endpoint: Comlink.Endpoint): Comlink.Remote<Api>;
export function arbitraryFeatureBridge<Api>({ endpoint }: { endpoint: Comlink.Endpoint }) {
  return wrapWorkerRemote<Api>(endpoint);
}
