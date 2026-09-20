import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { z } from 'zod';
import type { Plugin } from 'vite';

const manifestSchema = z.object({
  files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
});
/** Copy the installed artifact, never compile llama.cpp as part of Naidan's build. */
export function createLlamaCppRuntimeAssetsPlugin({ rootDir }: { rootDir: string }): Plugin {
  const artifact = path.join(rootDir, 'node_modules/llama-cpp-browser-core');
  const prefix = 'llama-cpp-browser-runtime/';
  const manifest = (): z.infer<typeof manifestSchema> => manifestSchema.parse(JSON.parse(readFileSync(path.join(artifact, 'manifest.json'), 'utf8')));
  const safePath = ({ relative }: { relative: string }): string => {
    if (!/^profiles\/[a-z0-9-]+\/[a-zA-Z0-9._-]+$/.test(relative)) throw new Error('Invalid core artifact path');
    return path.join(artifact, relative);
  };
  function assets(): Map<string, Uint8Array> {
    const result = new Map<string, Uint8Array>();
    for (const file of manifest().files) {
      if (!file.path.startsWith('profiles/')) continue;
      const bytes = readFileSync(safePath({ relative: file.path }));
      if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Core artifact integrity mismatch');
      result.set(file.path.endsWith('.wasm') ? file.path + '.gz' : file.path,
        file.path.endsWith('.wasm') ? gzipSync(bytes, { level: 9 }) : bytes);
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
