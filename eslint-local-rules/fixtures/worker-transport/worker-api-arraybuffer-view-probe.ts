import * as Comlink from 'comlink';

declare const endpoint: Comlink.Endpoint;
interface CapturedBytesApi {
  read(): Promise<{
    bytes: Uint8Array<ArrayBuffer>;
    samples: Float32Array<ArrayBuffer>;
    ids: BigInt64Array<ArrayBuffer>;
    view: DataView<ArrayBuffer>;
  }>;
}
declare const api: CapturedBytesApi;
Comlink.expose(api, endpoint);
