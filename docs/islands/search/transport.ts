// Docs keeps its Worker boundary independent of the application transport.
// eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- Comlink is the transport; callers validate RPC data with the search schemas.
import * as Comlink from 'comlink';
import type { SearchWorkerApi } from './worker-contracts';

export type SearchWorkerRemote = Comlink.Remote<SearchWorkerApi>;

export function wrapSearchWorker({ worker }: { worker: Worker }): SearchWorkerRemote {
  return Comlink.wrap<SearchWorkerApi>(worker);
}

export function exposeSearchWorker({ api }: { api: SearchWorkerApi }): void {
  Comlink.expose(api);
}

export function releaseSearchWorker({ remote }: { remote: SearchWorkerRemote }): void {
  remote[Comlink.releaseProxy]();
}
