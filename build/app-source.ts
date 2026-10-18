// !!! ALLOW-EXTERNAL-COMMAND git rev-parse:* !!! -- Observe this checkout's source identity during builds.
// !!! ALLOW-EXTERNAL-COMMAND git status:* !!! -- Observe this checkout's working tree during builds.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runCommandSync } from './command';

type AppSourceIdentity = {
  sourceCommit: string | undefined,
  workingTree: 'clean' | 'dirty' | 'unknown',
};

/** Source-checkout observation when Vite loads its config, not a hash of built bytes. */
export function readAppSource({ rootDir, environment }: { rootDir: string, environment: Readonly<NodeJS.ProcessEnv> }): AppSourceIdentity {
  const gitDir = path.join(rootDir, '.git');
  // A source archive can be nested inside an unrelated repository.
  if (!existsSync(gitDir)) {
    return { sourceCommit: undefined, workingTree: 'unknown' };
  }
  // Observe this checkout's own index, not an index supplied by a parent tool.
  const env: NodeJS.ProcessEnv = { ...environment, GIT_DIR: gitDir, GIT_WORK_TREE: rootDir };
  delete env.GIT_INDEX_FILE;
  const options = { cwd: rootDir, env, encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'] } satisfies Parameters<typeof runCommandSync>[0]['options'];
  let sourceCommit: string;
  try {
    const result = runCommandSync({ argv: ['git', 'rev-parse', '--verify', 'HEAD'], options });
    if (result.error || result.status !== 0 || result.signal || typeof result.stdout !== 'string') {
      return { sourceCommit: undefined, workingTree: 'unknown' };
    }
    sourceCommit = result.stdout.trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceCommit)) {
      return { sourceCommit: undefined, workingTree: 'unknown' };
    }
  } catch {
    return { sourceCommit: undefined, workingTree: 'unknown' };
  }
  try {
    const result = runCommandSync({ argv: ['git', 'status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=none'], options });
    if (result.error || result.status !== 0 || result.signal || typeof result.stdout !== 'string') {
      return { sourceCommit, workingTree: 'unknown' };
    }
    const status = result.stdout.trim();
    return { sourceCommit, workingTree: status.length ? 'dirty' : 'clean' };
  } catch {
    return { sourceCommit, workingTree: 'unknown' };
  }
}

export function readAppSourceForConfig({ mode, executionContext, rootDir, environment }: {
  mode: string,
  executionContext: 'vitest' | 'vite',
  rootDir: string,
  environment: Readonly<NodeJS.ProcessEnv>,
}): AppSourceIdentity {
  switch (executionContext) {
  case 'vitest':
    return { sourceCommit: undefined, workingTree: 'unknown' };
  case 'vite':
    if (mode === 'test') {
      return { sourceCommit: undefined, workingTree: 'unknown' };
    }
    return readAppSource({ rootDir, environment });
  default: {
    const exhaustive: never = executionContext;
    throw new Error(`Unknown command execution context: ${String(exhaustive)}`);
  }
  }
}

export const TEST_ONLY = {
};
