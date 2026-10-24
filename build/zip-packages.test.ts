import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createZipPackages, TEST_ONLY, type ZipPackageDefinition } from './zip-packages';

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
    if (entry.dir) {
      continue;
    }
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

  it('keeps every ZIP byte stable across clocks and reversed filesystem enumeration, including directory entries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    using _clock = {
      [Symbol.dispose]() {
        vi.useRealTimers();
      },
    };
    vi.setSystemTime(new Date('2001-02-03T04:05:06Z'));
    const root = createTemporaryDirectory();
    const sourceDirectory = path.join(root, 'source');
    const archiveDirectory = path.join(root, 'archives');
    fs.mkdirSync(path.join(sourceDirectory, 'assets/deep'), { recursive: true });
    fs.writeFileSync(path.join(sourceDirectory, 'index.html'), 'canonical');
    fs.writeFileSync(path.join(sourceDirectory, 'assets/common.js'), 'common');
    fs.writeFileSync(path.join(sourceDirectory, 'assets/deep/data.bin'), 'data');
    fs.writeFileSync(path.join(sourceDirectory, 'assets/en.js'), 'english');
    const packages: readonly ZipPackageDefinition[] = [
      { zipFileName: 'full.zip', folderName: 'full' },
      {
        zipFileName: 'ja.zip',
        folderName: 'ja',
        excludedFileNames: new Set(['assets/en.js']),
        fileOverrides: new Map([['index.html', 'japanese'], ['assets/common.js', 'shared']]),
      },
    ];
    await createZipPackages({ sourceDirectory, archiveDirectory, version: '1.2.3', packages });
    const first = packages.map(item => fs.readFileSync(path.join(archiveDirectory, item.zipFileName)));

    vi.setSystemTime(new Date('2035-06-07T08:09:10Z'));
    const originalReadDir = fs.readdirSync;
    using _enumeration = vi.spyOn(fs, 'readdirSync').mockImplementation((...args) => {
      // Forward every overload unchanged; reversing an array works for both
      // string and Dirent results. Do not rely on the host filesystem's order.
      const entries = Reflect.apply(originalReadDir, fs, args) as ReturnType<typeof fs.readdirSync>;
      return [...entries].reverse();
    });
    await createZipPackages({
      sourceDirectory,
      archiveDirectory,
      version: '1.2.3',
      packages: packages.map(item => ({
        ...item,
        fileOverrides: item.fileOverrides === undefined ? undefined : new Map([...item.fileOverrides].reverse()),
      })),
    });
    for (const [index, item] of packages.entries()) {
      const bytes = fs.readFileSync(path.join(archiveDirectory, item.zipFileName));
      expect(bytes.equals(first[index]!)).toBe(true);
      const zip = await JSZip.loadAsync(bytes);
      expect(Object.values(zip.files).some(entry => entry.dir)).toBe(true);
      for (const entry of Object.values(zip.files)) {
        expect(entry.date.toISOString()).toBe('1980-01-01T00:00:00.000Z');
      }
      expect(await zip.file(`${item.folderName}/VERSION.txt`)?.async('string')).toBe('1.2.3');
      expect(await zip.file(`${item.folderName}/assets/deep/data.bin`)?.async('string')).toBe('data');
    }
  });

  it('changes only affected archives when file content, VERSION or an override changes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    using _clock = {
      [Symbol.dispose]() {
        vi.useRealTimers();
      },
    };
    vi.setSystemTime(new Date('2001-02-03T04:05:06Z'));
    const root = createTemporaryDirectory();
    const sourceDirectory = path.join(root, 'source');
    const archiveDirectory = path.join(root, 'archives');
    fs.mkdirSync(sourceDirectory, { recursive: true });
    fs.writeFileSync(path.join(sourceDirectory, 'index.html'), 'canonical A');
    const generate = async ({ version, override }: { version: string, override: string }) => {
      await createZipPackages({
        sourceDirectory,
        archiveDirectory,
        version,
        packages: [
          { zipFileName: 'full.zip', folderName: 'full' },
          { zipFileName: 'ja.zip', folderName: 'ja', fileOverrides: new Map([['index.html', override]]) },
        ],
      });
      return {
        full: fs.readFileSync(path.join(archiveDirectory, 'full.zip')),
        ja: fs.readFileSync(path.join(archiveDirectory, 'ja.zip')),
      };
    };
    const first = await generate({ version: '1', override: 'japanese A' });
    fs.writeFileSync(path.join(sourceDirectory, 'index.html'), 'canonical B');
    const changedFile = await generate({ version: '1', override: 'japanese A' });
    expect(changedFile.full.equals(first.full)).toBe(false);
    expect(changedFile.ja.equals(first.ja)).toBe(true);
    const changedVersion = await generate({ version: '2', override: 'japanese A' });
    expect(changedVersion.full.equals(changedFile.full)).toBe(false);
    expect(changedVersion.ja.equals(changedFile.ja)).toBe(false);
    const changedOverride = await generate({ version: '2', override: 'japanese B' });
    expect(changedOverride.full.equals(changedVersion.full)).toBe(true);
    expect(changedOverride.ja.equals(changedVersion.ja)).toBe(false);
    const japanese = await readZipEntries({ zipPath: path.join(archiveDirectory, 'ja.zip') });
    expect(japanese.get('ja/index.html')).toBe('japanese B');
    expect(japanese.get('ja/VERSION.txt')).toBe('2');
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
