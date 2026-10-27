import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import type { DocsRenderer } from '../build/contracts';
import { createDocsDevBridge } from '../../build/docs-dev-bridge';
import { createSiteFixture, parsePage, startSiteDev } from './site.test-support';

type BridgeMiddleware = (request: { url: string; method: string }, response: { statusCode: number; end: (body?: string) => void }, next: (error?: unknown) => void) => Promise<void>;

it('reuses the cached factory and replaces the Docs child after the parent invalidates it', async () => {
  const events: string[] = [];
  let middleware: BridgeMiddleware | undefined;
  let generation = 0;
  const createFactory = () => ({
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
  });
  let factory = createFactory();
  const parent = {
    config: { root: '/tmp/docs-bridge-probe', logger: { error: vi.fn() } },
    middlewares: {
      use: (handler: BridgeMiddleware) => {
        middleware = handler;
      },
    },
    ssrLoadModule: vi.fn(async () => factory),
  } as unknown as ViteDevServer;
  const bridge = createDocsDevBridge();
  const configure = bridge.configureServer as (server: ViteDevServer) => void;
  configure(parent);
  expect(parent.ssrLoadModule).not.toHaveBeenCalled();
  const request = async (): Promise<string> => {
    if (!middleware) {
      throw new Error('Missing Docs bridge middleware');
    }
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
  expect(await request()).toBe('child 1');
  factory = createFactory();
  expect(await request()).toBe('child 2');
  expect(await request()).toBe('child 2');
  factory = createFactory();
  expect(await request()).toBe('child 3');
  expect(events).toEqual(['create 1', 'close 1', 'create 2', 'close 2', 'create 3']);
  expect(parent.ssrLoadModule).toHaveBeenCalledTimes(5);
  let releaseFactory: ((factory: ReturnType<typeof createFactory>) => void) | undefined;
  vi.mocked(parent.ssrLoadModule).mockReturnValueOnce(new Promise(resolve => {
    releaseFactory = resolve;
  }));
  factory = createFactory();
  const inFlight = request();
  const close = bridge.closeBundle as () => Promise<void>;
  await close();
  releaseFactory?.(factory);
  expect(await inFlight).toBe('');
  expect(events).toEqual(['create 1', 'close 1', 'create 2', 'close 2', 'create 3', 'close 3']);
});

describe('Docs development registry', () => {
  it('reloads the shared search contract after purpose guide edits without restarting the parent', async () => {
    await using fixture = await createSiteFixture();
    const purposeFile = path.join(fixture.docs, 'search/search-purpose.ts');
    const purposeSource = await readFile(purposeFile, 'utf8');
    const reorderedPurpose = purposeSource.replace("['standalone', 'endpoint-type-ollama'", "['endpoint-type-ollama', 'standalone'");
    expect(reorderedPurpose).not.toBe(purposeSource);
    await using dev = await startSiteDev({ root: fixture.root });
    const assertGuidePurpose = async ({ locale, first, second }: { locale: 'en' | 'ja'; first: string; second: string }): Promise<void> => {
      const response = await dev.request({ url: `/docs/${locale}/file-access/` });
      expect(response.status).toBe(200);
      using page = parsePage({ html: await response.text() });
      expect(Array.from(page.document.querySelectorAll('[data-testid="docs-search-results"] a'), link => link.getAttribute('href')).slice(0, 2)).toEqual([`/docs/${locale}/${first}/`, `/docs/${locale}/${second}/`]);
    };
    const assertHomePurpose = async ({ first, second }: { first: string; second: string }): Promise<void> => {
      const response = await dev.request({ url: '/docs/' });
      expect(response.status).toBe(200);
      using page = parsePage({ html: await response.text() });
      const templates = page.document.querySelectorAll<HTMLTemplateElement>('template[data-docs-locale]');
      expect(templates).toHaveLength(2);
      for (const template of templates) {
        const locale = template.getAttribute('data-docs-locale');
        expect(Array.from(template.content.querySelectorAll('[data-testid="docs-search-results"] a'), link => link.getAttribute('href')).slice(0, 2)).toEqual([`/docs/${locale}/${first}/`, `/docs/${locale}/${second}/`]);
      }
    };
    await assertGuidePurpose({ locale: 'en', first: 'standalone', second: 'endpoint-type-ollama' });
    await assertGuidePurpose({ locale: 'ja', first: 'standalone', second: 'endpoint-type-ollama' });
    await assertHomePurpose({ first: 'standalone', second: 'endpoint-type-ollama' });

    await writeFile(purposeFile, reorderedPurpose);
    await vi.waitFor(async () => {
      await assertGuidePurpose({ locale: 'en', first: 'endpoint-type-ollama', second: 'standalone' });
    }, { timeout: 10000, interval: 100 });
    await assertGuidePurpose({ locale: 'ja', first: 'endpoint-type-ollama', second: 'standalone' });
    await assertHomePurpose({ first: 'endpoint-type-ollama', second: 'standalone' });

    await writeFile(purposeFile, purposeSource);
    await vi.waitFor(async () => {
      await assertGuidePurpose({ locale: 'en', first: 'standalone', second: 'endpoint-type-ollama' });
    }, { timeout: 10000, interval: 100 });
    await assertGuidePurpose({ locale: 'ja', first: 'standalone', second: 'endpoint-type-ollama' });
    await assertHomePurpose({ first: 'standalone', second: 'endpoint-type-ollama' });
  });

  it('serves a styled 404 while the home page has a syntax error', async () => {
    await using fixture = await createSiteFixture();
    const homeFile = path.join(fixture.docs, 'pages/index/index.vue');
    const homeSource = await readFile(homeFile, 'utf8');
    const brokenHome = homeSource.replace('<script setup lang="ts">', `\
<script setup lang="ts">
const broken = ; // </pre><img src=x onerror=alert(1)>`);
    expect(brokenHome).not.toBe(homeSource);
    await using dev = await startSiteDev({ root: fixture.root });
    expect((await dev.request({ url: '/docs/en/' })).status).toBe(200);

    await writeFile(homeFile, brokenHome);
    await vi.waitFor(async () => {
      expect((await dev.request({ url: '/docs/en/' })).status).toBe(500);
    }, { timeout: 5000, interval: 100 });
    const failed = await dev.request({ url: '/docs/en/' });
    expect(failed.headers.get('content-type')).toContain('text/html');
    const failedHtml = await failed.text();
    expect(failedHtml).toContain('&lt;/pre&gt;&lt;img src=x onerror=alert(1)&gt;');
    using failedPage = parsePage({ html: failedHtml });
    expect(failedPage.document.title).toBe('Docs development error');
    expect(failedPage.document.querySelector('pre')?.textContent).toContain('pages/index/index.vue');
    expect(failedPage.document.querySelector('pre')?.textContent).toContain('const broken = ;');
    expect(failedPage.document.querySelector('img')).toBeNull();
    expect([...failedPage.document.scripts].map(script => script.getAttribute('src'))).toEqual(['/docs/@vite/client']);
    const failedHead = await dev.request({ url: '/docs/en/', method: 'HEAD' });
    expect(failedHead.status).toBe(500);
    expect(await failedHead.text()).toBe('');
    const searchIndex = await dev.request({ url: '/docs/search-en.json' });
    expect(searchIndex.status).toBe(500);
    expect(searchIndex.headers.get('content-type')).toContain('text/plain');
    expect(await searchIndex.text()).toContain('Docs search-index failed');
    const missing = await dev.request({ url: '/docs/en/not-a-page/' });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('text/html');
    using page = parsePage({ html: await missing.text() });
    expect(page.document.title).toBe('404 | Naidan Docs');
    expect(page.document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
    const stylesheet = page.document.querySelector('link[rel="stylesheet"]')?.getAttribute('href');
    expect(stylesheet).toBe('/docs/styles/site.css?direct');
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

  it('shows static script misuse on the affected route and recovers after an edit', async () => {
    await using fixture = await createSiteFixture();
    const pageFile = path.join(fixture.docs, 'pages/tool-browser-shell/index.vue');
    const pageSource = await readFile(pageFile, 'utf8');
    const brokenPage = pageSource.replace('<script setup lang="ts">', `\
<script setup lang="ts">
import { onMounted } from 'vue';
onMounted(() => {});`);
    expect(brokenPage).not.toBe(pageSource);
    await writeFile(pageFile, brokenPage);
    await using dev = await startSiteDev({ root: fixture.root });

    const failed = await dev.request({ url: '/docs/en/tool-browser-shell/' });
    expect(failed.status).toBe(500);
    expect(failed.headers.get('content-type')).toContain('text/html');
    using failedPage = parsePage({ html: await failed.text() });
    const details = failedPage.document.querySelector('pre')?.textContent ?? '';
    expect(details).toMatch(/pages\/tool-browser-shell\/index\.vue:\d+:\d+/);
    expect(details).toContain('onMounted');
    expect(details).toMatch(/island/i);
    expect((await dev.request({ url: '/docs/en/chat-branching/' })).status).toBe(200);
    const app = await dev.request({ url: '/' });
    expect(app.status).toBe(200);
    expect(await app.text()).toContain('APP-ONLY');

    await writeFile(pageFile, pageSource);
    await vi.waitFor(async () => {
      expect((await dev.request({ url: '/docs/en/tool-browser-shell/' })).status).toBe(200);
    }, { timeout: 5000, interval: 100 });
  });

  it('isolates a broken page and language, then recovers in the same SSR server', async () => {
    await using fixture = await createSiteFixture();

    const pageFile = path.join(fixture.docs, 'pages/tool-browser-shell/index.vue');
    const pageSource = await readFile(pageFile, 'utf8');
    const brokenPage = pageSource.replace('<script setup lang="ts">', `\
<script setup lang="ts">
const broken = ;`);
    expect(brokenPage).not.toBe(pageSource);
    await writeFile(pageFile, brokenPage);

    const parent = await createServer({ configFile: path.join(fixture.docs, 'vite.config.ts'), server: { middlewareMode: true, hmr: false, ws: false }, logLevel: 'silent' });
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
    const server = await factory.createDocsDevServer({ root: fixture.docs, parentServer: parentWithoutListener });
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

    const japaneseFile = path.join(fixture.docs, 'pages/tool-browser-shell/messages/ja.tsx');
    const japaneseSource = await readFile(japaneseFile, 'utf8');
    await writeFile(japaneseFile, 'export const messages = { broken: ; };');
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
