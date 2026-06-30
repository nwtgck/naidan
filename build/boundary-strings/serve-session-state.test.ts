import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe('Boundary Strings process serve state', () => {
  it('survives module recreation and removes paths that already returned', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-boundary-session-'));
    temporaryDirectories.push(root);
    const missingSourcePath = path.join(root, 'src/example.ts');

    const firstModule = await import('./serve-session-state');
    const firstState = firstModule.boundaryStringProcessServeState({ root });
    firstState.missingSourcePaths.add(missingSourcePath);

    vi.resetModules();
    const reloadedModule = await import('./serve-session-state');
    const reloadedState = reloadedModule.boundaryStringProcessServeState({ root });

    expect(reloadedState).toBe(firstState);
    expect(reloadedState.missingSourcePaths).toEqual(new Set([missingSourcePath]));

    fs.mkdirSync(path.dirname(missingSourcePath), { recursive: true });
    fs.writeFileSync(missingSourcePath, 'export const value = 1;\n');

    expect(reloadedModule.boundaryStringProcessServeState({ root }).missingSourcePaths)
      .toEqual(new Set());
  });

  it('separates different project roots', async () => {
    const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-boundary-session-a-'));
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-boundary-session-b-'));
    temporaryDirectories.push(firstRoot, secondRoot);
    const { boundaryStringProcessServeState } = await import('./serve-session-state');

    expect(boundaryStringProcessServeState({ root: firstRoot }))
      .not.toBe(boundaryStringProcessServeState({ root: secondRoot }));
  });
});
