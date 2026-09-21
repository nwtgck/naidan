// @vitest-environment node
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { build, type Plugin, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';
import { createLlamaCppRuntimeAssetsPlugin } from '../src/features/llama-cpp-browser/build-runtime-assets';
import { createLlamaCppBrowserBuild } from '../src/features/llama-cpp-browser/build-core';
import { createNaidanStandalonePlugin } from './file-protocol-standalone/plugin';
import { createFileProtocolStandaloneWorkerDefinitions } from './file-protocol-standalone/worker-definitions';
import { createRequire } from 'node:module';
import { createStandaloneFacadeAliases } from './standalone-facades.js';

async function bundleFeature({ standalone }: { standalone: boolean }): Promise<{ output: Rollup.OutputBundle, workerCores: string[] }> {
  const workerCores = new Set<string>();
  const entry: Plugin = {
    name: 'llama-feature-build-fixture',
    resolveId(id) {
      if (id === 'virtual:llama-build-fixture') return '\0llama-build-fixture';
    },
    load(id) {
      if (id === '\0llama-build-fixture') return `
        export { llamaCppBrowserService } from '@/features/llama-cpp-browser';
        export { LlamaCppBrowserProvider } from '@/features/llama-cpp-browser/provider';
        export { createLlamaCppWorkerClient } from '@/features/llama-cpp-browser/worker/client';
      `;
    },
  };
  const fixtureRoot = standalone ? mkdtempSync(path.join(os.tmpdir(), 'naidan-llama-standalone-')) : undefined;
  if (fixtureRoot) {
    writeFileSync(path.join(fixtureRoot, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"></head><body><script type="module" src="./main.js"></script></body></html>');
    writeFileSync(path.join(fixtureRoot, 'main.js'), "import * as feature from 'virtual:llama-build-fixture'; globalThis.feature = feature;");
  }
  const adapter = createLlamaCppBrowserBuild({ rootDir: process.cwd(), mode: standalone ? 'standalone' : 'hosted' });
  try {
    const result = await build({
      configFile: false, root: fixtureRoot ?? process.cwd(), base: './', logLevel: 'silent',
      plugins: [entry, adapter.corePlugin, ...(standalone ? [createNaidanStandalonePlugin({
        workers: createFileProtocolStandaloneWorkerDefinitions({ resolvePath: relative => path.resolve(relative) }).filter(worker => worker.name.startsWith('llama-cpp-browser')),
        systemRuntimePath: createRequire(import.meta.url).resolve('systemjs/dist/system.min.js'),
        sourceAudit: { mode: 'inline' }, embeddedBinaries: adapter.embeddedBinaries,
      })] : [createLlamaCppRuntimeAssetsPlugin({ rootDir: process.cwd() })])],
      define: { __BUILD_MODE_IS_TEST__: 'false', __BUILD_MODE_IS_STANDALONE__: JSON.stringify(standalone), __BUILD_MODE_IS_HOSTED__: JSON.stringify(!standalone) },
      resolve: { alias: [...(standalone ? createStandaloneFacadeAliases({ resolvePath: (relative: string) => path.resolve(relative) }) : []), { find: '@', replacement: path.resolve('src') }] },
      worker: { format: 'es', plugins: () => [createLlamaCppBrowserBuild({ rootDir: process.cwd(), mode: 'hosted' }).corePlugin, {
        name: 'llama-worker-provenance-fixture',
        generateBundle(_options, output) {
          for (const file of Object.values(output)) {
            if (file.type !== 'chunk') continue;
            for (const id of Object.keys(file.modules)) if (id.includes('llama-cpp-browser-core/profiles/')) workerCores.add(id);
          }
        },
      }] },
      build: { write: false, minify: false, emptyOutDir: false, reportCompressedSize: false,
        rollupOptions: { input: fixtureRoot ? path.join(fixtureRoot, 'index.html') : 'virtual:llama-build-fixture', preserveEntrySignatures: 'strict' } },
    });
    const resultList = Array.isArray(result) ? result : [result];
    const files = resultList.flatMap(item => {
      if (!('output' in item)) throw new Error('Unexpected watch result');
      return item.output;
    });
    return { output: Object.fromEntries(files.map(file => [file.fileName, file])), workerCores: [...workerCores] };
  } finally {
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  }
}
describe('llama.cpp runtime distribution boundary', () => {
  it('embeds only the selected standalone core and keeps external runtime assets absent', async () => {
    const { output } = await bundleFeature({ standalone: true });
    const modules = Object.values(output).flatMap(file => file.type === 'chunk' ? Object.keys(file.modules) : []);
    expect(modules.some(name => name.endsWith('llama-cpp-browser/index-standalone.ts'))).toBe(true);
    expect(modules.filter(name => name.includes('llama-cpp-browser-core/profiles/'))).toEqual([path.resolve('node_modules/llama-cpp-browser-core/profiles/webgpu-wasm64-jspi/core.mjs')]);
    expect(modules.some(name => name.includes('client-hosted') || name.endsWith('runtime/artifacts.ts'))).toBe(false);
    expect(modules.some(name => name.endsWith('model-store.ts'))).toBe(true);
    expect(modules.some(name => name.endsWith('detect-profile-standalone.ts'))).toBe(true);
    expect(modules.some(name => name.endsWith('worker/entry.ts'))).toBe(true);
    expect(Object.keys(output).some(name => name.includes('llama-cpp-browser-runtime') || name.endsWith('.wasm') || name.endsWith('.wasm.gz') || name.endsWith('.wasm.br'))).toBe(false);
  }, 90_000);
  it('bundles all four transformed hosted cores with lossless compressed Wasm assets', async () => {
    const { output, workerCores } = await bundleFeature({ standalone: false });
    for (const profile of ['cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm64-jspi', 'webgpu-wasm32-asyncify']) {
      const prefix = `llama-cpp-browser-runtime/profiles/${profile}/`;
      const wasm = output[prefix + 'core.wasm.gz'];
      expect(output[prefix + 'core.mjs']).toBeUndefined();
      expect(wasm?.type).toBe('asset');
      if (!wasm || wasm.type !== 'asset') throw new Error('Missing built Wasm asset');
      expect(gunzipSync(wasm.source).equals(readFileSync(`node_modules/llama-cpp-browser-core/profiles/${profile}/core.wasm`))).toBe(true);
      expect(output[prefix + 'core.wasm']).toBeUndefined();
      expect(output[prefix + 'core.wasm.br']).toBeUndefined();
    }
    expect(Object.keys(output).some(name => name.includes('entry-') && name.endsWith('.js'))).toBe(true);
    const javascript = Object.values(output).filter(file => file.fileName.endsWith('.js')).map(file => file.type === 'chunk' ? file.code : Buffer.from(file.source).toString('utf8'));
    expect(workerCores.sort()).toEqual(['cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm32-asyncify', 'webgpu-wasm64-jspi'].map(profile => path.resolve(`node_modules/llama-cpp-browser-core/profiles/${profile}/core.mjs`)).sort());
    expect(javascript.filter(source => source.includes('Browser core requires supplied wasmBinary'))).toHaveLength(4);
    expect(javascript.some(source => source.includes('browser-external') || source.includes('node:module'))).toBe(false);
  }, 45000);
});
