import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { OutputAsset, OutputChunk, RolldownOutput } from 'rolldown';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'vite';

import { createNaidanStandalonePlugin } from './plugin.js';

const require = createRequire(import.meta.url);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function writeFixtureFile({ root, relativePath, contents }: Readonly<{
  root: string;
  relativePath: string;
  contents: string;
}>): void {
  const filename = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

function createFixture(): Readonly<{root: string}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-standalone-css-artifact-'));
  temporaryDirectories.push(root);
  fs.symlinkSync(path.resolve(import.meta.dirname, '../../node_modules'), path.join(root, 'node_modules'), 'dir');
  writeFixtureFile({
    root,
    relativePath: 'index.html',
    contents: '<div id="app"></div><script type="module" src="/src/main.js"></script>\n',
  });
  writeFixtureFile({
    root,
    relativePath: 'src/main.js',
    contents: `\
import './initial.css';
globalThis.loadStandaloneLazyCssProbe = () => import('./lazy.js');
`,
  });
  writeFixtureFile({ root, relativePath: 'src/initial.css', contents: '.initial-css-probe { border-left-width: 7px; }\n' });
  writeFixtureFile({ root, relativePath: 'src/lazy.js', contents: 'import "./lazy.css"; export const marker = "lazy-css-probe";\n' });
  writeFixtureFile({ root, relativePath: 'src/lazy.css', contents: '.lazy-css-probe { --lazy-css-marker: applied; }\n' });
  writeFixtureFile({ root, relativePath: 'src/worker.js', contents: 'self.onmessage = () => undefined;\n' });
  return { root };
}

function readAssetText({ asset }: Readonly<{asset: OutputAsset}>): string {
  return typeof asset.source === 'string'
    ? asset.source
    : Buffer.from(asset.source).toString('utf8');
}

function requireRolldownOutput({ result }: Readonly<{
  result: RolldownOutput | readonly RolldownOutput[];
}>): RolldownOutput {
  if ('output' in result) return result;
  if (result.length !== 1) throw new Error(`Expected one CSS artifact build output; found ${result.length}`);
  return result[0];
}

function findCssAssetByMarker({ output, marker }: Readonly<{
  output: RolldownOutput;
  marker: string;
}>): string {
  const asset = output.output.find((item): item is OutputAsset => (
    item.type === 'asset'
    && item.fileName.endsWith('.css')
    && readAssetText({ asset: item }).includes(marker)
  ));
  if (asset === undefined) throw new Error(`Expected CSS asset containing ${marker}`);
  return asset.fileName;
}

describe('file-protocol standalone CSS loading artifact contract', () => {
  it('keeps initial CSS eager and preserves a lazy CSS dependency on the SystemJS dynamic import', async () => {
    const { root } = createFixture();
    const result = await build({
      root,
      base: './',
      configFile: false,
      logLevel: 'silent',
      plugins: [createNaidanStandalonePlugin({
        workers: [{
          name: 'css-artifact-worker',
          entry: path.join(root, 'src/worker.js'),
          virtualId: 'virtual:file-protocol-standalone/worker/css-artifact-worker',
        }],
        systemRuntimePath: require.resolve('systemjs/dist/system.min.js'),
        sourceAudit: { mode: 'inline' },
      })],
      build: {
        cssCodeSplit: true,
        minify: false,
        modulePreload: false,
        outDir: path.join(root, 'dist'),
        write: false,
        rollupOptions: {
          output: {
            entryFileNames: 'assets/[name]-systemjs-[hash].js',
            chunkFileNames: 'assets/[name]-systemjs-[hash].js',
          },
        },
      },
    }) as RolldownOutput | readonly RolldownOutput[];
    const output = requireRolldownOutput({ result });

    const initialCssFileName = findCssAssetByMarker({ output, marker: 'initial-css-probe' });
    const lazyCssFileName = findCssAssetByMarker({ output, marker: 'lazy-css-probe' });
    const htmlAsset = output.output.find((item): item is OutputAsset => item.type === 'asset' && item.fileName === 'index.html');
    if (htmlAsset === undefined) throw new Error('Expected standalone index.html asset');
    const html = readAssetText({ asset: htmlAsset });
    expect(html).toContain(initialCssFileName);
    expect(html).not.toContain(lazyCssFileName);

    const entryChunk = output.output.find((item): item is OutputChunk => (
      item.type === 'chunk'
      && item.fileName.startsWith('assets/index-systemjs-')
      && item.fileName.endsWith('.js')
    ));
    if (entryChunk === undefined) throw new Error('Expected standalone entry JavaScript chunk');
    const entryJavaScript = entryChunk.code;
    expect(entryJavaScript).toContain('__vitePreload');
    expect(entryJavaScript).toContain(path.posix.basename(lazyCssFileName));
    expect(entryJavaScript).not.toMatch(/__vitePreload\([^;]+,void 0,/u);
  });
});
