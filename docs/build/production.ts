import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, mergeConfig } from 'vite';
import type { Plugin, UserConfig } from 'vite';
import { DOCS_BASE, DOCS_PAGES, DOCS_LOCALES, docsHref } from '../site/routes';
import { docsCompilerConfig } from './compiler';
import { findIslands, renderDocument, renderLocaleRoot, renderNotFound } from './html';
import { ISLAND_ENTRIES, LOCALE_ENTRY, styleEntryId, styleEntryName } from './ids';
import { manifestEntry, parseManifest } from './assets';
import type { DocsRenderer } from './contracts';

export function docsBuildConfig({ root }: { root: string }): UserConfig {
  const inputs: Record<string, string> = { locale: path.resolve(root, LOCALE_ENTRY) };
  for (const page of DOCS_PAGES) inputs[styleEntryName({ page: page.id })] = styleEntryId({ page: page.id });
  for (const [name, file] of Object.entries(ISLAND_ENTRIES)) inputs[`island-${name}`] = path.resolve(root, file);
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
    // writeBundle runs only after a successful client build, including manifest.
    async writeBundle() {
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
        const localeAssets = manifestEntry({ manifest, name: 'locale' });
        if (!localeAssets.script) throw new Error('Missing locale entry script');
        files.set('index.html', renderLocaleRoot({ assets: { styles: localeAssets.styles, scripts: [localeAssets.script] } }));
        // Nested 404 leaves the application's root SPA routing unchanged.
        files.set('404.html', renderNotFound({ assets: { styles: localeAssets.styles, scripts: [] } }));
        for (const locale of DOCS_LOCALES) {
          for (const page of DOCS_PAGES) {
            const rendered = await renderer.renderPage({ locale, page: page.id });
            const assets = manifestEntry({ manifest, name: styleEntryName({ page: page.id }) });
            const scripts: string[] = [];
            for (const island of findIslands({ body: rendered.body })) {
              const entry = manifestEntry({ manifest, name: `island-${island}` });
              if (!entry.script) throw new Error(`Missing client entry for ${island}`);
              scripts.push(entry.script);
              assets.styles.push(...entry.styles);
            }
            if (!assets.styles.length) throw new Error(`Missing styles for ${page.id}`);
            const relative = `${docsHref({ locale, page: page.id }).slice(DOCS_BASE.length)}index.html`;
            files.set(relative, renderDocument({ page: rendered, assets: { styles: assets.styles, scripts } }));
          }
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
