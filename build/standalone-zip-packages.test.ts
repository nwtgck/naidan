// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { UI_LOCALES } from '../src/01-models/ui-locale';
import { standaloneZipDefinitions } from './standalone-zip-packages';
import { createZipPackages, TEST_ONLY } from './zip-packages';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-standalone-layout-'));
  const sourceDirectory = path.join(root, 'source');
  const archiveDirectory = path.join(root, 'archives');
  fs.mkdirSync(path.join(sourceDirectory, 'assets/file-protocol-standalone'), { recursive: true });
  fs.writeFileSync(path.join(sourceDirectory, 'assets/file-protocol-standalone/system.min.js'), 'runtime');
  fs.writeFileSync(path.join(sourceDirectory, 'index.html'), 'html');
  fs.writeFileSync(path.join(sourceDirectory, 'favicon.svg'), '<svg/>');
  const definitions = standaloneZipDefinitions({
    version: '1.2.3',
    variants: [
      { id: 'all-locales', locale: undefined, indexHtml: 'all', excludedFileNames: [] },
      ...UI_LOCALES.map(locale => ({ id: `locale-${locale}` as const, locale, indexHtml: locale, excludedFileNames: [] })),
    ],
  });
  return {
    root,
    sourceDirectory,
    archiveDirectory,
    definitions,
    write() {
      return createZipPackages({ sourceDirectory, archiveDirectory, version: '1.2.3', packages: definitions });
    },
    [Symbol.dispose]() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('standalone ZIP layout without an application build', () => {
  it('checks the production definitions for the universal and every locale ZIP', async () => {
    using input = fixture();
    await input.write();
    expect(input.definitions).toHaveLength(UI_LOCALES.length + 1);
    for (const definition of input.definitions) {
      expect(definition.layout).toBe('standalone');
      const zip = await JSZip.loadAsync(fs.readFileSync(path.join(input.archiveDirectory, definition.zipFileName)));
      const prefix = `${definition.folderName}/`;
      const depth1 = Object.values(zip.files)
        .filter(entry => entry.name.startsWith(prefix) && entry.name !== prefix)
        .map(entry => entry.name.slice(prefix.length))
        .filter(name => !name.replace(/\/$/u, '').includes('/'))
        .sort();
      expect(depth1).toEqual(['VERSION.txt', 'assets/', 'favicon.svg', 'index.html']);
      expect(await zip.file(`${prefix}VERSION.txt`)?.async('string')).toBe('1.2.3');
      expect(zip.file(`${prefix}assets/file-protocol-standalone/system.min.js`)).not.toBeNull();
    }
  });

  it.each(['llama-cpp-browser-native-licenses.txt', 'robots.txt', 'unknown.js'])('rejects unexpected root file %s', async name => {
    using input = fixture();
    fs.writeFileSync(path.join(input.sourceDirectory, name), 'unexpected');
    await expect(input.write()).rejects.toThrow('depth 1');
    expect(fs.existsSync(input.archiveDirectory)).toBe(false);
  });

  it('rejects the old runtime directory and empty assets after filtering', async () => {
    using input = fixture();
    fs.mkdirSync(path.join(input.sourceDirectory, 'file-protocol-standalone'));
    fs.writeFileSync(path.join(input.sourceDirectory, 'file-protocol-standalone/system.js'), 'old');
    await expect(input.write()).rejects.toThrow('depth 1');
    fs.rmSync(path.join(input.sourceDirectory, 'file-protocol-standalone'), { recursive: true });
    await expect(createZipPackages({
      sourceDirectory: input.sourceDirectory,
      archiveDirectory: input.archiveDirectory,
      version: '1.2.3',
      packages: [{ ...input.definitions[0]!, excludedFileNames: new Set(['assets/file-protocol-standalone/system.min.js']) }],
    })).rejects.toThrow('depth 1');
  });

  it.each(['favicon.svg', 'index.html', 'assets'])('rejects missing required entry %s', async name => {
    using input = fixture();
    fs.rmSync(path.join(input.sourceDirectory, name), { recursive: true });
    await expect(input.write()).rejects.toThrow('depth 1');
  });

  it('rejects wrong entry kinds, source VERSION.txt and missing input', async () => {
    using input = fixture();
    fs.rmSync(path.join(input.sourceDirectory, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(input.sourceDirectory, 'assets'), 'not a directory');
    await expect(input.write()).rejects.toThrow('depth 1');
    fs.writeFileSync(path.join(input.sourceDirectory, 'VERSION.txt'), 'wrong');
    await expect(input.write()).rejects.toThrow('VERSION.txt');
    fs.rmSync(input.sourceDirectory, { recursive: true });
    await expect(input.write()).rejects.toThrow('missing');
  });

  it('rejects linked files and directories instead of following them', async () => {
    using input = fixture();
    fs.symlinkSync(input.root, path.join(input.sourceDirectory, 'assets/escape'));
    await expect(input.write()).rejects.toThrow('regular');
  });

  it('does not publish earlier variants when a later locale violates the contract', async () => {
    using input = fixture();
    await input.write();
    const before = new Map(input.definitions.map(definition => [definition.zipFileName, fs.readFileSync(path.join(input.archiveDirectory, definition.zipFileName))]));
    await expect(createZipPackages({
      sourceDirectory: input.sourceDirectory,
      archiveDirectory: input.archiveDirectory,
      version: 'changed',
      packages: input.definitions.map((definition, index) => index === 1
        ? { ...definition, excludedFileNames: new Set(['favicon.svg']) }
        : definition),
    })).rejects.toThrow('depth 1');
    for (const [name, content] of before) {
      expect(fs.readFileSync(path.join(input.archiveDirectory, name))).toEqual(content);
    }
    expect(fs.readdirSync(input.archiveDirectory).sort()).toEqual([...before.keys()].sort());
  });

  it('checks actual archive types, outside entries and a missing generated VERSION.txt', () => {
    const zip = new JSZip();
    zip.file('app/assets/a.js', 'asset');
    zip.file('app/index.html', 'html');
    zip.file('app/favicon.svg', 'icon');
    expect(() => TEST_ONLY.assertStandaloneZipLayout({ zip, folderName: 'app' })).toThrow('depth 1');
    zip.file('app/VERSION.txt', 'v');
    expect(() => TEST_ONLY.assertStandaloneZipLayout({ zip, folderName: 'app' })).not.toThrow();
    zip.file('outside.txt', 'escape');
    expect(() => TEST_ONLY.assertStandaloneZipLayout({ zip, folderName: 'app' })).toThrow('outside');
  });
});
