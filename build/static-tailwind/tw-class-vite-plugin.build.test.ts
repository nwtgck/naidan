import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vue from '@vitejs/plugin-vue';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { fileProtocolStandalone } from '../file-protocol-standalone';
import { fileProtocolSystemJs } from '../file-protocol-systemjs';
import { serializeCssOwnershipPlan } from './css-ownership-planner';
import { createTwClassNodeTransform } from './tw-class-core';
import { createTwClassVitePlugin } from './tw-class-vite-plugin';

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
      devDependencies: { tailwindcss: '4.3.2' },
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
    content: `import './style.css';
import { tw } from 'virtual:naidan-tailwind';
document.documentElement.classList.add(tw('antialiased'));
Object.assign(window, {
  loadFeatureA: () => import('./FeatureA.vue'),
  loadFeatureB: () => import('./FeatureB.vue'),
});
`,
  });
  writeFile({
    root,
    relativePath: 'src/Shared.vue',
    content: '<template><div tw-class="p-2">Shared</div></template>\n',
  });
  writeFile({
    root,
    relativePath: 'src/FeatureA.vue',
    content: '<script setup lang="ts">import Shared from \'./Shared.vue\';</script>\n<template><section tw-class="animate-spin appearance-none"><Shared /></section></template>\n',
  });
  writeFile({
    root,
    relativePath: 'src/FeatureB.vue',
    content: '<script setup lang="ts">import Shared from \'./Shared.vue\';</script>\n<template><section tw-class="italic"><Shared /></section></template>\n',
  });
  writeFile({
    root,
    relativePath: 'src/Unreachable.vue',
    content: '<template><div tw-class="bg-fuchsia-500">Unreachable</div></template>\n',
  });
  return root;
}



function createPlugin({ root, debugOutputDirectory }: {
  root: string,
  debugOutputDirectory: string | undefined,
}) {
  const sourceRoot = path.join(root, 'src');
  return createTwClassVitePlugin({
    projectRoot: root,
    sourceRoot,
    entryModule: path.join(sourceRoot, 'main.ts'),
    tailwindCssPath: path.join(sourceRoot, 'style.css'),
    debugOutputDirectory,
    outputMode: 'split',
    cssPlanning: 'enabled',
    maxSplitCssGroups: undefined,
  });
}

function createVuePlugin() {
  return vue({
    template: {
      compilerOptions: {
        nodeTransforms: [createTwClassNodeTransform({ filename: 'Vue template', blockStart: undefined })],
      },
    },
  });
}

function serializeImports({ importsByModule, root }: {
  importsByModule: Map<string, string[]>,
  root: string,
}): Record<string, string[]> {
  return Object.fromEntries([...importsByModule]
    .map(([filename, imports]) => [path.relative(root, filename).replaceAll(path.sep, '/'), imports] as const)
    .sort(([left], [right]) => left.localeCompare(right)));
}

function readCssAssets({ outputDirectory }: { outputDirectory: string }): Map<string, string> {
  const assetsDirectory = path.join(outputDirectory, 'assets');
  return new Map(fs.readdirSync(assetsDirectory)
    .filter((filename) => filename.endsWith('.css'))
    .sort()
    .map((filename) => [filename, fs.readFileSync(path.join(assetsDirectory, filename), 'utf8')]));
}

function readJavaScriptAssets({ outputDirectory }: { outputDirectory: string }): {
  filename: string,
  source: string,
}[] {
  return fs.readdirSync(path.join(outputDirectory, 'assets'))
    .filter((filename) => filename.endsWith('.js'))
    .sort()
    .map((filename) => ({
      filename,
      source: fs.readFileSync(path.join(outputDirectory, 'assets', filename), 'utf8'),
    }));
}

describe('static Tailwind Vite plugin production CSS splitting', () => {
  it('uses the same candidate plan and CSS ownership in serve and build modes', async () => {
    const root = createFixture();
    const initialize = async ({ plugin, command }: {
      plugin: ReturnType<typeof createPlugin>,
      command: 'build' | 'serve',
    }): Promise<void> => {
      const configResolved = plugin.configResolved;
      if (typeof configResolved !== 'function') throw new TypeError('Expected configResolved hook.');
      await configResolved.call({} as never, { command } as never);
      const buildStart = plugin.buildStart;
      if (typeof buildStart !== 'function') throw new TypeError('Expected buildStart hook.');
      await buildStart.call({ info() {} } as never, {} as never);
    };
    const cssImports = ({ plugin }: { plugin: ReturnType<typeof createPlugin> }): Record<string, string[]> => (
      serializeImports({
        importsByModule: new Map([...plugin.api.getImportsByModule()].map(([filename, imports]) => [
          filename,
          imports.filter((id) => id.startsWith('virtual:naidan-tailwind-css-module/')),
        ])),
        root,
      })
    );

    const servePlugin = createPlugin({ root, debugOutputDirectory: undefined });
    await initialize({ plugin: servePlugin, command: 'serve' });
    const buildPlugin = createPlugin({ root, debugOutputDirectory: undefined });
    await initialize({ plugin: buildPlugin, command: 'build' });

    const servePlan = servePlugin.api.getPlan();
    const productionPlan = buildPlugin.api.getPlan();
    expect(servePlan).toBeDefined();
    expect(productionPlan).toBeDefined();
    if (servePlan === undefined || productionPlan === undefined) {
      throw new TypeError('Expected static Tailwind plans for serve and build modes.');
    }
    expect(serializeCssOwnershipPlan({ plan: servePlan })).toEqual(
      serializeCssOwnershipPlan({ plan: productionPlan }),
    );
    expect(cssImports({ plugin: servePlugin })).toEqual(cssImports({ plugin: buildPlugin }));

    const serveEntryImports = servePlugin.api.getImportsByModule().get(path.join(root, 'src/main.ts')) ?? [];
    const buildEntryImports = buildPlugin.api.getImportsByModule().get(path.join(root, 'src/main.ts')) ?? [];
    expect(serveEntryImports).toContain('virtual:naidan-tailwind-hmr-client');
    expect(buildEntryImports).not.toContain('virtual:naidan-tailwind-hmr-client');
  });

  it('keeps lazy utilities out of the hosted entry and emits shared utility CSS once', async () => {
    const root = createFixture();
    const outputDirectory = path.join(root, 'dist');
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        createPlugin({ root, debugOutputDirectory: path.join(outputDirectory, 'debug-tailwind') }),
        createVuePlugin(),
      ],
      build: {
        cssCodeSplit: true,
        manifest: true,
        outDir: outputDirectory,
        sourcemap: true,
      },
    });

    const manifest = JSON.parse(fs.readFileSync(path.join(outputDirectory, '.vite', 'manifest.json'), 'utf8')) as Record<string, {
      file: string,
      isEntry?: boolean,
    }>;
    const entry = Object.values(manifest).find(({ isEntry }) => isEntry === true);
    expect(entry).toBeDefined();
    if (entry === undefined) throw new TypeError('Expected one hosted entry chunk.');

    const hostedCss = [...readCssAssets({ outputDirectory }).values()].join('\n');
    expect(hostedCss).not.toContain('.animate-spin');
    expect(hostedCss).not.toContain('.appearance-none');
    expect(hostedCss).not.toContain('.italic');
    expect(hostedCss).not.toContain('.p-2');
    const javascriptAssets = readJavaScriptAssets({ outputDirectory });
    const entryJavaScript = fs.readFileSync(path.join(outputDirectory, entry.file), 'utf8');
    const allJavaScript = javascriptAssets.map(({ source }) => source).join('\n');
    expect(entryJavaScript).toContain('.antialiased');
    expect(entryJavaScript).not.toContain('.animate-spin');
    expect(entryJavaScript).not.toContain('.appearance-none');
    expect(entryJavaScript).not.toContain('.italic');
    expect(entryJavaScript).not.toContain('.p-2');
    expect(allJavaScript).toContain('.animate-spin');
    expect(allJavaScript).toContain('.appearance-none');
    expect(allJavaScript).toContain('.italic');
    expect(allJavaScript).toContain('.p-2');
    expect(allJavaScript).not.toContain('.bg-fuchsia-500');
    expect(allJavaScript).not.toContain(
      'Tailwind compile-time macro was not transformed',
    );
    expect(allJavaScript).not.toContain('import.meta.hot');
    expect(javascriptAssets.filter(({ source }) => source.includes('.p-2'))).toHaveLength(1);
    const appearanceAssets = javascriptAssets.filter(({ source }) => source.includes('.appearance-none'));
    expect(appearanceAssets).toHaveLength(1);
    expect(appearanceAssets[0]?.source).toContain('-webkit-appearance');
    expect(allJavaScript).toContain('data-naidan-tailwind-runtime');
    expect(allJavaScript).not.toContain('@layer utilities.naidan-');
  });

  it('loads initial support CSS in every HTML entry that uses a split utility registration', async () => {
    const root = createFixture();
    const outputDirectory = path.join(root, 'dist-multi-entry');
    writeFile({
      root,
      relativePath: 'broker.html',
      content: '<div id="broker"></div><script type="module" src="/src/broker-entry.ts"></script>\n',
    });
    writeFile({
      root,
      relativePath: 'src/broker-entry.ts',
      content: `\
import { tw } from 'virtual:naidan-tailwind';
document.querySelector('#broker')?.classList.add(tw('text-sm'));
`,
    });
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        createPlugin({ root, debugOutputDirectory: undefined }),
        createVuePlugin(),
      ],
      build: {
        cssCodeSplit: true,
        manifest: true,
        outDir: outputDirectory,
        rollupOptions: {
          input: {
            app: path.join(root, 'index.html'),
            broker: path.join(root, 'broker.html'),
          },
        },
      },
    });

    const manifest = JSON.parse(fs.readFileSync(
      path.join(outputDirectory, '.vite', 'manifest.json'),
      'utf8',
    )) as Record<string, {
      file: string,
      imports?: string[],
      isEntry?: boolean,
    }>;
    const brokerEntryKey = Object.entries(manifest).find(([key, value]) => (
      key.endsWith('broker.html') && value.isEntry === true
    ))?.[0];
    expect(brokerEntryKey).toBeDefined();
    if (brokerEntryKey === undefined) throw new TypeError('Expected the broker HTML entry in the manifest.');

    const reachableKeys = new Set<string>();
    const pendingKeys = [brokerEntryKey];
    while (pendingKeys.length > 0) {
      const key = pendingKeys.shift();
      if (key === undefined || reachableKeys.has(key)) continue;
      reachableKeys.add(key);
      for (const importedKey of manifest[key]?.imports ?? []) pendingKeys.push(importedKey);
    }
    const brokerJavaScript = [...reachableKeys]
      .map((key) => manifest[key])
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      .map(({ file }) => fs.readFileSync(path.join(outputDirectory, file), 'utf8'))
      .join('\n');
    expect(brokerJavaScript).toContain('.text-sm');
    expect(brokerJavaScript).toContain('--text-sm:');
  });

  it('keeps initial support CSS when a secondary HTML entry is built without the configured main entry', async () => {
    const root = createFixture();
    const outputDirectory = path.join(root, 'dist-secondary-only');
    writeFile({
      root,
      relativePath: 'broker.html',
      content: '<div id="broker"></div><script type="module" src="/src/broker-entry.ts"></script>\n',
    });
    writeFile({
      root,
      relativePath: 'src/broker-entry.ts',
      content: `\
import { tw } from 'virtual:naidan-tailwind';
document.querySelector('#broker')?.classList.add(tw('text-sm'));
`,
    });
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        createPlugin({ root, debugOutputDirectory: undefined }),
        createVuePlugin(),
      ],
      build: {
        cssCodeSplit: true,
        outDir: outputDirectory,
        rollupOptions: { input: path.join(root, 'broker.html') },
      },
    });

    const javascript = readJavaScriptAssets({ outputDirectory })
      .map(({ source }) => source)
      .join('\n');
    expect(javascript).toContain('.text-sm');
    expect(javascript).toContain('--text-sm:');
  });

  it('fails split builds before emitting unresolved relative CSS assets', async () => {
    const root = createFixture();
    const outputDirectory = path.join(root, 'dist-relative-url');
    writeFile({
      root,
      relativePath: 'src/style.css',
      content: `\
@import "tailwindcss" source(none);
.asset { background-image: url("./asset.svg"); }
`,
    });
    writeFile({ root, relativePath: 'src/asset.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" />\n' });

    await expect(build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        createPlugin({ root, debugOutputDirectory: undefined }),
        createVuePlugin(),
      ],
      build: {
        cssCodeSplit: true,
        outDir: outputDirectory,
      },
    })).rejects.toThrow(/Split runtime CSS cannot preserve relative asset URLs/u);
    expect(fs.existsSync(path.join(outputDirectory, 'assets', 'asset.svg'))).toBe(false);
  });

  it('preserves lazy CSS splitting in the file-protocol standalone output', async () => {
    const root = createFixture();
    const outputDirectory = path.join(root, 'dist-standalone');
    await build({
      root,
      base: './',
      configFile: false,
      logLevel: 'silent',
      plugins: [
        createPlugin({ root, debugOutputDirectory: path.join(outputDirectory, 'debug-tailwind') }),
        createVuePlugin(),
        fileProtocolSystemJs({ diagnostics: 'omit' }),
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
        minify: 'oxc',
        modulePreload: false,
        outDir: outputDirectory,
        rollupOptions: {
          output: {
            entryFileNames: 'assets/[name]-systemjs-[hash].js',
            chunkFileNames: 'assets/[name]-systemjs-[hash].js',
          },
        },
      },
    });

    const manifest = JSON.parse(fs.readFileSync(path.join(outputDirectory, '.vite', 'manifest.json'), 'utf8')) as Record<string, {
      css?: string[],
      file: string,
      isEntry?: boolean,
    }>;
    expect(Object.values(manifest).flatMap(({ css }) => css ?? [])).toEqual([]);
    const entry = Object.values(manifest).find(({ isEntry }) => isEntry === true);
    expect(entry).toBeDefined();
    if (entry === undefined) throw new TypeError('Expected one standalone entry chunk.');

    expect(readCssAssets({ outputDirectory }).size).toBe(0);
    const javascriptAssets = readJavaScriptAssets({ outputDirectory });
    const entryJavaScript = fs.readFileSync(path.join(outputDirectory, entry.file), 'utf8');
    const allJavaScript = javascriptAssets.map(({ source }) => source).join('\n');
    expect(entryJavaScript).toContain('.antialiased');
    expect(entryJavaScript).not.toContain('.animate-spin');
    expect(entryJavaScript).not.toContain('.appearance-none');
    expect(entryJavaScript).not.toContain('.italic');
    expect(entryJavaScript).not.toContain('.p-2');
    expect(allJavaScript).toContain('.animate-spin');
    expect(allJavaScript).toContain('.appearance-none');
    expect(allJavaScript).toContain('.italic');
    expect(allJavaScript).toContain('.p-2');
    expect(allJavaScript).not.toContain('.bg-fuchsia-500');
    expect(allJavaScript).not.toContain(
      'Tailwind compile-time macro was not transformed',
    );
    expect(allJavaScript).not.toContain('import.meta.hot');
    expect(javascriptAssets.filter(({ source }) => source.includes('.p-2'))).toHaveLength(1);
    const appearanceAssets = javascriptAssets.filter(({ source }) => source.includes('.appearance-none'));
    expect(appearanceAssets).toHaveLength(1);
    expect(appearanceAssets[0]?.source).toContain('-webkit-appearance');
    expect(allJavaScript).toContain('data-naidan-tailwind-runtime');
    expect(allJavaScript).not.toContain('@layer utilities.naidan-');

    const html = fs.readFileSync(path.join(outputDirectory, 'index.html'), 'utf8');
    expect(html).toContain('file-protocol-standalone');
    expect(html).not.toContain('type="module"');
    expect(allJavaScript).toContain('System.register');
  });
});
