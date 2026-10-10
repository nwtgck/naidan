import path from 'node:path';
import vm from 'node:vm';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { createPWABuild } from '../pwa';
import { UI_LOCALES } from '../../src/01-models/ui-locale';

/** Static inputs for the Node-only generated-worker tests. The production
 * Workbox build receives these files; no browser, UI or app-module stubs are used.
 */
export async function buildPWAFixture({ root, buildId }: { root: string; buildId: string }) {
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
  await mkdir(path.join(root, 'public'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), `<!doctype html><title>${buildId}</title><script type="module" src="/entry.js"></script>`);
  await writeFile(path.join(root, 'entry.js'), `console.info(__PWA_BUILD_ID__);`);
  for (const name of [
    'future-format.arbitrary', 'runtime.wasm.gz', 'naidan-standalone.zip', 'favicon.svg', 'ignored.map',
    ...UI_LOCALES.map(locale => `naidan-standalone-${locale}.zip`),
  ]) await writeFile(path.join(root, 'public', name), `${buildId}:${name}`);
  await writeFile(path.join(root, 'public', 'worker.js'), `// ${buildId}: fixed-name script fixture`);
  const { options, define } = createPWABuild({ buildId });
  const outDir = path.join(root, 'dist');
  await build({
    root,
    configFile: false,
    define,
    logLevel: 'silent',
    base: './',
    plugins: [VitePWA({ ...options, srcDir: path.join(projectRoot, 'pwa') })],
    build: { outDir, emptyOutDir: true, modulePreload: false },
  });
  const files = new Map<string, Buffer>();
  async function collect({ directory }: { directory: string }): Promise<void> {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) await collect({ directory: absolute });
      else files.set(path.relative(outDir, absolute).replaceAll('\\', '/'), await readFile(absolute));
    }
  }
  await collect({ directory: outDir });
  const entry = [...files].find(([name]) => name.startsWith('assets/') && name.endsWith('.js'))?.[1];
  if (!entry) throw new Error('Missing compiled page entry');
  let pageBuildId: unknown;
  vm.runInNewContext(entry.toString(), {
    console: {
      info(value: unknown) {
        pageBuildId = value;
      },
    },
  });
  if (typeof pageBuildId !== 'string') throw new Error('Page build identity was not injected');
  return { outDir, files, pageBuildId, script: (await readFile(path.join(outDir, 'sw.js'), 'utf8')) };
}

export const TEST_ONLY = {
};
