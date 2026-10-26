// @vitest-environment node
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveConfig, type Connect, type EnvironmentModuleNode, type HotUpdateOptions, type IndexHtmlTransformContext, type IndexHtmlTransformResult, type Plugin, type ResolvedConfig, type ViteDevServer } from 'vite';

import { createDevServerIsolationPlugin } from './dev-server-isolation';

type HookHandler<TArguments extends unknown[], TResult> = (...arguments_: TArguments) => TResult;

function getHookHandler<TArguments extends unknown[], TResult>({ hook, name }: {
  hook: unknown;
  name: string;
}): HookHandler<TArguments, TResult> {
  if (typeof hook === 'function') {
    return hook as HookHandler<TArguments, TResult>;
  }
  if (typeof hook === 'object' && hook !== null && 'handler' in hook && typeof hook.handler === 'function') {
    return hook.handler as HookHandler<TArguments, TResult>;
  }
  throw new TypeError(`Expected ${name} to be a callable Vite hook.`);
}

let developmentConfig: ResolvedConfig;

beforeAll(async () => {
  developmentConfig = await resolveConfig({ mode: 'development' }, 'serve');
});

function getDevelopmentPlugin({ name }: { name: string }): Plugin {
  const plugin = developmentConfig.plugins.find(plugin => plugin.name === name);
  if (plugin === undefined) {
    throw new Error(`Missing development plugin: ${name}.`);
  }
  return plugin;
}

function createHeaderHarness() {
  const handlers: Connect.NextHandleFunction[] = [];
  // These hooks only use registration, the root and the broker module graph.
  // No HTTP listener, socket connection or Vite server is started by this fixture.
  const server = {
    config: { root: process.cwd() },
    environments: { client: { moduleGraph: { getModuleById: () => undefined } } },
    middlewares: { use: (handler: Connect.NextHandleFunction) => handlers.push(handler) },
  } as unknown as ViteDevServer;
  for (const plugin of [
    getDevelopmentPlugin({ name: 'privacy-fetch-broker-dev-headers' }),
    createDevServerIsolationPlugin(),
  ]) {
    getHookHandler<[ViteDevServer], unknown>({ hook: plugin.configureServer, name: 'configureServer' })(server);
  }
  return {
    async request({ url, method }: { url: string; method: 'GET' | 'HEAD' }) {
      const socket = new Socket();
      const request = new IncomingMessage(socket);
      request.url = url;
      request.method = method;
      const response = new ServerResponse(request);
      using cleanup = {
        [Symbol.dispose]() {
          response.destroy();
          request.destroy();
          socket.destroy();
        },
      };
      for (const handler of handlers) {
        await new Promise<void>((resolve, reject) => {
          handler(request, response, (error?: unknown) => error === undefined ? resolve() : reject(error));
        });
      }
      response.setHeader('Content-Type', 'text/plain');
      response.end('fixture response');
      return {
        status: response.statusCode,
        headers: new Map(Object.entries(response.getHeaders())),
        ended: response.writableEnded,
      };
    },
  };
}

function createDocumentHarness({ hmr, environmentName }: { hmr: boolean; environmentName: string }) {
  const root = path.join(os.tmpdir(), 'naidan-broker-hmr-hook-fixture');
  const plugin = getDevelopmentPlugin({ name: 'strip-privacy-fetch-broker-dev-injected-scripts' });
  const hotUpdate = getHookHandler<[HotUpdateOptions], EnvironmentModuleNode[] | void | Promise<EnvironmentModuleNode[] | void>>({ hook: plugin.hotUpdate, name: 'hotUpdate' });
  const transformIndexHtml = getHookHandler<[string, IndexHtmlTransformContext], IndexHtmlTransformResult | void | Promise<IndexHtmlTransformResult | void>>({ hook: plugin.transformIndexHtml, name: 'transformIndexHtml' });
  const send = vi.fn<(payload: unknown) => void>();
  const modules: EnvironmentModuleNode[] = [
    { id: path.join(root, 'broker.ts'), url: '/broker.ts' } as EnvironmentModuleNode,
  ];
  const server = { config: { root } } as unknown as ViteDevServer;
  const environment = { name: environmentName, config: { root, server: { hmr } }, hot: { send } };
  return {
    root,
    send,
    modules,
    async update({ type, file }: { type: HotUpdateOptions['type']; file: string }) {
      return hotUpdate.call({ environment }, { type, file, modules, server, timestamp: 1, read: () => '' });
    },
    async transform({ html, pathname, originalUrl }: { html: string; pathname: string; originalUrl: string }) {
      const result = await transformIndexHtml(html, {
        path: pathname,
        filename: path.join(root, pathname),
        originalUrl,
      });
      if (typeof result !== 'string') {
        throw new Error('Expected transformed HTML.');
      }
      return result;
    },
  };
}

describe('development plugin lifecycle', () => {
  it.each(['development', 'hosted'])('excludes output-mutating plugins from serve in %s mode', async (mode) => {
    const config = mode === 'development' ? developmentConfig : await resolveConfig({ mode }, 'serve');
    const names = config.plugins.map((plugin) => plugin.name);
    expect(names).not.toContain('manual-gzip-wasm-plugin');
    expect(names).not.toContain('copy-zip-plugin');
    expect(names.some((name) => name.startsWith('zip-packager-plugin-'))).toBe(false);
  });

  it('retains compression and standalone package copying in hosted builds', async () => {
    const config = await resolveConfig({ mode: 'hosted' }, 'build');
    const names = config.plugins.map((plugin) => plugin.name);
    expect(names).toContain('manual-gzip-wasm-plugin');
    expect(names).toContain('copy-zip-plugin');
  });

  it('retains hosted archive creation in hosted builds', async () => {
    const config = await resolveConfig({ mode: 'hosted' }, 'build');
    expect(config.plugins.some((plugin) => plugin.name.startsWith('zip-packager-plugin-'))).toBe(true);
  });
});

describe('privacy fetch broker development headers', () => {
  it.each(['GET', 'HEAD'] as const)('preserves document isolation with and without a query for %s', async (method) => {
    const fixture = createHeaderHarness();
    for (const url of ['/privacy-fetch-broker.html', '/privacy-fetch-broker.html?t=1']) {
      const response = await fixture.request({ url, method });
      expect(response.status).toBe(200);
      expect(response.ended).toBe(true);
      expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
      expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
      expect(response.headers.get('access-control-allow-origin')).toBeUndefined();
    }
  });

  it('does not grant broker headers to another document with a similar path', async () => {
    const response = await createHeaderHarness().request({ url: '/privacy-fetch-broker.html.extra?t=1', method: 'GET' });
    expect(response.headers.get('cross-origin-resource-policy')).toBeUndefined();
    expect(response.headers.get('access-control-allow-origin')).toBeUndefined();
  });

  it('keeps the existing module headers with query parameters', async () => {
    const response = await createHeaderHarness().request({ url: '/src/features/privacy-fetch/entry.ts?t=1', method: 'GET' });
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('privacy fetch broker document updates', () => {
  it('keeps the broker entry but excludes the development client in query-bearing HTML', async () => {
    const fixture = createDocumentHarness({ hmr: true, environmentName: 'client' });
    const html = `\
<!doctype html><title>Privacy fetch broker</title>
<script type="module" src="/@vite/client"></script>
<script type="module" src="/@id/virtual:vue-devtools-path:overlay.js"></script>
<script type="module" src="/@id/virtual:vue-inspector-path:load.js"></script>
<script type="module" src="/broker.ts"></script>
`;
    const body = await fixture.transform({ html, pathname: '/privacy-fetch-broker.html', originalUrl: '/privacy-fetch-broker.html?t=1' });
    expect(body).toContain('/broker.ts');
    expect(body).not.toContain('/@vite/client');
    expect(body).not.toContain('virtual:vue-devtools-path');
    expect(body).not.toContain('virtual:vue-inspector-path');
    const parent = await fixture.transform({ html, pathname: '/index.html', originalUrl: '/index.html' });
    expect(parent).toBe(html);
    expect(parent).toContain('/@vite/client');
  });

  it('requests a parent-page reload when the broker document changes', async () => {
    const fixture = createDocumentHarness({ hmr: true, environmentName: 'client' });
    const result = await fixture.update({ type: 'update', file: path.join(fixture.root, 'privacy-fetch-broker.html') });
    expect(result).toEqual([]);
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith({ type: 'full-reload' });
  });

  it('requests a parent-page reload when the broker document is deleted', async () => {
    const fixture = createDocumentHarness({ hmr: true, environmentName: 'client' });
    const result = await fixture.update({ type: 'delete', file: path.join(fixture.root, 'privacy-fetch-broker.html') });
    expect(result).toEqual([]);
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith({ type: 'full-reload' });
  });

  it('requests a parent-page reload when the broker document is restored', async () => {
    const fixture = createDocumentHarness({ hmr: true, environmentName: 'client' });
    const file = path.join(fixture.root, 'privacy-fetch-broker.html');
    await fixture.update({ type: 'delete', file });
    fixture.send.mockClear();
    const result = await fixture.update({ type: 'create', file });
    expect(result).toEqual([]);
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith({ type: 'full-reload' });
  });

  it('does not broadcast an unrestricted reload for a different document with the same basename', async () => {
    const fixture = createDocumentHarness({ hmr: true, environmentName: 'client' });
    const result = await fixture.update({ type: 'update', file: path.join(fixture.root, 'nested/privacy-fetch-broker.html') });
    // Preserve Vite's normal handling instead of replacing it with a global reload.
    expect(result).toBe(fixture.modules);
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it('does not reload the broker document when HMR is disabled', async () => {
    const fixture = createDocumentHarness({ hmr: false, environmentName: 'client' });
    const result = await fixture.update({ type: 'update', file: path.join(fixture.root, 'privacy-fetch-broker.html') });
    expect(result).toBe(fixture.modules);
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it('does not reload the parent page from a non-client environment', async () => {
    const fixture = createDocumentHarness({ hmr: true, environmentName: 'ssr' });
    const result = await fixture.update({ type: 'update', file: path.join(fixture.root, 'privacy-fetch-broker.html') });
    expect(result).toBe(fixture.modules);
    expect(fixture.send).not.toHaveBeenCalled();
  });
});
