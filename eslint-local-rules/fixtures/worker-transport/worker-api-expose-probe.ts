import * as Comlink from "comlink";

type WorkerProxy<T extends object> = T & Comlink.ProxyMarked;
declare const endpoint: Comlink.Endpoint;

interface SafeExposedApi {
  run(request: { id: string }): Promise<{ ok: boolean }>;
}
declare const safeApi: SafeExposedApi;
Comlink.expose(safeApi, endpoint);

interface ProxyExposedApi {
  run(callback: WorkerProxy<(value: number) => void>): Promise<void>;
}
declare const proxyApi: ProxyExposedApi;
Comlink.expose(proxyApi, endpoint);

interface UnsafeExposedApi {
  run(request: { callback: () => void }): Promise<void>;
}
declare const unsafeApi: UnsafeExposedApi;
Comlink.expose(unsafeApi, endpoint);

interface UnknownExposedApi {
  run(request: { metadata: Record<string, unknown> }): Promise<void>;
}
declare const unknownApi: UnknownExposedApi;
Comlink.expose(unknownApi, endpoint);


Comlink.expose({
  async run(request: { id: string }): Promise<{ ok: boolean }> {
    return { ok: request.id.length > 0 };
  },
}, endpoint);
