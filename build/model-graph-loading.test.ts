// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestOnlyBoundaryPlugin } from './test-only-boundary';

const root = fileURLToPath(new URL('../', import.meta.url));

describe('model graph startup dependency boundary', () => {
  it.each([
    'src/features/llama-cpp-browser/worker/types.ts',
    'src/features/llama-cpp-browser/model-graph/request-settings.ts',
  ])('keeps graph authoring/execution out of the eager boundary: %s', async entry => {
    // Build just the protocol/admission boundary, not the Naidan application.
    // Retain its real runtime schema exports so tree shaking cannot conceal
    // an eager dependency on declaration parsing and the operator catalog.
    const result = await build({
      root,
      configFile: false,
      envFile: false,
      logLevel: 'silent',
      plugins: [createTestOnlyBoundaryPlugin()],
      resolve: { alias: { '@': path.join(root, 'src') } },
      define: { __BUILD_MODE_IS_TEST__: 'false' },
      build: {
        write: false,
        minify: true,
        lib: { entry: path.join(root, entry), formats: ['es'] },
        // Storage has its own graph, but may not hide a parser directly
        // imported by the request boundary under test.
        rolldownOptions: { external: ['@/00-storage/service'] },
      },
    });
    const outputs = Array.isArray(result) ? result : [result];
    const modules = outputs.flatMap(output => {
      if (!('output' in output)) {
        throw new Error('Expected a completed protocol bundle');
      }
      return output.output.flatMap(file => file.type === 'chunk' ? Object.keys(file.modules) : []);
    });
    const graphModules = modules.map(id => id.replaceAll('\\', '/')).filter(id => id.includes('/llama-cpp-browser/model-graph/'));
    expect(graphModules).toContain(path.join(root, 'src/features/llama-cpp-browser/model-graph/request-registry.ts').replaceAll('\\', '/'));
    expect(graphModules.every(id => id.endsWith('/request-registry.ts') || id.endsWith('/request-settings.ts'))).toBe(true);
  });
});
