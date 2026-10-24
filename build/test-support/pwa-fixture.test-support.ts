import path from 'node:path';
import vm from 'node:vm';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build, transformWithOxc, type PluginOption } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { createPWABuild } from '../pwa';
import { UI_LOCALES } from '../../src/01-models/ui-locale';

/** Static inputs for the Node-only generated-worker tests. The production
 * Workbox build receives these files; no browser, UI or app-module stubs are used.
 */
export async function buildPWAFixture({ root, buildId, publicFiles, entrySource, plugins = [] }: {
  root: string,
  buildId: string,
  publicFiles?: ReadonlyMap<string, string>,
  entrySource?: string,
  plugins?: readonly PluginOption[],
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
  const { options, define } = createPWABuild({ buildId });
  const outDir = path.join(root, 'dist');
  const result = await build({
    root,
    configFile: false,
    define,
    logLevel: 'silent',
    base: './',
    plugins: [...plugins, VitePWA({ ...options, srcDir: path.join(projectRoot, 'pwa') })],
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
  vm.runInNewContext(evaluation.code, {
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
