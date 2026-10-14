import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, mergeConfig } from 'vite';
import type { Plugin, UserConfig } from 'vite';
import { DOCS_BASE, DOCS_PAGES, DOCS_LOCALES, docsHref } from '../navigation/routes';
import { docsCompilerConfig } from './compiler';
import { findIslands, hasAppEntryLinks, hasHomeBrand, renderProductionDocument, renderProductionLocaleRoot, renderNotFound } from './html';
import { APP_ENTRY_CLIENT, HOME_BRAND_CLIENT, ISLAND_ENTRIES, styleEntryId, styleEntryName } from './ids';
import { manifestEntry, parseManifest, publicAssetHref } from './assets';
import type { DocsRenderer, RenderedPage } from './contracts';
import type { DocsLocale } from '../navigation/routes';
import { compileLocaleBootstrap } from './locale-bootstrap';
import { createDocsSitemap } from './seo';
import { createSearchIndex } from './search';

export function docsBuildConfig({ root }: { root: string }): UserConfig {
  const inputs: Record<string, string> = {};
  for (const page of DOCS_PAGES) inputs[styleEntryName({ page: page.id })] = styleEntryId({ page: page.id });
  for (const [name, entry] of Object.entries(ISLAND_ENTRIES)) inputs[`island-${name}`] = entry;
  inputs['app-entry'] = path.resolve(root, APP_ENTRY_CLIENT);
  inputs['home-brand'] = path.resolve(root, HOME_BRAND_CLIENT);
  return mergeConfig(docsCompilerConfig({ root }), {
    plugins: [createDocsOutputPlugin({ root })],
    build: {
      outDir: path.resolve(root, 'dist'),
      emptyOutDir: true,
      manifest: true,
      rollupOptions: { input: inputs, preserveEntrySignatures: 'exports-only' },
    },
  } satisfies UserConfig);
}

function createDocsOutputPlugin({ root }: { root: string }): Plugin {
  return {
    name: 'naidan-docs-output',
    apply: 'build',
    async buildStart() {
      this.emitFile({ type: 'asset', fileName: undefined, name: 'locale.js', source: await compileLocaleBootstrap({ root }) });
      this.emitFile({ type: 'asset', name: 'favicon.svg', source: await readFile(path.resolve(root, 'assets/favicon.svg')) });
    },
    // writeBundle runs only after a successful client build, including manifest.
    async writeBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        if (fileName.startsWith('assets/') && !/-[A-Za-z0-9_-]{8}\.[^/]+$/u.test(fileName)) {
          throw new Error(`Docs asset cannot use immutable caching without a content hash: ${fileName}`);
        }
      }
      const output = path.resolve(root, 'dist');
      const cache = path.resolve(root, '.cache');
      await mkdir(cache, { recursive: true });
      const temporary = await mkdtemp(path.join(cache, 'render-'));
      try {
        const manifest = parseManifest({ text: await readFile(path.join(output, '.vite/manifest.json'), 'utf8') });
        await build(mergeConfig(docsCompilerConfig({ root }), {
          configFile: false,
          logLevel: 'error',
          build: {
            ssr: path.resolve(root, 'server.ts'),
            outDir: temporary,
            emptyOutDir: true,
            copyPublicDir: false,
            minify: false,
            rollupOptions: { output: { entryFileNames: 'renderer.js' } },
          },
        }));
        // A unique output directory prevents stale ESM instances on repeated builds.
        const renderer = await import(pathToFileURL(path.join(temporary, 'renderer.js')).href) as DocsRenderer;
        if (typeof renderer.renderPage !== 'function') throw new Error('Invalid Docs renderer module');
        const files = new Map<string, string>();
        const entryAsset = Object.values(bundle).find(item => item.type === 'asset' && item.names.includes('locale.js'));
        if (!entryAsset) throw new Error('Missing Docs locale bootstrap');
        const bootstrap = `${DOCS_BASE}${entryAsset.fileName}`;
        const faviconAsset = Object.values(bundle).find(item => item.type === 'asset' && item.names.includes('favicon.svg'));
        if (!faviconAsset) throw new Error('Missing Docs favicon');
        const favicon = publicAssetHref({ file: faviconAsset.fileName });
        const homeAssets = manifestEntry({ manifest, name: styleEntryName({ page: 'index' }) });
        const searchAssets = manifestEntry({ manifest, name: 'island-search' });
        if (!searchAssets.script) throw new Error('Missing Docs search client entry');
        const appEntryAssets = manifestEntry({ manifest, name: 'app-entry' });
        if (!appEntryAssets.script) throw new Error('Missing Docs app entry client');
        const homeBrandAssets = manifestEntry({ manifest, name: 'home-brand' });
        if (!homeBrandAssets.script) throw new Error('Missing Docs home brand client');
        const renderedPages = new Map<string, RenderedPage>();
        files.set('404.html', renderNotFound({ assets: { styles: homeAssets.styles, scripts: [], favicon }, bootstrap }));
        for (const locale of DOCS_LOCALES) {
          for (const page of DOCS_PAGES) {
            const rendered = await renderer.renderPage({ locale, page: page.id });
            renderedPages.set(docsHref({ locale, page: page.id }), rendered);
            const assets = manifestEntry({ manifest, name: styleEntryName({ page: page.id }) });
            const scripts: string[] = [];
            for (const island of findIslands({ body: rendered.body })) {
              const entry = manifestEntry({ manifest, name: `island-${island}` });
              if (!entry.script) throw new Error(`Missing client entry for ${island}`);
              scripts.push(entry.script);
              assets.styles.push(...entry.styles);
            }
            if (hasAppEntryLinks({ body: rendered.body })) {
              scripts.push(appEntryAssets.script);
              assets.styles.push(...appEntryAssets.styles);
            }
            if (hasHomeBrand({ body: rendered.body })) {
              scripts.push(homeBrandAssets.script);
              assets.styles.push(...homeBrandAssets.styles);
            }
            if (!assets.styles.length) throw new Error(`Missing styles for ${page.id}`);
            const relative = `${docsHref({ locale, page: page.id }).slice(DOCS_BASE.length)}index.html`;
            files.set(relative, renderProductionDocument({ page: rendered, assets: { styles: assets.styles, scripts, favicon }, bootstrap }));
          }
        }
        const home = ({ locale }: { locale: DocsLocale }): RenderedPage => {
          const result = renderedPages.get(docsHref({ locale, page: 'index' }));
          if (!result) throw new Error(`Missing home for ${locale}`);
          return result;
        };
        const homes = { en: home({ locale: 'en' }), ja: home({ locale: 'ja' }) } satisfies Record<DocsLocale, RenderedPage>;
        files.set('index.html', renderProductionLocaleRoot({ pages: homes, bootstrap, assets: { styles: [...homeAssets.styles, ...searchAssets.styles, ...homeBrandAssets.styles, ...appEntryAssets.styles], scripts: [searchAssets.script, homeBrandAssets.script, appEntryAssets.script], favicon } }));
        files.set('sitemap.xml', createDocsSitemap());
        for (const locale of DOCS_LOCALES) {
          files.set(`search-${locale}.json`, JSON.stringify(createSearchIndex({ locale, pages: renderedPages })));
        }
        // Render/validate every page before publishing any HTML.
        for (const [file, html] of files) {
          const target = path.resolve(output, file);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, html);
        }
        // Manifests are build metadata, not runtime translation or SSR bundles.
        await rm(path.join(output, '.vite'), { recursive: true, force: true });
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  };
}
