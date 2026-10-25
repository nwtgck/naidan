import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/** Refuse Node environment readers even when reached through a facade or a worker. */
export function createNodeEnvBoundaryPlugin({ rootDir }: { rootDir: string }): Plugin {
  function physicalPath({ id }: { id: string }): string {
    const clean = id.replaceAll('\\', '/').split(/[?#]/u, 1)[0] ?? '';
    let absolute = clean.startsWith('file:') ? fileURLToPath(clean) : clean;
    if (clean.startsWith('/@fs/')) {
      const filePath = clean.slice('/@fs/'.length);
      absolute = filePath.startsWith('/') || /^[a-z]:\//iu.test(filePath) ? filePath : `/${filePath}`;
    }
    absolute = path.resolve(absolute);
    try {
      return realpathSync(absolute);
    } catch {
      return absolute;
    }
  }
  const registry = physicalPath({ id: path.resolve(rootDir, 'build/node-env.ts') });
  function check({ id }: { id: string }): void {
    if (physicalPath({ id }) === registry) {
      throw new Error(`Node environment registry reached a browser bundle: ${id}`);
    }
  }
  return {
    name: 'naidan-node-env-boundary',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source.startsWith('.') && importer && !importer.startsWith('\0')) {
        const resolved = path.resolve(path.dirname(importer.split(/[?#]/u, 1)[0] ?? importer), source.split(/[?#]/u, 1)[0] ?? source);
        for (const candidate of [resolved, `${resolved}.ts`, resolved.replace(/\.js$/u, '.ts')]) {
          check({ id: candidate });
        }
      } else if (path.isAbsolute(source) || source.startsWith('file:')) {
        check({ id: source });
      }
      return undefined;
    },
    load(id) {
      if (!id.startsWith('\0')) {
        check({ id });
      }
      return undefined;
    },
    transform(_code, id) {
      if (!id.startsWith('\0')) {
        check({ id });
      }
      return undefined;
    },
  };
}
