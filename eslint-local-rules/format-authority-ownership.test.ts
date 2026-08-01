import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const FORBIDDEN_AUTHORITY_PATHS = [
  'build/hizofs-format-codegen',
  'src/00-storage/service/hizofs/00-format/v1/registry.json',
  'src/00-storage/service/hizofs/00-format/v1/generated',
  'src/00-storage/service/naidan-persistence-control/00-format/registry.json',
  'src/00-storage/service/naidan-persistence-control/00-format/generated',
] as const;

async function exists({ relativePath }: { relativePath: string }): Promise<boolean> {
  try {
    await stat(path.join(ROOT, relativePath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

describe('production format authority ownership', () => {
  it('keeps production authority in reviewed TypeScript owner modules', async () => {
    for (const relativePath of FORBIDDEN_AUTHORITY_PATHS) {
      expect(await exists({ relativePath }), relativePath).toBe(false);
    }
  });

  it('does not make format authority depend on a Vite generator', async () => {
    const viteConfig = await readFile(path.join(ROOT, 'vite.config.ts'), 'utf8');
    expect(viteConfig).not.toContain('createHizofsFormatCodegenPlugin');
    expect(viteConfig).not.toContain('build/hizofs-format-codegen');
  });

  it('does not import generated format-authority paths', async () => {
    const result = spawnSync(
      'git',
      ['grep', '-nE', '/generated/|\\.generated(\\.|["\'`])', '--', 'src', 'build', 'vite.config.ts'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });
});
