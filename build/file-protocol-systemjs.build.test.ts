import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { build } from 'vite';
import type { BuildOptions, Plugin } from 'vite';

import { fileProtocolSystemJs } from './file-protocol-systemjs';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map(async (root) => {
    await fsPromises.rm(root, { recursive: true, force: true });
  }));
});

async function createFixture({ entryColor, lazyColor }: {
  entryColor: string,
  lazyColor: string,
}): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-protocol-systemjs-build-'));
  fixtureRoots.push(root);
  await fsPromises.mkdir(path.join(root, 'src'), { recursive: true });
  await Promise.all([
    fsPromises.writeFile(path.join(root, 'index.html'), `\
<!doctype html>
<html>
  <head><meta charset="UTF-8"><title>SystemJS CSS fixture</title></head>
  <body><div id="app"></div><script type="module" src="/src/main.js"></script></body>
</html>
`),
    fsPromises.writeFile(path.join(root, 'src/main.js'), `\
import './main.css'
export function systemJsFixtureExport() {
  return 'entry-systemjs-export'
}
globalThis.loadSystemJsCssFixture = () => import('./lazy.js')
`),
    fsPromises.writeFile(path.join(root, 'src/main.css'), `\
@font-face {
  font-family: "SystemJsProbe";
  src: url("./probe.woff2?#iefix") format("woff2");
}
.entry-systemjs-css-marker { color: ${entryColor}; }
`),
    fsPromises.writeFile(path.join(root, 'src/lazy.js'), `\
import './lazy.css'
import { systemJsFixtureExport } from './main.js'
export const lazyValue = 'lazy-systemjs-value'
export const entryValue = systemJsFixtureExport()
`),
    fsPromises.writeFile(path.join(root, 'src/lazy.css'), `\
.lazy-systemjs-css-marker { color: ${lazyColor}; }
`),
    fsPromises.writeFile(path.join(root, 'src/probe.woff2'), Buffer.from('systemjs-font-probe')),
  ]);
  return root;
}

async function buildFixture({
  root,
  sourcemap,
  chunkMarker,
  minify,
  plugins,
}: {
  root: string,
  sourcemap: BuildOptions['sourcemap'],
  chunkMarker: 'systemjs' | 'classic' | 'directory-only',
  minify: 'oxc' | false,
  plugins: readonly Plugin[],
}): Promise<string> {
  const outputDirectory = path.join(root, 'dist');
  const outputNames = (() => {
    switch (chunkMarker) {
    case 'systemjs':
      return {
        entryFileNames: 'scripts/[name]-systemjs-[hash].js',
        chunkFileNames: 'scripts/lazy/[name]-systemjs-[hash].js',
      };
    case 'classic':
      return {
        entryFileNames: 'scripts/[name]-classic-[hash].js',
        chunkFileNames: 'scripts/lazy/[name]-classic-[hash].js',
      };
    case 'directory-only':
      return {
        entryFileNames: 'scripts-systemjs/[name]-classic-[hash].js',
        chunkFileNames: 'scripts-systemjs/lazy/[name]-classic-[hash].js',
      };
    default: {
      const _ex: never = chunkMarker;
      throw new Error(`Unhandled chunk marker fixture: ${_ex}`);
    }
    }
  })();
  await build({
    root,
    base: './',
    configFile: false,
    logLevel: 'silent',
    plugins: [...plugins, fileProtocolSystemJs({ diagnostics: 'emit' })],
    build: {
      assetsInlineLimit: 0,
      cssCodeSplit: true,
      emptyOutDir: true,
      manifest: true,
      minify,
      modulePreload: false,
      outDir: outputDirectory,
      sourcemap,
      rollupOptions: {
        output: {
          ...outputNames,
          assetFileNames: 'styles/[name]-[hash][extname]',
        },
      },
    },
  });
  return outputDirectory;
}

function listFilesRecursively({ directory }: {
  directory: string,
}): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? listFilesRecursively({ directory: absolutePath })
      : [absolutePath];
  });
}

function readJavaScriptOutputs({ outputDirectory }: {
  outputDirectory: string,
}): readonly Readonly<{
  fileName: string,
  source: string,
}>[] {
  return listFilesRecursively({ directory: outputDirectory })
    .filter((filePath) => filePath.endsWith('.js'))
    .map((filePath) => ({
      fileName: path.relative(outputDirectory, filePath).split(path.sep).join('/'),
      source: fs.readFileSync(filePath, 'utf8'),
    }));
}

describe('fileProtocolSystemJs CSS output', () => {
  it('uses semantic SystemJS names and preserves entry/lazy CSS with runtime asset URLs', async () => {
    const root = await createFixture({ entryColor: 'rgb(1 2 3)', lazyColor: 'rgb(4 5 6)' });
    const outputDirectory = await buildFixture({
      root,
      sourcemap: false,
      chunkMarker: 'systemjs',
      minify: 'oxc',
      plugins: [],
    });

    const files = listFilesRecursively({ directory: outputDirectory })
      .map((filePath) => path.relative(outputDirectory, filePath).split(path.sep).join('/'));
    expect(files.filter((fileName) => fileName.endsWith('.css'))).toEqual([]);
    const manifest = JSON.parse(fs.readFileSync(
      path.join(outputDirectory, '.vite', 'manifest.json'),
      'utf8',
    )) as Record<string, { css?: string[] }>;
    expect(Object.values(manifest).flatMap(({ css }) => css ?? [])).toEqual([]);

    const javascript = readJavaScriptOutputs({ outputDirectory });
    const allJavaScript = javascript.map(({ source }) => source).join('\n');
    expect(javascript.length).toBe(2);
    expect(javascript.every(({ fileName }) => fileName.includes('-systemjs-'))).toBe(true);
    expect(javascript.some(({ fileName }) => fileName.includes('-legacy-'))).toBe(false);

    const entry = javascript.find(({ source }) => source.includes('entry-systemjs-css-marker'));
    const lazy = javascript.find(({ source }) => source.includes('lazy-systemjs-css-marker'));
    expect(entry).toBeDefined();
    expect(lazy).toBeDefined();
    expect(entry?.source).not.toContain('lazy-systemjs-css-marker');
    expect(lazy?.source).not.toContain('entry-systemjs-css-marker');
    expect(entry?.source).toContain('System.register');
    expect(lazy?.source).toContain('System.register');
    expect(entry?.source).toContain('data-naidan-file-protocol-css');
    expect(entry?.source).toContain('new URL');
    expect(entry?.source).toContain('.meta.url');
    expect(entry?.source).toContain('../styles/probe-');

    const html = fs.readFileSync(path.join(outputDirectory, 'index.html'), 'utf8');
    const dom = new JSDOM(html);
    expect(dom.window.document.querySelectorAll('link[rel~="stylesheet"]')).toHaveLength(0);
    expect(dom.window.document.querySelector('script[type="module"]')?.getAttribute('src'))
      .toContain('-systemjs-');

    const contract = JSON.parse(fs.readFileSync(
      path.join(outputDirectory, 'systemjs-output-contract.json'),
      'utf8',
    )) as {
      format: string,
      chunks: readonly Readonly<{
        allReferences: readonly string[],
        fileName: string,
        inlinedCss: readonly Readonly<{
          fileName: string,
          runtimeUrlCount: number,
        }>[],
      }>[],
    };
    expect(contract.format).toBe('file-protocol-systemjs-output-contract-v2');
    expect(contract.chunks.every(({ fileName }) => fileName.includes('-systemjs-'))).toBe(true);
    const referencedFiles = contract.chunks.flatMap(({ allReferences }) => allReferences);
    expect(referencedFiles.some((fileName) => fileName.endsWith('.woff2'))).toBe(true);
    expect(referencedFiles.every((fileName) => fs.existsSync(path.join(outputDirectory, fileName)))).toBe(true);
    expect(contract.chunks.flatMap(({ inlinedCss }) => inlinedCss)).toHaveLength(2);
    const inlinedCss = contract.chunks.flatMap(({ inlinedCss }) => inlinedCss);
    expect(inlinedCss.find(({ fileName }) => fileName.includes('index-'))?.runtimeUrlCount).toBe(1);
    for (const { fileName } of inlinedCss) {
      expect(allJavaScript.split(fileName)).toHaveLength(2);
    }
    expect(allJavaScript).not.toContain('__VITE_PRELOAD__');
  });

  it('includes split CSS content in the owning chunk hash', async () => {
    const firstRoot = await createFixture({
      entryColor: 'rgb(1 2 3)',
      lazyColor: 'rgb(10 20 30)',
    });
    const changedEntryRoot = await createFixture({
      entryColor: 'rgb(3 2 1)',
      lazyColor: 'rgb(10 20 30)',
    });
    const changedLazyRoot = await createFixture({
      entryColor: 'rgb(1 2 3)',
      lazyColor: 'rgb(30 20 10)',
    });
    const firstOutput = await buildFixture({
      root: firstRoot,
      sourcemap: false,
      chunkMarker: 'systemjs',
      minify: 'oxc',
      plugins: [],
    });
    const changedEntryOutput = await buildFixture({
      root: changedEntryRoot,
      sourcemap: false,
      chunkMarker: 'systemjs',
      minify: 'oxc',
      plugins: [],
    });
    const changedLazyOutput = await buildFixture({
      root: changedLazyRoot,
      sourcemap: false,
      chunkMarker: 'systemjs',
      minify: 'oxc',
      plugins: [],
    });

    const readCssOwnerFileNames = (outputDirectory: string): Readonly<{
      entry: string,
      lazy: string,
    }> => {
      const javascript = readJavaScriptOutputs({ outputDirectory });
      const entry = javascript.find(({ source }) => source.includes('entry-systemjs-css-marker'));
      const lazy = javascript.find(({ source }) => source.includes('lazy-systemjs-css-marker'));
      if (entry === undefined || lazy === undefined) {
        throw new TypeError('Expected entry and lazy CSS chunks.');
      }
      return { entry: entry.fileName, lazy: lazy.fileName };
    };
    const firstNames = readCssOwnerFileNames(firstOutput);
    const changedEntryNames = readCssOwnerFileNames(changedEntryOutput);
    const changedLazyNames = readCssOwnerFileNames(changedLazyOutput);
    expect(firstNames.entry).not.toBe(changedEntryNames.entry);
    expect(firstNames.lazy).not.toBe(changedLazyNames.lazy);
  });

  it('preserves emitted and inline source maps after CSS injection', async () => {
    const externalRoot = await createFixture({ entryColor: 'rgb(1 2 3)', lazyColor: 'rgb(40 50 60)' });
    const hiddenRoot = await createFixture({ entryColor: 'rgb(1 2 3)', lazyColor: 'rgb(50 60 40)' });
    const inlineRoot = await createFixture({ entryColor: 'rgb(1 2 3)', lazyColor: 'rgb(60 50 40)' });
    const externalOutput = await buildFixture({
      root: externalRoot,
      sourcemap: true,
      chunkMarker: 'systemjs',
      minify: 'oxc',
      plugins: [],
    });
    const hiddenOutput = await buildFixture({
      root: hiddenRoot,
      sourcemap: 'hidden',
      chunkMarker: 'systemjs',
      minify: false,
      plugins: [],
    });
    const inlineOutput = await buildFixture({
      root: inlineRoot,
      sourcemap: 'inline',
      chunkMarker: 'systemjs',
      minify: 'oxc',
      plugins: [],
    });

    const externalJavaScript = readJavaScriptOutputs({ outputDirectory: externalOutput });
    expect(listFilesRecursively({ directory: externalOutput })
      .filter((filePath) => /\.css(?:\.map)?$/u.test(filePath))).toEqual([]);
    for (const chunk of externalJavaScript) {
      const sourceMapPath = path.join(externalOutput, `${chunk.fileName}.map`);
      const sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, 'utf8')) as {
        version: number,
        file: string,
        sources: readonly string[],
        sourcesContent: readonly string[],
        mappings: string,
      };
      expect(sourceMap.version).toBe(3);
      expect(sourceMap.file).toBe(path.posix.basename(chunk.fileName));
      expect(sourceMap.sources.length).toBeGreaterThan(0);
      expect(sourceMap.sourcesContent).toHaveLength(sourceMap.sources.length);
      expect(sourceMap.mappings.length).toBeGreaterThan(0);
      expect(chunk.source).toContain(`sourceMappingURL=${path.posix.basename(chunk.fileName)}.map`);
    }

    const hiddenJavaScript = readJavaScriptOutputs({ outputDirectory: hiddenOutput });
    for (const chunk of hiddenJavaScript) {
      expect(fs.existsSync(path.join(hiddenOutput, `${chunk.fileName}.map`))).toBe(true);
      expect(chunk.source).not.toContain('sourceMappingURL=');
      expect(chunk.source).toContain('System.register');
    }

    const inlineJavaScript = readJavaScriptOutputs({ outputDirectory: inlineOutput });
    expect(inlineJavaScript.every(({ source }) => (
      source.includes('sourceMappingURL=data:application/json')
    ))).toBe(true);
    expect(listFilesRecursively({ directory: inlineOutput })
      .some((filePath) => filePath.endsWith('.js.map'))).toBe(false);
    expect(listFilesRecursively({ directory: inlineOutput })
      .filter((filePath) => /\.css(?:\.map)?$/u.test(filePath))).toEqual([]);
  });

  it('rejects output names that conceal the System.register format', async () => {
    const root = await createFixture({ entryColor: 'rgb(1 2 3)', lazyColor: 'rgb(70 80 90)' });
    await expect(buildFixture({
      root,
      sourcemap: false,
      chunkMarker: 'classic',
      minify: 'oxc',
      plugins: [],
    })).rejects.toThrow('must use the -systemjs- marker');

    const directoryOnlyRoot = await createFixture({ entryColor: 'rgb(1 2 3)', lazyColor: 'rgb(90 80 70)' });
    await expect(buildFixture({
      root: directoryOnlyRoot,
      sourcemap: false,
      chunkMarker: 'directory-only',
      minify: 'oxc',
      plugins: [],
    })).rejects.toThrow('must use the -systemjs- marker');
  });

  it('rejects finalized CSS assets that are not owned by an application chunk', async () => {
    const root = await createFixture({
      entryColor: 'rgb(11 22 33)',
      lazyColor: 'rgb(44 55 66)',
    });
    const emitOrphanCss: Plugin = {
      name: 'emit-orphan-css',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'styles/orphan.css',
          source: '.orphan { color: red; }\n',
        });
      },
    };

    await expect(buildFixture({
      root,
      sourcemap: false,
      chunkMarker: 'systemjs',
      minify: 'oxc',
      plugins: [emitOrphanCss],
    })).rejects.toThrow('CSS assets are not owned by an application chunk: styles/orphan.css');
  });
});
