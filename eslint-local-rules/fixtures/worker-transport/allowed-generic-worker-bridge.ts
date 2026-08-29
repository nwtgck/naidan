import type * as Comlink from "comlink";
declare function wrapWorkerRemote<Api>(endpoint: Comlink.Endpoint): Comlink.Remote<Api>;
export function allowedBridge<Api>({ endpoint }: { endpoint: Comlink.Endpoint }) {
  return wrapWorkerRemote<Api>(endpoint);
}
