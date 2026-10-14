import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import type { DocsRenderer } from '../build/contracts';
import { createDocsDevBridge } from '../../build/docs-dev-bridge';
import { createSiteFixture, parsePage, startSiteDev } from './site.test-support';

type BridgeMiddleware = (request: { url: string; method: string }, response: { statusCode: number; end: (body?: string) => void }, next: (error?: unknown) => void) => Promise<void>;

it('replaces the Docs child after compiler edits before serving another request', async () => {
  const watcher = new EventEmitter();
  const events: string[] = [];
  let middleware: BridgeMiddleware | undefined;
  let generation = 0;
  const parent = {
    config: { root: '/tmp/docs-bridge-probe', logger: { error: vi.fn() } },
    watcher: { add: vi.fn(), on: watcher.on.bind(watcher) },
    middlewares: {
      use: (handler: BridgeMiddleware) => {
        middleware = handler;
      },
    },
    ssrLoadModule: vi.fn(async () => ({
      createDocsDevServer: async () => {
        const child = ++generation;
        events.push(`create ${child}`);
        return {
          middlewares: (_request: unknown, response: { end: (body: string) => void }) => response.end(`child ${child}`),
          close: async () => {
            events.push(`close ${child}`);
          },
        };
      },
    })),
  } as unknown as ViteDevServer;
  const bridge = createDocsDevBridge();
  const configure = bridge.configureServer as (server: ViteDevServer) => void;
  configure(parent);
  const request = async (): Promise<string> => {
    if (!middleware) throw new Error('Missing Docs bridge middleware');
    let finish: ((body: string) => void) | undefined;
    const completed = new Promise<string>(resolve => {
      finish = resolve;
    });
    await middleware({ url: '/docs/en/', method: 'GET' }, {
      statusCode: 200,
      end: body => finish?.(body ?? ''),
    }, error => {
      throw error;
    });
    return completed;
  };
  expect(await request()).toBe('child 1');
  watcher.emit('all', 'change', '/tmp/docs-bridge-probe/docs/build/virtual-modules.ts');
  expect(await request()).toBe('child 2');
  expect(events).toEqual(['create 1', 'close 1', 'create 2']);
  expect(parent.ssrLoadModule).toHaveBeenCalledTimes(2);
  const close = bridge.closeBundle as () => Promise<void>;
  await close();
  expect(events.at(-1)).toBe('close 2');
});

describe('Docs development registry', () => {
  it('serves a styled 404 while the home page has a syntax error', async () => {
    await using fixture = await createSiteFixture();
    const homeFile = path.join(fixture.docs, 'pages/index/index.vue');
    const homeSource = await readFile(homeFile, 'utf8');
    const brokenHome = homeSource.replace('<script setup lang="ts">', `\
<script setup lang="ts">
const broken = ;`);
    expect(brokenHome).not.toBe(homeSource);
    await using dev = await startSiteDev({ root: fixture.root });
    expect((await dev.request({ url: '/docs/en/' })).status).toBe(200);

    await writeFile(homeFile, brokenHome);
    await vi.waitFor(async () => {
      expect((await dev.request({ url: '/docs/en/' })).status).toBe(500);
    }, { timeout: 5000, interval: 100 });
    const missing = await dev.request({ url: '/docs/en/not-a-page/' });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('text/html');
    using page = parsePage({ html: await missing.text() });
    expect(page.document.title).toBe('404 | Naidan Docs');
    expect(page.document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
    const stylesheet = page.document.querySelector('link[rel="stylesheet"]')?.getAttribute('href');
    expect(stylesheet).toBe('/docs/site/site.css?direct');
    const css = await dev.request({ url: stylesheet ?? '' });
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(await css.text()).toContain('.language-page');

    expect((await dev.request({ url: '/docs/en/tool-browser-shell/' })).status).toBe(200);

    await writeFile(homeFile, homeSource);
    await vi.waitFor(async () => {
      expect((await dev.request({ url: '/docs/en/' })).status).toBe(200);
    }, { timeout: 5000, interval: 100 });
  });

  it('isolates a broken page and language, then recovers in the same SSR server', async () => {
    const repository = process.cwd();
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'docs-registry-'));
    await using _fixture = {
      async [Symbol.asyncDispose]() {
        await rm(fixture, { recursive: true, force: true });
      },
    };
    await cp(path.join(repository, 'docs'), path.join(fixture, 'docs'), { recursive: true });
    await cp(path.join(repository, 'tsconfig.node.json'), path.join(fixture, 'tsconfig.node.json'));
    await symlink(path.join(repository, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');

    const pageFile = path.join(fixture, 'docs/pages/tool-browser-shell/index.vue');
    const pageSource = await readFile(pageFile, 'utf8');
    const brokenPage = pageSource.replace('<script setup lang="ts">', `\
<script setup lang="ts">
const broken = ;`);
    expect(brokenPage).not.toBe(pageSource);
    await writeFile(pageFile, brokenPage);

    const parent = await createServer({ configFile: path.join(fixture, 'docs/vite.config.ts'), server: { middlewareMode: true, hmr: false, ws: false }, logLevel: 'silent' });
    await using _parent = {
      async [Symbol.asyncDispose]() {
        await parent.close();
      },
    };
    const factory = await parent.ssrLoadModule('/build/dev.ts') as {
      createDocsDevServer: ({ root, parentServer }: { root: string; parentServer: ViteDevServer }) => Promise<ViteDevServer>;
    };
    // The request plugin is under test; no HTTP or HMR socket is needed.
    const parentWithoutListener = { httpServer: undefined } as unknown as ViteDevServer;
    const server = await factory.createDocsDevServer({ root: path.join(fixture, 'docs'), parentServer: parentWithoutListener });
    await using _server = {
      async [Symbol.asyncDispose]() {
        await server.close();
      },
    };
    const renderer = await server.ssrLoadModule('/server.ts') as DocsRenderer;
    await expect(renderer.renderPage({ locale: 'en', page: 'tool-browser-shell' })).rejects.toThrow(/Docs en\/tool-browser-shell failed/);
    expect((await renderer.renderPage({ locale: 'en', page: 'index' })).body).toContain('<h1');

    await writeFile(pageFile, pageSource);
    server.watcher.emit('change', pageFile);
    await vi.waitFor(async () => {
      expect((await renderer.renderPage({ locale: 'en', page: 'tool-browser-shell' })).body).toContain('<h1');
    }, { timeout: 5000, interval: 100 });

    const japaneseFile = path.join(fixture, 'docs/pages/tool-browser-shell/strings/ja.ts');
    const japaneseSource = await readFile(japaneseFile, 'utf8');
    await writeFile(japaneseFile, 'export const strings = { broken: ; };');
    server.watcher.emit('change', japaneseFile);
    await vi.waitFor(async () => {
      await expect(renderer.renderPage({ locale: 'ja', page: 'tool-browser-shell' })).rejects.toThrow(/Docs ja\/tool-browser-shell failed/);
    }, { timeout: 5000, interval: 100 });
    expect((await renderer.renderPage({ locale: 'en', page: 'tool-browser-shell' })).body).toContain('<h1');

    await writeFile(japaneseFile, japaneseSource);
    server.watcher.emit('change', japaneseFile);
    await vi.waitFor(async () => {
      expect((await renderer.renderPage({ locale: 'ja', page: 'tool-browser-shell' })).body).toContain('<h1');
    }, { timeout: 5000, interval: 100 });
  });
});
