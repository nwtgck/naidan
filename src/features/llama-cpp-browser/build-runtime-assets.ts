import type { Plugin } from 'vite';
import { createGzipAsset } from '../../../build/gzip-asset';
import { readQ8DiagnosticArtifact, type readLlamaArtifactPackage } from './build-artifact-package';
import { gpuProfilingProfile, type LlamaCppProfile } from './types';

/** Copy the installed artifact, never compile llama.cpp as part of Naidan's build. */
export function createLlamaCppRuntimeAssetsPlugin({ artifact, profiles }: { artifact: ReturnType<typeof readLlamaArtifactPackage>, profiles: readonly LlamaCppProfile[] }): Plugin {
  const prefix = 'llama-cpp-browser-runtime/';
  function assets(): Map<string, () => Promise<Uint8Array>> {
    const result = new Map<string, () => Promise<Uint8Array>>();
    for (const profile of profiles) {
      const relative = `profiles/${profile}/browser/core.wasm`;
      result.set(`profiles/${profile}/core.wasm.gz`, createGzipAsset({ read: () => artifact.readArtifact({ relative }).data }));
    }
    if (profiles.includes(gpuProfilingProfile)) {
      const diagnostic = readQ8DiagnosticArtifact({ artifact });
      if (diagnostic) {
        result.set(`profiles/${gpuProfilingProfile}/q8-diagnostic-v1.schema.json`, async () => artifact.readArtifact({ relative: diagnostic.relative }).data);
      }
    }
    return result;
  }
  let files = assets();
  return {
    name: 'naidan-llama-cpp-runtime-assets',
    buildStart() {
      files = assets();
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        const base = new URL(server.config.base, 'http://localhost/').pathname;
        const start = `${base}${prefix}`;
        if (!pathname.startsWith(start)) {
          next();
          return;
        }
        const relative = pathname.slice(start.length);
        const readAsset = files.get(relative);
        if (readAsset === undefined) {
          res.statusCode = 404;
          res.end();
          return;
        }
        void readAsset().then(bytes => {
          // The loader explicitly decompresses .gz. Do not add Content-Encoding.
          res.setHeader('Content-Type', relative.endsWith('.gz') ? 'application/gzip' : 'application/json');
          res.end(bytes);
        }, next);
      });
    },
    async generateBundle() {
      for (const [fileName, readAsset] of files) {
        this.emitFile({ type: 'asset', fileName: prefix + fileName, source: await readAsset() });
      }
    },
  };
}

export const TEST_ONLY = {
};
