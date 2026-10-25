import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Copy every chunk, not just the entry: Vue captures document at module load.
export async function copyProductionOutput({ dist }: { dist: string }) {
  const root = await mkdtemp(path.join(tmpdir(), 'docs-production-output-'));
  try {
    const output = path.join(root, 'dist');
    await cp(dist, output, { recursive: true, dereference: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    return {
      dist: output,
      [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
