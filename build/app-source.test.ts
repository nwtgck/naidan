// @vitest-environment node
import * as childProcess from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAppSource } from './app-source';

const roots: string[] = [];

function fixture(): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'naidan-app-source-'));
  roots.push(rootDir);
  return rootDir;
}

function git({ rootDir, args }: { rootDir: string, args: string[] }): string {
  return childProcess.execFileSync('git', ['-C', rootDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function checkout(): { rootDir: string, sourceCommit: string } {
  const rootDir = fixture();
  git({ rootDir, args: ['init', '-q'] });
  writeFileSync(path.join(rootDir, 'source.ts'), 'export const value = 1;');
  git({ rootDir, args: ['add', 'source.ts'] });
  git({ rootDir, args: ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'] });
  return { rootDir, sourceCommit: git({ rootDir, args: ['rev-parse', 'HEAD'] }) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const rootDir of roots.splice(0)) rmSync(rootDir, { recursive: true, force: true });
});

describe('Naidan app source identity', () => {
  it('records full HEAD for a clean checkout and a detached worktree', () => {
    const { rootDir, sourceCommit } = checkout();
    expect(readAppSource({ rootDir })).toEqual({ sourceCommit, workingTree: 'clean' });
    const worktree = path.join(fixture(), 'worktree');
    git({ rootDir, args: ['worktree', 'add', '--detach', worktree, 'HEAD'] });
    expect(readAppSource({ rootDir: worktree })).toEqual({ sourceCommit, workingTree: 'clean' });
  });

  it.each(['tracked', 'staged', 'untracked'] as const)('marks %s source changes dirty without exporting paths', change => {
    const { rootDir, sourceCommit } = checkout();
    const file = change === 'untracked' ? 'private-file-name.ts' : 'source.ts';
    writeFileSync(path.join(rootDir, file), 'export const value = 2;');
    if (change === 'staged') git({ rootDir, args: ['add', file] });
    const identity = readAppSource({ rootDir });
    expect(identity).toEqual({ sourceCommit, workingTree: 'dirty' });
    expect(JSON.stringify(identity)).not.toContain(file);
  });

  it('ignores an inherited alternate index without modifying the parent environment', () => {
    const { rootDir, sourceCommit } = checkout();
    const alternateIndex = path.join(rootDir, '.git', 'alternate-index');
    copyFileSync(path.join(rootDir, '.git', 'index'), alternateIndex);
    childProcess.execFileSync('git', ['-C', rootDir, 'update-index', '--assume-unchanged', 'source.ts'], {
      env: { ...process.env, GIT_INDEX_FILE: alternateIndex },
      stdio: 'ignore',
    });
    writeFileSync(path.join(rootDir, 'source.ts'), 'export const value = 2;');
    vi.stubEnv('GIT_INDEX_FILE', alternateIndex);
    expect(git({ rootDir, args: ['status', '--porcelain=v1'] })).toBe('');
    expect(readAppSource({ rootDir })).toEqual({ sourceCommit, workingTree: 'dirty' });
    expect(process.env.GIT_INDEX_FILE).toBe(alternateIndex);
  });

  it('does not borrow a parent repository identity for a source ZIP', () => {
    const { rootDir } = checkout();
    const sourceZip = path.join(rootDir, 'source-zip');
    mkdirSync(sourceZip);
    expect(readAppSource({ rootDir: sourceZip })).toEqual({ sourceCommit: undefined, workingTree: 'unknown' });
  });

  it('returns unknown when Git or HEAD is unavailable', () => {
    const { rootDir } = checkout();
    vi.stubEnv('PATH', '');
    expect(readAppSource({ rootDir })).toEqual({ sourceCommit: undefined, workingTree: 'unknown' });
    vi.unstubAllEnvs();
    const empty = fixture();
    git({ rootDir: empty, args: ['init', '-q'] });
    expect(readAppSource({ rootDir: empty })).toEqual({ sourceCommit: undefined, workingTree: 'unknown' });
  });

  it('retains known HEAD when the working-tree check fails', () => {
    const { rootDir, sourceCommit } = checkout();
    writeFileSync(path.join(rootDir, '.git', 'index'), 'invalid index');
    expect(readAppSource({ rootDir })).toEqual({ sourceCommit, workingTree: 'unknown' });
  });
});
