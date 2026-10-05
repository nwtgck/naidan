// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { build } from 'vite';
import { createNaidanStandalonePlugin } from './file-protocol-standalone/plugin';
import { createFileProtocolStandaloneWorkerDefinitions } from './file-protocol-standalone/worker-definitions';

const projectRoot = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
it('packages the real image query workers and clients through the standalone SystemJS graph without inference modules', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-image-query-standalone-'));
  try {
    fs.symlinkSync(path.join(projectRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><head></head><body><script type="module" src="/main.ts"></script></body></html>');
    fs.writeFileSync(path.join(root, 'main.ts'), `\
import { createImageHistoryClient } from '@/features/image-generation/history/worker/client-standalone';
import { createImageGenerationQueryClient } from '@/features/image-generation/session/query-worker/client-standalone';
// Entry-only fixture: the clients, Worker entries, storage and packager below
// are real production modules. No virtual Worker factory or native stub.
globalThis.imageQueryClients = { createImageHistoryClient, createImageGenerationQueryClient };
`);
    const workers = createFileProtocolStandaloneWorkerDefinitions({ resolvePath: relativePath => path.join(projectRoot, relativePath) })
      .filter(worker => worker.name === 'image-history-worker' || worker.name === 'image-generation-query-worker');
    expect(workers).toHaveLength(2);
    const result = await build({ configFile: false, root, base: './', logLevel: 'silent',
      resolve: { alias: { '@': path.join(projectRoot, 'src') } },
      define: { __BUILD_MODE_IS_STANDALONE__: 'true', __BUILD_MODE_IS_HOSTED__: 'false', __BUILD_MODE_IS_TEST__: 'false' },
      plugins: [createNaidanStandalonePlugin({ workers, systemRuntimePath: require.resolve('systemjs/dist/system.min.js') })],
      build: { write: false, minify: false, assetsInlineLimit: 0, modulePreload: false,
        rolldownOptions: { output: { entryFileNames: 'assets/[name]-[hash].js', chunkFileNames: 'assets/[name]-[hash].js' } } },
    });
    if (!('output' in result)) throw new Error('Expected one isolated build output.');
    const chunks = result.output.filter(item => item.type === 'chunk');
    const modules = chunks.flatMap(chunk => Object.keys(chunk.modules)).map(id => id.replaceAll('\\', '/'));
    for (const worker of workers) expect(modules).toContain(worker.entry);
    expect(modules.some(id => id.endsWith('/image-generation/history/worker/impl.ts'))).toBe(true);
    expect(modules.some(id => id.endsWith('/image-generation/session/query-worker/impl.ts'))).toBe(true);
    const forbidden = modules.filter(id => /\/(?:llama-cpp-browser|transformers-js)\//u.test(id)
      || /\/stable-diffusion-cpp-browser\/(?:worker|runtime|inference)\//u.test(id)
      || /(?:llama-cpp-browser-core|stable-diffusion-cpp-browser-core)/u.test(id));
    expect(forbidden).toEqual([]);
    expect(result.output.filter(item => /\.wasm(?:\.|$)/iu.test(item.fileName))).toEqual([]);
    for (const chunk of chunks) expect(chunk.code).toContain('System.register(');
    const html = result.output.find(item => item.type === 'asset' && item.fileName === 'index.html');
    if (!html || html.type !== 'asset') throw new Error('Missing standalone entry HTML.');
    expect(String(html.source)).not.toContain('type="module"');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60000);
