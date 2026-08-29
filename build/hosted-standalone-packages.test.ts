import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  copyStandalonePackagesToHosted,
  getStandalonePackageFileNames,
} from './hosted-standalone-packages';

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-hosted-standalone-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('copyStandalonePackagesToHosted', () => {
  it('copies the universal package and every locale package as one complete set', () => {
    const root = createTemporaryDirectory();
    const sourceDirectory = path.join(root, 'dist');
    const hostedDirectory = path.join(root, 'hosted');
    const locales = ['en', 'ja'] as const;
    fs.mkdirSync(sourceDirectory, { recursive: true });
    for (const fileName of getStandalonePackageFileNames({ locales })) {
      fs.writeFileSync(path.join(sourceDirectory, fileName), fileName);
    }

    const copiedFileNames = copyStandalonePackagesToHosted({
      sourceDirectory,
      hostedDirectory,
      locales,
    });

    expect(copiedFileNames).toEqual([
      'naidan-standalone.zip',
      'naidan-standalone-en.zip',
      'naidan-standalone-ja.zip',
    ]);
    for (const fileName of copiedFileNames) {
      expect(fs.readFileSync(path.join(hostedDirectory, fileName), 'utf8')).toBe(fileName);
    }
  });

  it('allows a hosted-only build when no standalone package set exists', () => {
    const root = createTemporaryDirectory();
    const sourceDirectory = path.join(root, 'dist');
    const hostedDirectory = path.join(root, 'hosted');
    fs.mkdirSync(sourceDirectory, { recursive: true });

    expect(copyStandalonePackagesToHosted({
      sourceDirectory,
      hostedDirectory,
      locales: ['en', 'ja'],
    })).toEqual([]);
    expect(fs.existsSync(hostedDirectory)).toBe(false);
  });

  it('rejects a partial package set instead of publishing locale links that can 404', () => {
    const root = createTemporaryDirectory();
    const sourceDirectory = path.join(root, 'dist');
    const hostedDirectory = path.join(root, 'hosted');
    fs.mkdirSync(sourceDirectory, { recursive: true });
    fs.writeFileSync(path.join(sourceDirectory, 'naidan-standalone.zip'), 'universal');
    fs.writeFileSync(path.join(sourceDirectory, 'naidan-standalone-en.zip'), 'english');

    expect(() => copyStandalonePackagesToHosted({
      sourceDirectory,
      hostedDirectory,
      locales: ['en', 'ja'],
    })).toThrow(/Missing: naidan-standalone-ja\.zip/u);
    expect(fs.existsSync(hostedDirectory)).toBe(false);
  });
});
