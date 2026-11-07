// @vitest-environment node
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import { build, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createModelPageFixture } from './model-page.test-support';
import { createDocumentMetadataHtmlPlugin } from './document-metadata-html';
import { createInitialThemeHtmlPlugin } from './initial-theme-html';
import { renderModelPageHtml, renderPublicAppHtml } from './model-page-html';
import { createModelPagesPlugin } from './model-pages';
import { createHostedPackagePlugin } from './hosted-package';
import { createZipPackages } from './zip-packages';
import { createPWABuild } from './pwa';
import { createWorkerHarness, MemoryCacheStorage, TestClients } from './test-support/pwa-worker-platform.test-support';
import { createSiteSitemap } from './site-sitemap';
import { listModelPageEntries } from '../src/features/llama-cpp-browser/model-launch/page-entries';
import { hfRepositories, type ModelPageId } from '../src/features/llama-cpp-browser/hugging-face/model-repositories';
import { appDestinationPath } from '../docs/navigation/app-entry';
import { createStandaloneFacadeAliases } from './standalone-facades';
import { modelPageHref, modelPageLocation } from '../src/features/llama-cpp-browser/model-launch/page-url';

const repository = fileURLToPath(new URL('..', import.meta.url));

async function filesBelow({ directory }: { directory: string }): Promise<string[]> {
  return (await readdir(directory, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => path.relative(directory, path.join(entry.parentPath, entry.name))).sort();
}

async function buildHostedFixture({ root, plugins = [] }: { root: string, plugins?: readonly Plugin[] }) {
  return await build({
    configFile: false,
    root,
    mode: 'hosted',
    base: './',
    publicDir: false,
    logLevel: 'silent',
    css: { postcss: { plugins: [] } },
    plugins: [createDocumentMetadataHtmlPlugin(), createInitialThemeHtmlPlugin(), createModelPagesPlugin(), ...plugins],
    build: { outDir: 'dist/hosted', emptyOutDir: true },
  });
}

describe('model pages in the Hosted Vite output', () => {
  it('uses the final Vite HTML and shared hashed assets, emits one sitemap, and removes stale pages on rebuild', async () => {
    await using fixture = await createModelPageFixture();
    await buildHostedFixture({
      root: fixture.root,
      plugins: [{
        name: 'fixture-late-html',
        enforce: 'post',
        transformIndexHtml: { order: 'post', handler: () => [{ tag: 'meta', attrs: { name: 'fixture-late-transform', content: 'included' }, injectTo: 'head' }] },
      }],
    });
    const directory = path.join(fixture.root, 'dist/hosted');
    const outputFiles = await filesBelow({ directory });
    const entries = listModelPageEntries();
    expect(outputFiles.filter(file => file.endsWith('.html'))).toHaveLength(entries.length + 1);
    expect(outputFiles.filter(file => file === 'sitemap.xml')).toHaveLength(1);
    expect(outputFiles.some(file => /[":<>|*?\r\n]/.test(file))).toBe(false);
    expect(outputFiles).not.toContain('404.html');
    expect(existsSync(path.join(fixture.root, 'dist/model-page-publication'))).toBe(false);
    const shell = await readFile(path.join(directory, 'index.html'), 'utf8');
    const app = new JSDOM(shell, { url: 'https://naidan.pages.dev/' });
    using _app = { [Symbol.dispose]: () => app.window.close() };
    const appScripts = [...app.window.document.querySelectorAll<HTMLScriptElement>('script[src]')].map(script => script.src);
    expect(appScripts).toHaveLength(1);
    expect(appScripts[0]).toMatch(/\/assets\/[^/]+\.js$/);
    for (const entry of entries) {
      const html = await readFile(path.join(directory, entry.pathname, 'index.html'), 'utf8');
      const dom = new JSDOM(html, { url: `https://naidan.pages.dev${entry.pathname}` });
      using _dom = { [Symbol.dispose]: () => dom.window.close() };
      const document = dom.window.document;
      expect(document.title).toBe(entry.metadata.title);
      expect(document.querySelectorAll('title')).toHaveLength(1);
      expect(document.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
      expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(entry.canonicalUrl);
      expect(document.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(entry.canonicalUrl);
      for (const selector of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) {
        expect(document.querySelector(selector)?.getAttribute('content')).toBe(entry.metadata.description);
      }
      expect(document.baseURI).toBe('https://naidan.pages.dev/');
      expect([...document.querySelectorAll<HTMLScriptElement>('script[src]')].map(script => script.src)).toEqual(appScripts);
      expect(document.querySelector('meta[name="fixture-late-transform"]')?.getAttribute('content')).toBe('included');
      expect(html).toContain('--naidan-page-background');
      expect(document.querySelector('#app')?.textContent).toContain(entry.repository);
      expect(document.querySelector('#app')?.textContent).not.toContain('Quantization:');
      expect(document.querySelector('#app > [data-model-page-fallback]')).not.toBeNull();
      const style = document.querySelector('style[data-model-page-fallback-style]')?.textContent;
      expect(style).toContain('@media (scripting: enabled)');
      expect(style).toContain('visibility: hidden');
      expect(style).toContain('0s 8s forwards');
      expect(style).toContain('to { visibility: visible; }');
      expect(document.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
      expect(document.querySelector('meta[name="robots"]')).toBeNull();
      expect(document.querySelector('#app button, #app aside')).toBeNull();
    }
    expect(await readFile(path.join(directory, 'sitemap.xml'), 'utf8')).toBe(createSiteSitemap({ entries }));
    const obsolete = path.join(directory, 'llama-cpp-browser/hf.co/removed/Repo');
    await mkdir(obsolete, { recursive: true });
    await writeFile(path.join(obsolete, 'index.html'), 'stale');
    await buildHostedFixture({ root: fixture.root });
    expect(await filesBelow({ directory })).toEqual(outputFiles);
  });

  it('builds the real worker and packages final HTML/manifest/worker bytes without another command', async () => {
    await using fixture = await createModelPageFixture();
    await mkdir(path.join(fixture.root, 'public'));
    for (const file of ['favicon.svg', 'naidan-standalone.zip', 'naidan-standalone-en.zip']) {
      await writeFile(path.join(fixture.root, 'public', file), file === 'favicon.svg' ? '<svg xmlns="http://www.w3.org/2000/svg"/>' : 'fixture download');
    }
    const pwa = createPWABuild({ buildId: 'model-pages-build' });
    const events: string[] = [];
    await build({
      configFile: false,
      root: fixture.root,
      mode: 'hosted',
      base: './',
      logLevel: 'silent',
      define: pwa.define,
      css: { postcss: { plugins: [] } },
      build: { outDir: 'dist/hosted', emptyOutDir: true },
      plugins: [
        createDocumentMetadataHtmlPlugin(), createModelPagesPlugin(),
        // An asynchronous earlier close hook must finish before ZIP creation.
        {
          name: 'fixture-output-completion',
          async closeBundle() {
            await writeFile(path.join(fixture.root, 'dist/hosted/late-output.txt'), 'complete');
            events.push('output');
          },
        },
        VitePWA({ ...pwa.options, srcDir: path.join(repository, 'pwa') }),
        createHostedPackagePlugin({ version: 'fixture', locales: ['en'] }),
      ],
    });
    expect(events).toEqual(['output']);
    const directory = path.join(fixture.root, 'dist/hosted');
    const files = await filesBelow({ directory });
    const zip = await JSZip.loadAsync(await readFile(path.join(fixture.root, 'dist/naidan-hosted.zip')));
    for (const file of files.filter(file => file !== 'naidan-standalone-en.zip')) {
      expect(await zip.file(`naidan-hosted-fixture/${file}`)?.async('nodebuffer'), file).toEqual(await readFile(path.join(directory, file)));
    }
    expect(await zip.file('naidan-hosted-fixture/naidan-standalone.zip')?.async('string')).toBe('fixture download');
    expect(zip.file('naidan-hosted-fixture/naidan-standalone-en.zip')).toBeNull();
    expect(await zip.file('naidan-hosted-fixture/VERSION.txt')?.async('string')).toBe('fixture');
    const worker = await readFile(path.join(directory, 'sw.js'), 'utf8');
    for (const entry of listModelPageEntries()) {
      // Preserve the existing automatic all-assets precache policy.
      expect(worker).toContain(`${entry.pathname.slice(1)}index.html`);
      const html = await readFile(path.join(directory, entry.pathname, 'index.html'), 'utf8');
      expect(html).toContain('manifest.webmanifest');
    }
    expect(worker).toContain('late-output.txt');
    expect(files).toContain('manifest.webmanifest');
    expect(files).toContain('sw.js');
    // Install from ONLY the ZIP contents, not the larger Cloudflare tree. A
    // precached download absent from the archive would break self-hosted PWA.
    const scope = 'https://example.test/installed/';
    const requested: string[] = [];
    const harness = createWorkerHarness({
      script: worker,
      scope,
      cacheStorage: new MemoryCacheStorage(),
      clients: new TestClients(),
      fetch: async input => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const file = url.pathname.slice(new URL(scope).pathname.length);
        requested.push(file);
        const bytes = await zip.file(`naidan-hosted-fixture/${file}`)?.async('uint8array');
        return new Response(bytes === undefined ? 'missing' : new Uint8Array(bytes), { status: bytes === undefined ? 404 : 200 });
      },
    });
    await harness.lifecycle('install');
    await harness.lifecycle('activate');
    expect(requested).toContain('naidan-standalone.zip');
  });

  it('does not publish a ZIP after a failing output hook', async () => {
    await using fixture = await createModelPageFixture();
    await expect(buildHostedFixture({
      root: fixture.root,
      plugins: [
        {
          name: 'fixture-failure',
          generateBundle() {
            throw new Error('fixture output failure');
          },
        },
        createHostedPackagePlugin({ version: 'fixture', locales: [] }),
      ],
    })).rejects.toThrow('fixture output failure');
    expect(existsSync(path.join(fixture.root, 'dist/naidan-hosted.zip'))).toBe(false);
  });

  it('preserves an earlier ZIP when a later worker/output close hook fails', async () => {
    await using fixture = await createModelPageFixture();
    const archive = path.join(fixture.root, 'dist/naidan-hosted.zip');
    await mkdir(path.dirname(archive), { recursive: true });
    await writeFile(archive, 'previous release');
    await expect(buildHostedFixture({
      root: fixture.root,
      plugins: [
        {
          name: 'fixture-worker-failure',
          closeBundle: {
            sequential: true,
            async handler() {
              await Promise.resolve();
              throw new Error('fixture worker failure');
            },
          },
        },
        createHostedPackagePlugin({ version: 'fixture', locales: [] }),
      ],
    })).rejects.toThrow('fixture worker failure');
    expect(await readFile(archive, 'utf8')).toBe('previous release');
  });

  it('works with an in-memory Vite build without reading or writing an output directory', async () => {
    await using fixture = await createModelPageFixture();
    const result = await build({
      configFile: false,
      root: fixture.root,
      mode: 'hosted',
      base: './',
      publicDir: false,
      logLevel: 'silent',
      css: { postcss: { plugins: [] } },
      plugins: [createDocumentMetadataHtmlPlugin(), createModelPagesPlugin(), createHostedPackagePlugin({ version: 'fixture', locales: [] })],
      build: { write: false },
    });
    expect('output' in result).toBe(true);
    if ('output' in result) {
      expect(result.output.filter(file => file.fileName.endsWith('.html'))).toHaveLength(listModelPageEntries().length + 1);
    }
    expect(existsSync(path.join(fixture.root, 'dist'))).toBe(false);
  });

  it.each(['missing-app', 'conflict', 'root-404'] as const)('fails rather than producing a partial publication: %s', async failure => {
    await using fixture = await createModelPageFixture();
    const plugins: Plugin[] = [];
    switch (failure) {
    case 'missing-app':
      await writeFile(path.join(fixture.root, 'index.html'), '<!doctype html><p>broken template</p>');
      break;
    case 'conflict':
      plugins.push({
        name: 'fixture-conflict',
        generateBundle() {
          this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: 'conflict' });
        },
      });
      break;
    case 'root-404':
      plugins.push({
        name: 'fixture-404',
        generateBundle() {
          this.emitFile({ type: 'asset', fileName: '404.html', source: 'not found' });
        },
      });
      break;
    default: {
      const exhaustive: never = failure;
      throw new Error(exhaustive);
    }
    }
    await expect(buildHostedFixture({ root: fixture.root, plugins })).rejects.toThrow();
  });

  it('keeps every typed Docs model destination identical to its published path', () => {
    for (const repository of hfRepositories) {
      const model: ModelPageId = `hf.co/${repository.hfRepository}`;
      const entry = listModelPageEntries().find(entry => entry.modelId === model);
      expect(appDestinationPath({ destination: { kind: 'model-page', model, quant: undefined } })).toBe(entry?.pathname.slice(0, -1));
      for (const quant of ['Q4_K_M', 'Q8_0']) {
        expect(appDestinationPath({ destination: { kind: 'model-page', model, quant } })).toBe(modelPageHref({ modelId: model, quantization: quant }));
      }
    }
  });

  it('uses the existing build commands and deploys the same hosted tree in all Cloudflare jobs', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['build:model-pages']).toBeUndefined();
    expect(packageJson.scripts['build:all']).toBe('npm run build:standalone && npm run build:hosted');
    expect(packageJson.scripts['build:hosted']).toBe('vite build --mode hosted --logLevel warn');
    expect(existsSync(path.join(repository, 'scripts/build-model-pages.ts'))).toBe(false);
    const workflow = readFileSync(new URL('../.github/workflows/main.yml', import.meta.url), 'utf8');
    const parsed = parse(workflow) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
    expect(parsed.jobs.build?.steps.some(step => step.run?.includes('node:22-bookworm npm run build:all'))).toBe(true);
    expect(workflow).not.toContain('build:model-pages');
    expect(workflow).not.toContain('model-page-publication');
    for (const name of ['publish_to_cloudflare', 'publish_to_cloudflare_local_only', 'publish_to_cloudflare_curated']) {
      expect(parsed.jobs[name]?.steps.some(step => step.run?.includes('test -d dist/hosted/llama-cpp-browser'))).toBe(true);
      expect(parsed.jobs[name]?.steps.some(step => step.run?.includes('test ! -e dist/hosted/404.html'))).toBe(true);
      expect(parsed.jobs[name]?.steps.some(step => step.run?.includes('test ! -e dist/hosted/docs'))).toBe(true);
    }
    const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
    expect(config).toContain('createModelPagesPlugin(),');
    expect(config).toContain('createHostedPackagePlugin({ version: pkg.version, locales: UI_LOCALES })');
  });

  it('excludes model pages, Hosted bootstrap and path history from a real standalone-facade build', async () => {
    await using fixture = await createModelPageFixture();
    await writeFile(path.join(fixture.root, 'entry.ts'), 'import { createAppHistory } from "@/logic/startup/app-history"; globalThis.testHistory = createAppHistory;');
    await build({
      configFile: false,
      root: fixture.root,
      mode: 'standalone',
      publicDir: false,
      logLevel: 'silent',
      resolve: { alias: createStandaloneFacadeAliases({ resolvePath: relative => path.resolve(repository, relative) }) },
      plugins: [createDocumentMetadataHtmlPlugin(), createModelPagesPlugin(), createHostedPackagePlugin({ version: 'fixture', locales: [] })],
      css: { postcss: { plugins: [] } },
    });
    const files = await filesBelow({ directory: path.join(fixture.root, 'dist') });
    expect(files).not.toContain('sitemap.xml');
    expect(files.filter(file => file.endsWith('.html'))).toEqual(['index.html']);
    expect(files.some(file => file.endsWith('.zip'))).toBe(false);
    expect(await readFile(path.join(fixture.root, 'dist/index.html'), 'utf8')).not.toContain('data-naidan-hosted-base');
    await writeFile(path.join(fixture.root, 'dist/favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await createZipPackages({
      sourceDirectory: path.join(fixture.root, 'dist'),
      archiveDirectory: path.join(fixture.root, 'archives'),
      version: 'fixture',
      packages: [{ zipFileName: 'standalone.zip', folderName: 'standalone', layout: 'standalone' }],
    });
    const standalone = await JSZip.loadAsync(await readFile(path.join(fixture.root, 'archives/standalone.zip')));
    expect(Object.keys(standalone.files).some(file => file.includes('/llama-cpp-browser/'))).toBe(false);
    expect(standalone.file('standalone/sitemap.xml')).toBeNull();
    for (const file of files.filter(file => file.endsWith('.js'))) {
      const source = await readFile(path.join(fixture.root, 'dist', file), 'utf8');
      expect(source).not.toContain('llama-cpp-browser/');
      expect(source).not.toContain('Local LLM');
      expect(source).not.toContain('LiquidAI');
    }
  });
});

const template = '<!doctype html><head><meta charset="UTF-8"><base href="/wrong/"><link rel="stylesheet" href="./assets/style.css"></head><body><div id="app"></div><script type="module" src="./assets/app.js"></script></body>';

describe('portable hosted document base', () => {
  it.each([
    ['/', '/'], ['/index.html#/', '/'], ['/nested/app/', '/nested/app/'], ['/nested/app/index.html#/', '/nested/app/'],
    ['/hoge/foo', '/'],
    ['/llama-cpp-browser/hf.co/owner/Unknown?quant=Q8_0', '/'],
    ['/nested/app/llama-cpp-browser/hf.co/owner/Unknown?quant=Q8_0', '/nested/app/'],
    ['/nested/app/llama-cpp-browser/hf.co/owner/Unknown/?quant=Q8_0', '/nested/app/'],
    ['/nested/app/llama-cpp-browser', '/nested/app/'],
    ['/space%20mount/llama-cpp-browser/hf.co/owner/Repo', '/space%20mount/'],
  ])('resolves %s before app scripts without changing the address', (pathname, appBase) => {
    const html = renderPublicAppHtml({ html: template });
    const url = `https://example.test${pathname}`;
    const dom = new JSDOM(html, { url, runScripts: 'dangerously' });
    using _dom = { [Symbol.dispose]: () => dom.window.close() };
    const document = dom.window.document;
    expect(document.baseURI).toBe(`https://example.test${appBase}`);
    expect(document.querySelector<HTMLScriptElement>('script[src]')?.src).toBe(`https://example.test${appBase}assets/app.js`);
    expect(document.querySelector<HTMLLinkElement>('link[rel=stylesheet]')?.href).toBe(`https://example.test${appBase}assets/style.css`);
    expect(dom.window.location.href).toBe(url);
    const location = modelPageLocation({ pathname: dom.window.location.pathname });
    if (location !== undefined) {
      expect(location.appBase).toBe(appBase);
    }
    expect(html.indexOf('data-naidan-hosted-base')).toBeLessThan(html.indexOf('assets/style.css'));
    expect(document.querySelectorAll('base')).toHaveLength(1);
  });

  it('retains a useful no-script base and home link for directory model pages under a mount', () => {
    const entry = listModelPageEntries()[0]!;
    const html = renderModelPageHtml({ html: template, entry });
    const dom = new JSDOM(html, { url: `https://example.test/sub/app${entry.pathname}` });
    using _dom = { [Symbol.dispose]: () => dom.window.close() };
    expect(dom.window.document.baseURI).toBe('https://example.test/sub/app/');
    expect(dom.window.document.querySelector<HTMLAnchorElement>('#app a')?.href).toBe('https://example.test/sub/app/#/');
    expect(dom.window.document.querySelector('link[rel=canonical]')?.getAttribute('href')).toBe(entry.canonicalUrl);
  });

  it('escapes metadata and has exactly one controlled bootstrap after repeated decoration', () => {
    const text = '"><script>not executable</script>&';
    const original = listModelPageEntries()[0]!;
    const entry = { ...original, metadata: { title: text, description: text }, repository: text };
    const html = renderModelPageHtml({ html: renderPublicAppHtml({ html: template }), entry });
    const dom = new JSDOM(html);
    using _dom = { [Symbol.dispose]: () => dom.window.close() };
    expect(dom.window.document.title).toBe(text);
    expect(dom.window.document.querySelectorAll('script[data-naidan-hosted-base]')).toHaveLength(1);
    expect(dom.window.document.querySelectorAll('script:not([data-naidan-hosted-base]):not([src])')).toHaveLength(0);
    expect(dom.window.document.querySelectorAll('base')).toHaveLength(1);
    expect(() => renderModelPageHtml({ html: '<!doctype html><p>broken</p>', entry })).toThrow('missing #app');
  });
});
