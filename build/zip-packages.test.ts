import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';

import { createZipPackages, TEST_ONLY } from './zip-packages';

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-zip-packages-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function readZipEntries({ zipPath }: {
  zipPath: string;
}): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const result = new Map<string, string>();
  for (const [fileName, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    result.set(fileName, await entry.async('string'));
  }
  return result;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('createZipPackages', () => {
  it('creates filtered variants with in-memory file overrides', async () => {
    const root = createTemporaryDirectory();
    const sourceDirectory = path.join(root, 'source');
    const archiveDirectory = path.join(root, 'archives');
    fs.mkdirSync(path.join(sourceDirectory, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(sourceDirectory, 'index.html'), 'canonical');
    fs.writeFileSync(path.join(sourceDirectory, 'assets', 'common.js'), 'common');
    fs.writeFileSync(path.join(sourceDirectory, 'assets', 'en.js'), 'english');

    await createZipPackages({
      sourceDirectory,
      archiveDirectory,
      version: '1.2.3',
      packages: [
        { zipFileName: 'full.zip', folderName: 'full' },
        {
          zipFileName: 'ja.zip',
          folderName: 'ja',
          excludedFileNames: new Set(['assets/en.js']),
          fileOverrides: new Map([['index.html', 'japanese-index']]),
        },
      ],
    });

    const full = await readZipEntries({ zipPath: path.join(archiveDirectory, 'full.zip') });
    expect(full.get('full/index.html')).toBe('canonical');
    expect(full.get('full/assets/en.js')).toBe('english');
    expect(full.get('full/VERSION.txt')).toBe('1.2.3');

    const japanese = await readZipEntries({ zipPath: path.join(archiveDirectory, 'ja.zip') });
    expect(japanese.get('ja/index.html')).toBe('japanese-index');
    expect(japanese.has('ja/assets/en.js')).toBe(false);
    expect(japanese.get('ja/assets/common.js')).toBe('common');
  });

  it('rejects archive paths instead of allowing package definitions to escape their roots', async () => {
    const root = createTemporaryDirectory();
    const sourceDirectory = path.join(root, 'source');
    const archiveDirectory = path.join(root, 'archives');
    fs.mkdirSync(sourceDirectory, { recursive: true });

    await expect(createZipPackages({
      sourceDirectory,
      archiveDirectory,
      version: '1.0.0',
      packages: [{ zipFileName: '../escape.zip', folderName: 'safe' }],
    })).rejects.toThrow(/plain file name/u);
    await expect(createZipPackages({
      sourceDirectory,
      archiveDirectory,
      version: '1.0.0',
      packages: [{ zipFileName: 'safe.zip', folderName: '../escape' }],
    })).rejects.toThrow(/folder name is invalid/u);
  });

  it('rejects duplicate final names before replacing an existing release', async () => {
    const root = createTemporaryDirectory();
    const sourceDirectory = path.join(root, 'source');
    const archiveDirectory = path.join(root, 'archives');
    fs.mkdirSync(sourceDirectory, { recursive: true });
    fs.mkdirSync(archiveDirectory, { recursive: true });
    fs.writeFileSync(path.join(sourceDirectory, 'index.html'), 'next');
    fs.writeFileSync(path.join(archiveDirectory, 'same.zip'), 'previous');

    await expect(createZipPackages({
      sourceDirectory,
      archiveDirectory,
      version: '1.0.0',
      packages: [
        { zipFileName: 'same.zip', folderName: 'one' },
        { zipFileName: 'same.zip', folderName: 'two' },
      ],
    })).rejects.toThrow(/Duplicate ZIP package file name/u);
    expect(fs.readFileSync(path.join(archiveDirectory, 'same.zip'), 'utf8')).toBe('previous');
  });

  it('rolls back already promoted archives when a later promotion fails', () => {
    const root = createTemporaryDirectory();
    const firstFinal = path.join(root, 'first.zip');
    const secondFinal = path.join(root, 'second.zip');
    const firstTemporary = path.join(root, 'first.tmp');
    const missingSecondTemporary = path.join(root, 'missing-second.tmp');
    const firstBackup = path.join(root, 'first.bak');
    const secondBackup = path.join(root, 'second.bak');
    fs.writeFileSync(firstFinal, 'old-first');
    fs.writeFileSync(secondFinal, 'old-second');
    fs.writeFileSync(firstTemporary, 'new-first');

    expect(() => TEST_ONLY.promoteStagedZipPackages({
      staged: [
        { finalPath: firstFinal, temporaryPath: firstTemporary, backupPath: firstBackup },
        { finalPath: secondFinal, temporaryPath: missingSecondTemporary, backupPath: secondBackup },
      ],
    })).toThrow();

    expect(fs.readFileSync(firstFinal, 'utf8')).toBe('old-first');
    expect(fs.readFileSync(secondFinal, 'utf8')).toBe('old-second');
    expect(fs.existsSync(firstBackup)).toBe(false);
    expect(fs.existsSync(secondBackup)).toBe(false);
  });
});
