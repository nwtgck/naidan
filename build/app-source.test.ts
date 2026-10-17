// @vitest-environment node
// !!! ALLOW-EXTERNAL-COMMAND git init:* !!! -- Create temporary checkout fixtures.
// !!! ALLOW-EXTERNAL-COMMAND git add:* !!! -- Stage fixture files.
// !!! ALLOW-EXTERNAL-COMMAND git commit:* !!! -- Create fixture commits.
// !!! ALLOW-EXTERNAL-COMMAND git rev-parse:* !!! -- Read fixture commit identities.
// !!! ALLOW-EXTERNAL-COMMAND git status:* !!! -- Observe fixture working trees.
// !!! ALLOW-EXTERNAL-COMMAND git update-index:* !!! -- Prepare an alternate fixture index.
// !!! ALLOW-EXTERNAL-COMMAND git worktree add:* !!! -- Verify a detached temporary fixture worktree.
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAppSource } from './app-source';
import { runCommandSync } from './command';

const roots: string[] = [];
let gitSettings: string | undefined;

function fixture(): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'naidan-app-source-'));
  roots.push(rootDir);
  return rootDir;
}

function fixtureGitOptions({ rootDir, indexFile }: { rootDir: string, indexFile: string | undefined }): Omit<SpawnSyncOptionsWithStringEncoding, 'shell'> {
  if (gitSettings === undefined) {
    gitSettings = fixture();
    writeFileSync(path.join(gitSettings, 'config'), '');
    mkdirSync(path.join(gitSettings, 'template'));
    mkdirSync(path.join(gitSettings, 'hooks'));
  }
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key)));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_SYSTEM = path.join(gitSettings, 'config');
  env.GIT_CONFIG_GLOBAL = path.join(gitSettings, 'config');
  env.GIT_TEMPLATE_DIR = path.join(gitSettings, 'template');
  const configs = [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid'], ['core.hooksPath', path.join(gitSettings, 'hooks')], ['core.fsmonitor', 'false'], ['commit.gpgsign', 'false']];
  env.GIT_CONFIG_COUNT = String(configs.length);
  for (const [index, [key, value]] of configs.entries()) {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  if (indexFile !== undefined) {
    env.GIT_INDEX_FILE = indexFile;
  }
  return { cwd: rootDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 64 * 1024 };
}

function checkedGit({ result }: { result: SpawnSyncReturns<string> }): string {
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 || result.signal || typeof result.stdout !== 'string') {
    throw new Error(`Git fixture command failed with status ${result.status}: ${String(result.stderr)}`);
  }
  return result.stdout.trim();
}

function readSource({ rootDir }: { rootDir: string }) {
  const options = fixtureGitOptions({ rootDir, indexFile: process.env.GIT_INDEX_FILE });
  return readAppSource({ rootDir, environment: options.env ?? {} });
}

function checkout(): { rootDir: string, sourceCommit: string } {
  const rootDir = fixture();
  checkedGit({ result: runCommandSync({ argv: ['git', 'init', '-q'], options: fixtureGitOptions({ rootDir, indexFile: undefined }) }) });
  writeFileSync(path.join(rootDir, 'source.ts'), 'export const value = 1;');
  checkedGit({ result: runCommandSync({ argv: ['git', 'add', 'source.ts'], options: fixtureGitOptions({ rootDir, indexFile: undefined }) }) });
  checkedGit({ result: runCommandSync({ argv: ['git', 'commit', '-qm', 'fixture'], options: fixtureGitOptions({ rootDir, indexFile: undefined }) }) });
  return { rootDir, sourceCommit: checkedGit({ result: runCommandSync({ argv: ['git', 'rev-parse', 'HEAD'], options: fixtureGitOptions({ rootDir, indexFile: undefined }) }) }) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const rootDir of roots.splice(0)) {
    rmSync(rootDir, { recursive: true, force: true });
  }
  gitSettings = undefined;
});

describe('Naidan app source identity', () => {
  it('records full HEAD for a clean checkout and a detached worktree', () => {
    const { rootDir, sourceCommit } = checkout();
    expect(readSource({ rootDir })).toEqual({ sourceCommit, workingTree: 'clean' });
    const worktree = path.join(fixture(), 'worktree');
    checkedGit({ result: runCommandSync({ argv: ['git', 'worktree', 'add', '--detach', worktree, 'HEAD'], options: fixtureGitOptions({ rootDir, indexFile: undefined }) }) });
    expect(readSource({ rootDir: worktree })).toEqual({ sourceCommit, workingTree: 'clean' });
  });

  it.each(['tracked', 'staged', 'untracked'] as const)('marks %s source changes dirty without exporting paths', change => {
    const { rootDir, sourceCommit } = checkout();
    const file = change === 'untracked' ? 'private-file-name.ts' : 'source.ts';
    writeFileSync(path.join(rootDir, file), 'export const value = 2;');
    if (change === 'staged') {
      checkedGit({ result: runCommandSync({ argv: ['git', 'add', file], options: fixtureGitOptions({ rootDir, indexFile: undefined }) }) });
    }
    const identity = readSource({ rootDir });
    expect(identity).toEqual({ sourceCommit, workingTree: 'dirty' });
    expect(JSON.stringify(identity)).not.toContain(file);
  });

  it('ignores an inherited alternate index without modifying the parent environment', () => {
    const { rootDir, sourceCommit } = checkout();
    const alternateIndex = path.join(rootDir, '.git', 'alternate-index');
    copyFileSync(path.join(rootDir, '.git', 'index'), alternateIndex);
    checkedGit({ result: runCommandSync({ argv: ['git', 'update-index', '--assume-unchanged', 'source.ts'], options: fixtureGitOptions({ rootDir, indexFile: alternateIndex }) }) });
    writeFileSync(path.join(rootDir, 'source.ts'), 'export const value = 2;');
    vi.stubEnv('GIT_INDEX_FILE', alternateIndex);
    expect(checkedGit({ result: runCommandSync({ argv: ['git', 'status', '--porcelain=v1'], options: fixtureGitOptions({ rootDir, indexFile: alternateIndex }) }) })).toBe('');
    expect(readSource({ rootDir })).toEqual({ sourceCommit, workingTree: 'dirty' });
    expect(process.env.GIT_INDEX_FILE).toBe(alternateIndex);
  });

  it('does not borrow a parent repository identity for a source ZIP', () => {
    const { rootDir } = checkout();
    const sourceZip = path.join(rootDir, 'source-zip');
    mkdirSync(sourceZip);
    expect(readSource({ rootDir: sourceZip })).toEqual({ sourceCommit: undefined, workingTree: 'unknown' });
  });

  it('returns unknown when Git or HEAD is unavailable', () => {
    const { rootDir } = checkout();
    vi.stubEnv('PATH', '');
    expect(readSource({ rootDir })).toEqual({ sourceCommit: undefined, workingTree: 'unknown' });
    vi.unstubAllEnvs();
    const empty = fixture();
    checkedGit({ result: runCommandSync({ argv: ['git', 'init', '-q'], options: fixtureGitOptions({ rootDir: empty, indexFile: undefined }) }) });
    expect(readSource({ rootDir: empty })).toEqual({ sourceCommit: undefined, workingTree: 'unknown' });
  });

  it('retains known HEAD when the working-tree check fails', () => {
    const { rootDir, sourceCommit } = checkout();
    writeFileSync(path.join(rootDir, '.git', 'index'), 'invalid index');
    expect(readSource({ rootDir })).toEqual({ sourceCommit, workingTree: 'unknown' });
  });
});
