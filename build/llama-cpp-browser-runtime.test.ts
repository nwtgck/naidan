// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { build, type Plugin, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';
import { createLlamaCppRuntimeAssetsPlugin } from '../src/features/llama-cpp-browser/build-runtime-assets';
import { createStandaloneFacadeAliases } from './standalone-facades.js';

async function bundleFeature({ standalone }: { standalone: boolean }): Promise<Rollup.OutputBundle> {
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
  const result = await build({
    configFile: false, root: process.cwd(), base: './', logLevel: 'silent',
    plugins: [entry, ...(!standalone ? [createLlamaCppRuntimeAssetsPlugin({ rootDir: process.cwd() })] : [])],
    define: { __BUILD_MODE_IS_TEST__: 'false', __BUILD_MODE_IS_STANDALONE__: JSON.stringify(standalone), __BUILD_MODE_IS_HOSTED__: JSON.stringify(!standalone) },
    resolve: { alias: [...(standalone ? createStandaloneFacadeAliases({ resolvePath: (relative: string) => path.resolve(relative) }) : []), { find: '@', replacement: path.resolve('src') }] },
    worker: { format: 'es' },
    build: { write: false, minify: false, emptyOutDir: false, reportCompressedSize: false,
      rollupOptions: { input: 'virtual:llama-build-fixture', preserveEntrySignatures: 'strict' } },
  });
  const resultList = Array.isArray(result) ? result : [result];
  const files = resultList.flatMap(item => {
    if (!('output' in item)) throw new Error('Unexpected watch result');
    return item.output;
  });
  return Object.fromEntries(files.map(file => [file.fileName, file]));
}
describe('llama.cpp runtime distribution boundary', () => {
  it('keeps visible standalone facades without hosted workers, OPFS or core artifacts', async () => {
    const output = await bundleFeature({ standalone: true });
    const modules = Object.values(output).flatMap(file => file.type === 'chunk' ? Object.keys(file.modules) : []);
    expect(modules.some(name => name.endsWith('llama-cpp-browser/index-standalone.ts'))).toBe(true);
    expect(modules.some(name => name.includes('llama-cpp-browser-core'))).toBe(false);
    expect(modules.some(name => name.includes('client-hosted') || name.includes('index-hosted') || name.includes('model-store') || name.includes('detect-profile') || name.includes('worker/entry'))).toBe(false);
    expect(Object.keys(output).some(name => name.includes('llama-cpp-browser-runtime') || name.endsWith('.wasm') || name.endsWith('.wasm.gz'))).toBe(false);
  }, 30000);
  it('ships each original hosted runtime module with a lossless compressed Wasm asset', async () => {
    const output = await bundleFeature({ standalone: false });
    for (const profile of ['cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm64-jspi', 'webgpu-wasm32-asyncify']) {
      const prefix = `llama-cpp-browser-runtime/profiles/${profile}/`;
      const wasm = output[prefix + 'core.wasm.gz'];
      const module = output[prefix + 'core.mjs'];
      expect(wasm?.type).toBe('asset'); expect(module?.type).toBe('asset');
      if (!wasm || wasm.type !== 'asset' || !module || module.type !== 'asset') throw new Error('Missing built runtime assets');
      expect(gunzipSync(wasm.source).equals(readFileSync(`node_modules/llama-cpp-browser-core/profiles/${profile}/core.wasm`))).toBe(true);
      expect(Buffer.from(module.source).equals(readFileSync(`node_modules/llama-cpp-browser-core/profiles/${profile}/core.mjs`))).toBe(true);
      expect(output[prefix + 'core.wasm']).toBeUndefined();
    }
    expect(Object.keys(output).some(name => name.includes('entry-') && name.endsWith('.js'))).toBe(true);
  }, 45000);
});
