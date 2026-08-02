import { spawnSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const HIZOFS_ROOT = path.join(ROOT, 'src/00-storage/service/hizofs');
const CRYPTO_ROOT = path.join(HIZOFS_ROOT, '01-crypto');

async function productionTypeScriptFiles({ root }: { root: string }): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
    .map(entry => path.join(entry.parentPath, entry.name))
    .filter(filePath => !filePath.endsWith('.test.ts') && !filePath.includes(`${path.sep}tests${path.sep}`));
}

describe('HizoFS cryptographic authority ownership', () => {
  it('has no old crypto directory or tracked old-path references', async () => {
    await expect(stat(path.join(HIZOFS_ROOT, 'crypto'))).rejects.toMatchObject({ code: 'ENOENT' });
    const oldImportPath = ['hizofs', 'crypto'].join('/');
    const result = spawnSync('git', ['grep', '-nF', oldImportPath, '--', '.'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('keeps raw Web Crypto, authentication errors, and Root Key bytes inside crypto', async () => {
    const violations: string[] = [];
    for (const filePath of await productionTypeScriptFiles({ root: HIZOFS_ROOT })) {
      if (filePath === CRYPTO_ROOT || filePath.startsWith(`${CRYPTO_ROOT}${path.sep}`)) continue;
      const source = await readFile(filePath, 'utf8');
      for (const forbidden of [
        'globalThis.crypto',
        'crypto.subtle',
        'crypto.getRandomValues',
        'OperationError',
        'withFileSystemRootKeyBytes',
      ]) {
        if (source.includes(forbidden)) {
          violations.push(`${path.relative(ROOT, filePath)}: ${forbidden}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps Worker mount grant cryptographic framing out of composition', async () => {
    const compositionPath = path.join(HIZOFS_ROOT, 'worker/composition-root.ts');
    const composition = await readFile(compositionPath, 'utf8');
    for (const forbidden of [
      'hizofs-worker-mount-grant-v1',
      'HizoFSWorkerMountGrantPayloadV1',
      'WORKER_MOUNT_GRANT_ROOT_KEY_BYTES',
      'encodeWorkerMountGrantCleartext',
      'decodeWorkerMountGrantCleartext',
    ]) {
      expect(composition, forbidden).not.toContain(forbidden);
    }

    const owner = await readFile(path.join(CRYPTO_ROOT, 'worker-mount-grant.ts'), 'utf8');
    for (const declaration of [
      'export async function issueHizoFSWorkerMountGrantPayload(',
      'export async function openHizoFSWorkerMountGrantPayload(',
      'export async function deriveContainerCoordinationScopeTokenValue(',
    ]) {
      expect(owner, declaration).toContain(declaration);
    }
  });

  it('does not publish the raw Root Key byte lender', async () => {
    const publicBoundary = await readFile(path.join(CRYPTO_ROOT, 'index.ts'), 'utf8');
    expect(publicBoundary).not.toContain('withFileSystemRootKeyBytes');
  });
});
