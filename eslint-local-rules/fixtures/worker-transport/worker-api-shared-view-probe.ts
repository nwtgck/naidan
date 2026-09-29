import * as Comlink from 'comlink';

declare const endpoint: Comlink.Endpoint;
interface SharedBytesApi {
  read(): Promise<Uint8Array<SharedArrayBuffer>>;
}
declare const shared: SharedBytesApi;
Comlink.expose(shared, endpoint);

interface UnspecifiedBufferApi {
  read(): Promise<Uint8Array<ArrayBufferLike>>;
}
declare const unspecified: UnspecifiedBufferApi;
Comlink.expose(unspecified, endpoint);
