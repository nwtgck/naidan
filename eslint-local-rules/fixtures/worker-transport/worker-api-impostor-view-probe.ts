import * as Comlink from 'comlink';

// A local type with the native name must not gain clone permission by spelling.
interface Uint8Array<TBuffer> {
  callback(): void;
  buffer: TBuffer;
}
declare const endpoint: Comlink.Endpoint;
interface ImpostorApi {
  read(): Promise<Uint8Array<ArrayBuffer>>;
}
declare const api: ImpostorApi;
Comlink.expose(api, endpoint);
