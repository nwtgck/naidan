import path from 'node:path';
import vm from 'node:vm';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build, parseSync, transformWithOxc, type PluginOption } from 'vite';
import MagicString from 'magic-string';
import { VitePWA } from 'vite-plugin-pwa';
import { createPWABuild } from '../pwa';
import { UI_LOCALES } from '../../src/01-models/ui-locale';

/** Static inputs for the Node-only generated-worker tests. The production
 * Workbox build receives these files; no browser, UI or app-module stubs are used.
 */
export async function buildPWAFixture({ root, buildId, publicFiles, entrySource, plugins = [], worker, getRuntimeArtifacts, getLocaleAssets, additionalManifestEntries }: {
  root: string,
  buildId: string,
  publicFiles?: ReadonlyMap<string, string>,
  entrySource?: string,
  plugins?: readonly PluginOption[],
  worker?: Parameters<ReturnType<typeof createPWABuild>['workerAssetsPlugin']>[0] & { plugins: () => PluginOption[] },
  getRuntimeArtifacts?: NonNullable<Parameters<typeof createPWABuild>[0]>['getRuntimeArtifacts'],
  getLocaleAssets?: NonNullable<Parameters<typeof createPWABuild>[0]>['getLocaleAssets'],
  additionalManifestEntries?: Array<{ url: string; revision: string }>,
}) {
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
  await mkdir(path.join(root, 'public'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), `<!doctype html><html><head><title>${buildId}</title></head><body><script type="module" src="/entry.js"></script></body></html>`);
  await writeFile(path.join(root, 'entry.js'), entrySource ?? `console.info(__PWA_BUILD_ID__);`);
  for (const name of [
    'future-format.arbitrary', 'runtime.wasm.gz', 'naidan-standalone.zip', 'favicon.svg', 'ignored.map',
    ...UI_LOCALES.map(locale => `naidan-standalone-${locale}.zip`),
  ]) {
    await writeFile(path.join(root, 'public', name), `${buildId}:${name}`);
  }
  await writeFile(path.join(root, 'public', 'worker.js'), `// ${buildId}: fixed-name script fixture`);
  for (const [name, content] of publicFiles ?? []) {
    await writeFile(path.join(root, 'public', name), content);
  }
  const { options, define, assetsPlugin, workerAssetsPlugin } = createPWABuild({ buildId, getRuntimeArtifacts, getLocaleAssets });
  if (options.injectManifest && additionalManifestEntries !== undefined) {
    options.injectManifest.additionalManifestEntries = additionalManifestEntries;
  }
  const outDir = path.join(root, 'dist');
  const result = await build({
    root,
    configFile: false,
    define,
    logLevel: 'silent',
    base: './',
    worker: worker === undefined ? undefined : {
      format: 'es',
      plugins: () => [...worker.plugins(), workerAssetsPlugin({ profileForModule: worker.profileForModule })],
    },
    plugins: [...plugins, assetsPlugin, VitePWA({ ...options, srcDir: path.join(projectRoot, 'pwa') })],
    build: { outDir, emptyOutDir: true, modulePreload: false },
  });
  const files = new Map<string, Buffer>();
  async function collect({ directory }: { directory: string }): Promise<void> {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) {
        await collect({ directory: absolute });
      } else {
        files.set(path.relative(outDir, absolute).replaceAll('\\', '/'), await readFile(absolute));
      }
    }
  }
  await collect({ directory: outDir });
  const entries = (Array.isArray(result) ? result : [result])
    .flatMap(output => 'output' in output ? output.output : [])
    .filter(output => output.type === 'chunk' && output.isEntry);
  if (entries.length !== 1) {
    throw new Error('Expected one compiled page entry');
  }
  const entry = files.get(entries[0]!.fileName);
  if (!entry) {
    throw new Error('Missing compiled page entry');
  }
  let pageBuildId: unknown;
  // vm's classic-script context has no import.meta. Supply only this platform
  // value for the page-identity probe; the files served to Workbox stay intact.
  const evaluation = await transformWithOxc(entry.toString(), 'pwa-fixture-entry.js', {
    define: { 'import.meta': JSON.stringify({ url: 'https://example.test/entry.js' }) },
  });
  const executable = new MagicString(evaluation.code);
  for (const statement of parseSync('pwa-fixture-entry.js', evaluation.code).program.body) {
    // Rolldown may export a helper for lazy chunks to share. Strip only the
    // export list from the evaluator, keeping the emitted page and helper intact.
    if (statement.type === 'ExportNamedDeclaration' && !statement.source && !statement.declaration) {
      executable.remove(statement.start, statement.end);
    }
  }
  vm.runInNewContext(executable.toString(), {
    console: {
      info(value: unknown) {
        pageBuildId = value;
      },
    },
  });
  if (typeof pageBuildId !== 'string') {
    throw new Error('Page build identity was not injected');
  }
  return { outDir, files, pageBuildId, script: (await readFile(path.join(outDir, 'sw.js'), 'utf8')) };
}

export const TEST_ONLY = {
};
