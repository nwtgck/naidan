import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Source-checkout observation when Vite loads its config, not a hash of built bytes. */
export function readAppSource({ rootDir }: { rootDir: string }): {
  sourceCommit: string | undefined,
  workingTree: 'clean' | 'dirty' | 'unknown',
} {
  const gitDir = path.join(rootDir, '.git');
  // A source archive can be nested inside an unrelated repository.
  if (!existsSync(gitDir)) return { sourceCommit: undefined, workingTree: 'unknown' };
  // Observe this checkout's own index, not an index supplied by a parent tool.
  const env = { ...process.env };
  delete env.GIT_INDEX_FILE;
  const git = ({ args }: { args: string[] }): string => execFileSync('git', [
    '--git-dir', gitDir, '--work-tree', rootDir, ...args,
  ], { cwd: rootDir, env, encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let sourceCommit: string;
  try {
    sourceCommit = git({ args: ['rev-parse', '--verify', 'HEAD'] });
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceCommit)) return { sourceCommit: undefined, workingTree: 'unknown' };
  } catch {
    return { sourceCommit: undefined, workingTree: 'unknown' };
  }
  try {
    const status = git({ args: ['status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=none'] });
    return { sourceCommit, workingTree: status.length ? 'dirty' : 'clean' };
  } catch {
    return { sourceCommit, workingTree: 'unknown' };
  }
}

export const TEST_ONLY = {
};
