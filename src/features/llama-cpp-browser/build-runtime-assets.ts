import { gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';
import { profileSchema } from './types';
import { readLlamaArtifactPackage } from './build-artifact-package';

/** Copy the installed artifact, never compile llama.cpp as part of Naidan's build. */
export function createLlamaCppRuntimeAssetsPlugin({ rootDir }: { rootDir: string }): Plugin {
  const prefix = 'llama-cpp-browser-runtime/';
  function assets(): Map<string, Uint8Array> {
    const result = new Map<string, Uint8Array>();
    const { readArtifact } = readLlamaArtifactPackage({ rootDir });
    for (const profile of profileSchema.options) {
      const relative = `profiles/${profile}/browser/core.wasm`;
      const { data } = readArtifact({ relative });
      result.set(`profiles/${profile}/core.wasm.gz`, gzipSync(data, { level: 9 }));
    }
    return result;
  }
  return {
    name: 'naidan-llama-cpp-runtime-assets',
    configureServer(server) {
      const files = assets();
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        const base = new URL(server.config.base, 'http://localhost/').pathname;
        const start = `${base}${prefix}`;
        if (!pathname.startsWith(start)) {
          next(); return;
        }
        const relative = pathname.slice(start.length);
        const bytes = files.get(relative);
        if (!bytes) {
          res.statusCode = 404; res.end(); return;
        }
        // The loader explicitly decompresses .gz. Do not add Content-Encoding.
        res.setHeader('Content-Type', relative.endsWith('.gz') ? 'application/gzip' : 'text/javascript');
        res.end(bytes);
      });
    },
    generateBundle() {
      for (const [fileName, bytes] of assets()) {
        this.emitFile({ type: 'asset', fileName: prefix + fileName, source: bytes });
      }
    },
  };
}
export const TEST_ONLY = {
};
