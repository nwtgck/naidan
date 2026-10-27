import type { Connect, Plugin } from 'vite';
import { vi } from 'vitest';

/** Exercise the plugin's HTTP adapter without opening a socket or a browser. */
export async function runtimeAssetMiddleware({ plugin, base }: { plugin: Plugin, base: string }) {
  const use = vi.fn();
  const configure = typeof plugin.configureServer === 'function' ? plugin.configureServer : plugin.configureServer?.handler;
  if (configure === undefined) {
    throw new Error('Expected runtime asset middleware.');
  }
  await configure.call({} as never, { config: { base }, middlewares: { use } } as never);
  const handler = use.mock.calls[0]?.[0] as Connect.NextHandleFunction | undefined;
  if (handler === undefined) {
    throw new Error('Expected a registered HTTP handler.');
  }
  return {
    async request({ url }: { url: string }) {
      const finished = Promise.withResolvers<Uint8Array | undefined>();
      const response = { statusCode: 200, setHeader: vi.fn(), end: vi.fn(finished.resolve) };
      const next: Connect.NextFunction = error => {
        if (error === undefined) {
          finished.resolve(undefined);
        } else {
          finished.reject(error);
        }
      };
      try {
        handler({ url, method: 'GET' } as never, response as never, next);
      } catch (error) {
        finished.reject(error);
      }
      const bytes = await finished.promise;
      return { bytes, status: response.statusCode, headers: new Map(response.setHeader.mock.calls.map(([name, value]) => [name, value])) };
    },
  };
}
