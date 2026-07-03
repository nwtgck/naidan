import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import legacy from '@vitejs/plugin-legacy';
import vue from '@vitejs/plugin-vue';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { fileProtocolStandalone } from '../file-protocol-standalone';
import { createTwClassNodeTransform } from './tw-class-core.mjs';
import { createTwClassVitePlugin } from './tw-class-vite-plugin.mjs';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function writeFile({ root, relativePath, content }: {
  root: string,
  relativePath: string,
  content: string,
}): void {
  const filename = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

function createFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-static-tailwind-build-'));
  temporaryDirectories.push(root);
  fs.symlinkSync(path.resolve(import.meta.dirname, '../../node_modules'), path.join(root, 'node_modules'), 'dir');
  writeFile({
    root,
    relativePath: 'package.json',
    content: JSON.stringify({
      type: 'module',
      devDependencies: { tailwindcss: '4.3.1' },
    }),
  });
  writeFile({
    root,
    relativePath: 'index.html',
    content: '<div id="app"></div><script type="module" src="/src/main.ts"></script>\n',
  });
  writeFile({ root, relativePath: 'src/style.css', content: '@import "tailwindcss" source(none);\n' });
  writeFile({
    root,
    relativePath: 'src/main.ts',
    content: `import './style.css';\nObject.assign(window, {\n  loadFeatureA: () => import('./FeatureA.vue'),\n  loadFeatureB: () => import('./FeatureB.vue'),\n});\n`,
  });
  writeFile({
    root,
    relativePath: 'src/Shared.vue',
    content: '<template><div tw-class="p-2">Shared</div></template>\n',
  });
  writeFile({
    root,
    relativePath: 'src/FeatureA.vue',
    content: '<script setup lang="ts">import Shared from \'./Shared.vue\';</script>\n<template><section tw-class="animate-spin"><Shared /></section></template>\n',
  });
  writeFile({
    root,
    relativePath: 'src/FeatureB.vue',
    content: '<script setup lang="ts">import Shared from \'./Shared.vue\';</script>\n<template><section tw-class="italic"><Shared /></section></template>\n',
  });
  return root;
}

function readCssAssets({ outputDirectory }: { outputDirectory: string }): Map<string, string> {
  const assetsDirectory = path.join(outputDirectory, 'assets');
  return new Map(fs.readdirSync(assetsDirectory)
    .filter((filename) => filename.endsWith('.css'))
    .sort()
    .map((filename) => [filename, fs.readFileSync(path.join(assetsDirectory, filename), 'utf8')]));
}

describe('static Tailwind Vite plugin production CSS splitting', () => {
  it('keeps lazy utilities out of initial CSS and emits shared utility CSS once', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const outputDirectory = path.join(root, 'dist');
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        createTwClassVitePlugin({
          projectRoot: root,
          sourceRoot,
          entryModule: path.join(sourceRoot, 'main.ts'),
          tailwindCssPath: path.join(sourceRoot, 'style.css'),
          aliases: [],
          additionalLazyRootDirectories: [],
          debugOutputDirectory: path.join(outputDirectory, 'debug-tailwind'),
          splitCss: true,
          cssPlanning: 'enabled',
          maxLazyCssGroups: undefined,
        }),
        vue({
          template: {
            compilerOptions: {
              nodeTransforms: [createTwClassNodeTransform({ filename: 'Vue template' })],
            },
          },
        }),
      ],
      build: {
        cssCodeSplit: true,
        manifest: true,
        outDir: outputDirectory,
        sourcemap: true,
      },
    });

    const manifest = JSON.parse(fs.readFileSync(path.join(outputDirectory, '.vite', 'manifest.json'), 'utf8')) as Record<string, {
      css?: string[],
      isEntry?: boolean,
    }>;
    const entry = Object.values(manifest).find(({ isEntry }) => isEntry === true);
    expect(entry).toBeDefined();
    const cssAssets = readCssAssets({ outputDirectory });
    expect(cssAssets.size).toBeGreaterThanOrEqual(3);

    const initialCss = (entry?.css ?? []).map((filename) => cssAssets.get(path.basename(filename)) ?? '').join('\n');
    const allCss = [...cssAssets.values()].join('\n');
    expect(initialCss).not.toContain('.animate-spin');
    expect(initialCss).not.toContain('.italic');
    expect(initialCss).not.toContain('.p-2');
    expect(allCss).toContain('.animate-spin');
    expect(allCss).toContain('.italic');
    expect(allCss).toContain('.p-2');
    expect([...cssAssets.values()].filter((css) => css.includes('.p-2'))).toHaveLength(1);
  });

  it('preserves lazy CSS splitting in the file-protocol standalone output', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const outputDirectory = path.join(root, 'dist-standalone');
    await build({
      root,
      base: './',
      configFile: false,
      logLevel: 'silent',
      plugins: [
        createTwClassVitePlugin({
          projectRoot: root,
          sourceRoot,
          entryModule: path.join(sourceRoot, 'main.ts'),
          tailwindCssPath: path.join(sourceRoot, 'style.css'),
          aliases: [],
          additionalLazyRootDirectories: [],
          debugOutputDirectory: path.join(outputDirectory, 'debug-tailwind'),
          splitCss: true,
          cssPlanning: 'enabled',
          maxLazyCssGroups: undefined,
        }),
        vue({
          template: {
            compilerOptions: {
              nodeTransforms: [createTwClassNodeTransform({ filename: 'Vue template' })],
            },
          },
        }),
        legacy({
          targets: ['Chrome >= 140'],
          renderModernChunks: false,
          renderLegacyChunks: true,
          externalSystemJS: true,
          modernPolyfills: false,
          polyfills: false,
        }),
        fileProtocolStandalone({
          debugBuildReportFile: undefined,
          workerTarget: 'chrome140',
          workers: [],
          budgets: undefined,
          onAdditionalLicenseDependencies: undefined,
        }),
      ],
      build: {
        cssCodeSplit: true,
        manifest: true,
        modulePreload: false,
        outDir: outputDirectory,
      },
    });

    const manifest = JSON.parse(fs.readFileSync(path.join(outputDirectory, '.vite', 'manifest.json'), 'utf8')) as Record<string, {
      file: string,
      isEntry?: boolean,
    }>;
    const entry = Object.values(manifest).find(({ isEntry }) => isEntry === true);
    expect(entry).toBeDefined();
    if (entry === undefined) throw new TypeError('Expected one standalone entry chunk.');

    const cssAssets = readCssAssets({ outputDirectory });
    expect(cssAssets.size).toBe(0);
    const javascriptAssets = fs.readdirSync(path.join(outputDirectory, 'assets'))
      .filter((filename) => filename.endsWith('.js'))
      .sort()
      .map((filename) => ({
        filename,
        source: fs.readFileSync(path.join(outputDirectory, 'assets', filename), 'utf8'),
      }));
    const entryJavaScript = fs.readFileSync(path.join(outputDirectory, entry.file), 'utf8');
    const allJavaScript = javascriptAssets.map(({ source }) => source).join('\n');
    expect(entryJavaScript).not.toContain('.animate-spin');
    expect(entryJavaScript).not.toContain('.italic');
    expect(entryJavaScript).not.toContain('.p-2');
    expect(allJavaScript).toContain('.animate-spin');
    expect(allJavaScript).toContain('.italic');
    expect(allJavaScript).toContain('.p-2');
    expect(javascriptAssets.filter(({ source }) => source.includes('.p-2'))).toHaveLength(1);

    const html = fs.readFileSync(path.join(outputDirectory, 'index.html'), 'utf8');
    expect(html).toContain('file-protocol-standalone');
    expect(html).not.toContain('type="module"');
    expect(allJavaScript).toContain('System.register');
  });
});
