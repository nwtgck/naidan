// @vitest-environment node
// !!! ALLOW-EXTERNAL-COMMAND node --import tsx:* !!! -- Verify the actual publication CLI in an isolated fixture.
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createModelPageFixture } from './model-page.test-support';
import { runCommandSync } from './command';
import { createDocumentMetadataHtmlPlugin } from './document-metadata-html';
import { renderModelPageHtml, renderPublicAppHtml } from './model-page-html';
import { buildModelPagePublication } from './model-page-publication';
import { createSiteSitemap, createSiteSitemapPlugin } from './site-sitemap';
import { listModelPageEntries } from '../src/features/llama-cpp-browser/model-launch/page-entries';
import { hfRepositories, type ModelPageId } from '../src/features/llama-cpp-browser/hugging-face/model-repositories';
import { appDestinationPath } from '../docs/navigation/app-entry';
import { createStandaloneFacadeAliases } from './standalone-facades';
import { modelPageHref } from '../src/features/llama-cpp-browser/model-launch/page-url';

async function filesBelow({ directory }: { directory: string }): Promise<string[]> {
  return (await readdir(directory, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => path.relative(directory, path.join(entry.parentPath, entry.name))).sort();
}

describe('published model HTML', () => {
  it('decorates the actual Vite result while leaving portable outputs unchanged', async () => {
    await using fixture = await createModelPageFixture();
    await build({ configFile: false, root: fixture.root, base: './', publicDir: false, logLevel: 'silent', css: { postcss: { plugins: [] } }, plugins: [createDocumentMetadataHtmlPlugin(), createSiteSitemapPlugin()] });
    const hostedDirectory = path.join(fixture.root, 'dist');
    const outputDirectory = path.join(fixture.root, 'publication');
    const beforeFiles = await filesBelow({ directory: hostedDirectory });
    const template = await readFile(path.join(hostedDirectory, 'index.html'), 'utf8');
    await buildModelPagePublication({ hostedDirectory, outputDirectory });
    expect(await filesBelow({ directory: hostedDirectory })).toEqual(beforeFiles);
    expect(await readFile(path.join(hostedDirectory, 'index.html'), 'utf8')).toBe(template);
    expect(await readFile(path.join(hostedDirectory, 'sitemap.xml'), 'utf8')).toBe(createSiteSitemap({ entries: [] }));
    const entries = listModelPageEntries();
    const outputFiles = await filesBelow({ directory: outputDirectory });
    expect(outputFiles).toHaveLength(entries.length + 2);
    expect(outputFiles.some(file => /\.(?:js|css)$/.test(file))).toBe(false);
    const app = new JSDOM(template, { url: 'https://naidan.pages.dev/' });
    using _app = { [Symbol.dispose]: () => app.window.close() };
    const appScripts = [...app.window.document.querySelectorAll<HTMLScriptElement>('script[src]')].map(script => script.src);
    for (const entry of entries) {
      const html = await readFile(path.join(outputDirectory, entry.pathname, 'index.html'), 'utf8');
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
    expect(await readFile(path.join(outputDirectory, 'sitemap.xml'), 'utf8')).toBe(createSiteSitemap({ entries }));
    expect(outputFiles).not.toContain('404.html');
    expect(outputFiles.some(file => /[":<>|*?\r\n]/.test(file))).toBe(false);
    const publicShell = await readFile(path.join(outputDirectory, 'index.html'), 'utf8');
    expect(publicShell).toBe(renderPublicAppHtml({ html: template }));
    const fallback = new JSDOM(publicShell, { url: 'https://preview.example/hoge/foo' });
    using _fallback = { [Symbol.dispose]: () => fallback.window.close() };
    expect(fallback.window.document.baseURI).toBe('https://preview.example/');
    expect(fallback.window.document.querySelector('script[src]')?.getAttribute('src')).toBe(app.window.document.querySelector('script[src]')?.getAttribute('src'));
    expect(fallback.window.document.querySelector('meta[name=robots]')).toBeNull();
    expect(fallback.window.document.querySelector('script[src]')?.getAttribute('src')).not.toContain('llama-cpp-browser');
    // Rebuilding cannot retain removed/stale pages from an earlier publication.
    await writeFile(path.join(outputDirectory, 'obsolete.html'), 'stale');
    await buildModelPagePublication({ hostedDirectory, outputDirectory });
    expect(await filesBelow({ directory: outputDirectory })).toEqual(outputFiles);
  });

  it('runs the actual publication CLI without application aliases or inference artifacts', async () => {
    await using fixture = await createModelPageFixture();
    const hosted = path.join(fixture.root, 'dist/hosted');
    await mkdir(hosted, { recursive: true });
    await writeFile(path.join(hosted, 'index.html'), await readFile(path.join(fixture.root, 'index.html')));
    const result = runCommandSync({ argv: ['node', '--import', 'tsx', fileURLToPath(new URL('../scripts/build-model-pages.ts', import.meta.url))], options: { cwd: fixture.root, encoding: 'utf8', timeout: 30_000 } });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const sitemap = await readFile(path.join(fixture.root, 'dist/model-page-publication/sitemap.xml'), 'utf8');
    expect(sitemap).toBe(createSiteSitemap({ entries: listModelPageEntries() }));
  });

  it('escapes model text and rejects a broken app template', () => {
    const original = listModelPageEntries()[0]!;
    const text = '"><script>not executable</script>&';
    const entry = { ...original, metadata: { title: text, description: text }, repository: text };
    const html = renderModelPageHtml({ html: '<!doctype html><head><base href="/wrong/"></head><body><div id="app"></div></body>', entry });
    const dom = new JSDOM(html);
    using _dom = { [Symbol.dispose]: () => dom.window.close() };
    expect(dom.window.document.title).toBe(text);
    expect(dom.window.document.querySelector('script')).toBeNull();
    expect(dom.window.document.querySelectorAll('base')).toHaveLength(1);
    expect(() => renderModelPageHtml({ html: '<!doctype html><p>broken</p>', entry })).toThrow('missing #app');
  });

  it('rejects overlapping publication directories before changing any input', async () => {
    await using fixture = await createModelPageFixture();
    const source = await readFile(path.join(fixture.root, 'index.html'), 'utf8');
    for (const outputDirectory of [fixture.root, path.join(fixture.root, 'nested'), path.dirname(fixture.root)]) {
      await expect(buildModelPagePublication({ hostedDirectory: fixture.root, outputDirectory })).rejects.toThrow('overlap');
    }
    expect(await readFile(path.join(fixture.root, 'index.html'), 'utf8')).toBe(source);
    const stagedInput = path.join(fixture.root, 'overlay.staging', 'hosted');
    await mkdir(stagedInput, { recursive: true });
    await writeFile(path.join(stagedInput, 'index.html'), source);
    await expect(buildModelPagePublication({ hostedDirectory: stagedInput, outputDirectory: path.join(fixture.root, 'overlay') })).rejects.toThrow('overlap');
    expect(await readFile(path.join(stagedInput, 'index.html'), 'utf8')).toBe(source);
  });

  it('keeps every typed Docs model-page destination identical to its published path', () => {
    for (const repository of hfRepositories) {
      const model: ModelPageId = `hf.co/${repository.hfRepository}`;
      const entry = listModelPageEntries().find(entry => entry.modelId === model);
      expect(appDestinationPath({ destination: { kind: 'model-page', model, quant: undefined } })).toBe(entry?.pathname.slice(0, -1));
      for (const quant of ['Q4_K_M', 'Q8_0']) {
        expect(appDestinationPath({ destination: { kind: 'model-page', model, quant } })).toBe(modelPageHref({ modelId: model, quantization: quant }));
      }
    }
  });

  it('assembles the overlay in every Cloudflare job only after release packaging', () => {
    const workflow = readFileSync(new URL('../.github/workflows/main.yml', import.meta.url), 'utf8');
    const parsed = parse(workflow) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
    expect(parsed.jobs.build?.steps.some(step => step.run?.includes('npm run build:all && npm run build:model-pages'))).toBe(true);
    for (const name of ['publish_to_cloudflare', 'publish_to_cloudflare_local_only', 'publish_to_cloudflare_curated']) {
      expect(parsed.jobs[name]?.steps.some(step => step.run?.includes('cp -a dist/model-page-publication/. dist/hosted/'))).toBe(true);
      expect(parsed.jobs[name]?.steps.some(step => step.run?.includes('test ! -e dist/hosted/404.html'))).toBe(true);
    }
  });

  it('excludes hosted path-history code from a real standalone-facade bundle', async () => {
    await using fixture = await createModelPageFixture();
    const repository = new URL('..', import.meta.url).pathname;
    await writeFile(path.join(fixture.root, 'entry.ts'), 'import { createAppHistory } from "@/logic/startup/app-history"; globalThis.testHistory = createAppHistory;');
    await build({
      configFile: false,
      root: fixture.root,
      mode: 'standalone',
      publicDir: false,
      logLevel: 'silent',
      resolve: { alias: createStandaloneFacadeAliases({ resolvePath: relative => path.resolve(repository, relative) }) },
      plugins: [createDocumentMetadataHtmlPlugin(), createSiteSitemapPlugin()],
      css: { postcss: { plugins: [] } },
    });
    const files = await filesBelow({ directory: path.join(fixture.root, 'dist') });
    expect(files).not.toContain('sitemap.xml');
    for (const file of files.filter(file => file.endsWith('.js'))) {
      const source = await readFile(path.join(fixture.root, 'dist', file), 'utf8');
      expect(source).not.toContain('llama-cpp-browser/');
      expect(source).not.toContain('Local LLM');
      expect(source).not.toContain('LiquidAI');
    }
  });
});
