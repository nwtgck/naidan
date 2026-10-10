// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { synchronizeStringCatalogs } from './generate-catalogs';
import {
  BOUNDARY_STRING_LOCALES,
  createBoundaryStringProjectPaths,
  readBoundaryStringMessageCatalog,
  type BoundaryStringLocale,
} from './message-catalog';

const temporaryDirectories: string[] = [];
const messageKey = 'Example__hello';

function addMessage({ root, key }: { root: string; key: string }): void {
  const directory = path.join(root, 'src/strings/messages', key);
  fs.mkdirSync(directory, { recursive: true });
  for (const locale of BOUNDARY_STRING_LOCALES) {
    fs.writeFileSync(path.join(directory, `${locale}.ts`), `export const ${key} = (): string => 'Hello';\n`);
  }
}

function createFixture({ keys }: { keys: readonly string[] }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-generate-catalogs-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'src/strings/messages'), { recursive: true });
  for (const key of keys) {
    addMessage({ root, key });
  }
  return root;
}

function readCatalog({ root, locale }: { root: string; locale: BoundaryStringLocale }): string {
  return fs.readFileSync(createBoundaryStringProjectPaths({ root }).catalogFilePathsByLocale[locale], 'utf8');
}

function snapshotCatalogs({ root }: { root: string }) {
  return BOUNDARY_STRING_LOCALES.map(locale => {
    const filePath = createBoundaryStringProjectPaths({ root }).catalogFilePathsByLocale[locale];
    const stat = fs.statSync(filePath, { bigint: true });
    return { locale, content: fs.readFileSync(filePath, 'utf8'), modified: stat.mtimeNs, inode: stat.ino };
  });
}

function checkFixtureTypes({ root, additionalFiles }: { root: string; additionalFiles: readonly string[] }) {
  const paths = createBoundaryStringProjectPaths({ root });
  const program = ts.createProgram({
    rootNames: [...Object.values(paths.catalogFilePathsByLocale), ...additionalFiles],
    options: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      paths: { '@/*': [path.join(root, 'src/*')] },
    },
  });
  return ts.getPreEmitDiagnostics(program).map(diagnostic => ({
    code: diagnostic.code,
    file: diagnostic.file?.fileName,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('String catalog generation', () => {
  it('creates every supported catalog with shared keys first and stable identifier ordering', () => {
    const keys = ['zWorkflow__go', 'Alpha__zebra', 'SHARED__zulu', 'aWorkflow__next', 'SHARED__alpha', 'Alpha__a'];
    const root = createFixture({ keys });
    const result = synchronizeStringCatalogs({ root, mode: 'write' });
    expect(result).toEqual({
      changedFiles: BOUNDARY_STRING_LOCALES.map(locale => `src/strings/catalogs/${locale}.ts`),
      messageCount: keys.length,
      localeCount: BOUNDARY_STRING_LOCALES.length,
    });
    // The existing build reader validates both import/object parity and locale isolation.
    const catalog = readBoundaryStringMessageCatalog({ root, paths: createBoundaryStringProjectPaths({ root }) });
    expect(catalog.messages.map(message => message.key)).toEqual([
      'SHARED__alpha', 'SHARED__zulu', 'Alpha__a', 'Alpha__zebra', 'aWorkflow__next', 'zWorkflow__go',
    ]);
    for (const locale of BOUNDARY_STRING_LOCALES) {
      const source = readCatalog({ root, locale });
      expect(source.startsWith('// Generated from src/strings/messages/')).toBe(true);
      expect(source).toContain('npm run strings:catalogs');
      expect(source).toContain('npm run strings:catalogs:check');
      expect(source).toContain('// SHARED__ intentionally couples every call site. Follow messages/AGENTS.md.');
      expect(source).not.toContain('\r');
      expect(source.endsWith('\n')).toBe(true);
      for (const key of keys) {
        expect(source).toContain(`import { ${key} } from '@/strings/messages/${key}/${locale}';`);
      }
    }
  });

  it('reports missing catalogs in check mode without creating the output directory', () => {
    const root = createFixture({ keys: [messageKey] });
    expect(synchronizeStringCatalogs({ root, mode: 'check' }).changedFiles).toHaveLength(BOUNDARY_STRING_LOCALES.length);
    expect(fs.existsSync(path.join(root, 'src/strings/catalogs'))).toBe(false);
  });

  it('does not rewrite current files or change their timestamps', () => {
    const root = createFixture({ keys: [messageKey] });
    synchronizeStringCatalogs({ root, mode: 'write' });
    const before = snapshotCatalogs({ root });
    expect(synchronizeStringCatalogs({ root, mode: 'write' }).changedFiles).toEqual([]);
    expect(synchronizeStringCatalogs({ root, mode: 'check' }).changedFiles).toEqual([]);
    expect(snapshotCatalogs({ root })).toEqual(before);
  });

  it('recreates only a missing catalog and repairs only a stale one', () => {
    const root = createFixture({ keys: [messageKey] });
    synchronizeStringCatalogs({ root, mode: 'write' });
    const paths = createBoundaryStringProjectPaths({ root });
    fs.unlinkSync(paths.catalogFilePathsByLocale.ja);
    fs.writeFileSync(paths.catalogFilePathsByLocale.en, '// stale catalog\n');
    const expected = ['src/strings/catalogs/en.ts', 'src/strings/catalogs/ja.ts'];
    expect(synchronizeStringCatalogs({ root, mode: 'check' }).changedFiles).toEqual(expected);
    expect(fs.existsSync(paths.catalogFilePathsByLocale.ja)).toBe(false);
    expect(readCatalog({ root, locale: 'en' })).toBe('// stale catalog\n');
    expect(synchronizeStringCatalogs({ root, mode: 'write' }).changedFiles).toEqual(expected);
    expect(synchronizeStringCatalogs({ root, mode: 'check' }).changedFiles).toEqual([]);
  });

  it('regenerates from messages even when every existing catalog is malformed', () => {
    const root = createFixture({ keys: [messageKey] });
    synchronizeStringCatalogs({ root, mode: 'write' });
    for (const filePath of Object.values(createBoundaryStringProjectPaths({ root }).catalogFilePathsByLocale)) {
      fs.writeFileSync(filePath, 'this is not TypeScript');
    }
    expect(synchronizeStringCatalogs({ root, mode: 'write' }).changedFiles).toHaveLength(BOUNDARY_STRING_LOCALES.length);
    expect(readBoundaryStringMessageCatalog({ root, paths: createBoundaryStringProjectPaths({ root }) }).messages).toHaveLength(1);
  });

  it('registers added keys and removes deleted keys without consulting old catalogs', () => {
    const root = createFixture({ keys: [messageKey] });
    synchronizeStringCatalogs({ root, mode: 'write' });
    addMessage({ root, key: 'Example__new_message' });
    fs.rmSync(path.join(root, 'src/strings/messages', messageKey), { recursive: true });
    synchronizeStringCatalogs({ root, mode: 'write' });
    const catalog = readBoundaryStringMessageCatalog({ root, paths: createBoundaryStringProjectPaths({ root }) });
    expect(catalog.messages.map(message => message.key)).toEqual(['Example__new_message']);
    expect(readCatalog({ root, locale: 'en' })).not.toContain(messageKey);
  });

  it('ignores documentation and does not read, execute, or modify message implementations', () => {
    const root = createFixture({ keys: [messageKey] });
    const paths = createBoundaryStringProjectPaths({ root });
    const filePath = path.join(paths.messagesDirectoryPath, messageKey, 'en.ts');
    const content = `\
throw new Error('Message implementations must not execute during generation');
export function ${messageKey}(): string { return 'Hello'; }
`;
    fs.writeFileSync(filePath, content);
    fs.writeFileSync(path.join(paths.messagesDirectoryPath, 'AGENTS.md'), '# Documentation');
    fs.writeFileSync(path.join(paths.messagesDirectoryPath, messageKey, 'README.md'), '# Message context');
    const readFile = vi.spyOn(fs, 'readFileSync');
    synchronizeStringCatalogs({ root, mode: 'write' });
    expect(readFile.mock.calls.some(([file]) => String(file).includes(`${path.sep}messages${path.sep}`))).toBe(false);
    readFile.mockRestore();
    expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
    expect(checkFixtureTypes({ root, additionalFiles: [] })).toEqual([]);
  });

  it('leaves catalogs unchanged for wording-only edits', () => {
    const root = createFixture({ keys: [messageKey] });
    synchronizeStringCatalogs({ root, mode: 'write' });
    const before = snapshotCatalogs({ root });
    fs.writeFileSync(path.join(root, 'src/strings/messages', messageKey, 'ja.ts'), `export const ${messageKey} = (): string => 'Updated';\n`);
    expect(synchronizeStringCatalogs({ root, mode: 'write' }).changedFiles).toEqual([]);
    expect(snapshotCatalogs({ root })).toEqual(before);
  });

  it.each(['write', 'check'] as const)('reports all missing locale files before changing anything in %s mode', mode => {
    const root = createFixture({ keys: [messageKey] });
    synchronizeStringCatalogs({ root, mode: 'write' });
    const before = snapshotCatalogs({ root });
    addMessage({ root, key: 'Example__added' });
    fs.unlinkSync(path.join(root, 'src/strings/messages/Example__added/ja.ts'));
    fs.unlinkSync(path.join(root, 'src/strings/messages/Example__added/ko.ts'));
    expect(() => synchronizeStringCatalogs({ root, mode })).toThrow(/Example__added\/ja\.ts[\s\S]*Example__added\/ko\.ts/);
    expect(snapshotCatalogs({ root })).toEqual(before);
  });

  it('does not create catalogs for an incomplete first message', () => {
    const root = createFixture({ keys: [messageKey] });
    fs.unlinkSync(path.join(root, 'src/strings/messages', messageKey, 'en.ts'));
    expect(() => synchronizeStringCatalogs({ root, mode: 'write' })).toThrow('Missing or non-regular locale file:');
    expect(fs.existsSync(path.join(root, 'src/strings/catalogs'))).toBe(false);
  });

  it('does not clear existing catalogs when the messages directory is empty or missing', () => {
    const root = createFixture({ keys: [messageKey] });
    synchronizeStringCatalogs({ root, mode: 'write' });
    const before = snapshotCatalogs({ root });
    fs.rmSync(path.join(root, 'src/strings/messages', messageKey), { recursive: true });
    expect(() => synchronizeStringCatalogs({ root, mode: 'write' })).toThrow('No message directories found');
    fs.rmdirSync(path.join(root, 'src/strings/messages'));
    expect(() => synchronizeStringCatalogs({ root, mode: 'write' })).toThrow('Expected a messages directory');
    expect(snapshotCatalogs({ root })).toEqual(before);
  });

  it.each(['no_scope', 'Example__Wrong_case', 'Example__not-valid', 'Example__name\';injection'])('uses the existing message key contract for %s', key => {
    const root = createFixture({ keys: [key] });
    expect(() => synchronizeStringCatalogs({ root, mode: 'write' })).toThrow('Invalid message key');
    expect(fs.existsSync(path.join(root, 'src/strings/catalogs'))).toBe(false);
  });

  it('requires explicit review of unsupported catalog files rather than deleting them', () => {
    const root = createFixture({ keys: [messageKey] });
    synchronizeStringCatalogs({ root, mode: 'write' });
    const before = snapshotCatalogs({ root });
    const extra = path.join(root, 'src/strings/catalogs/xx.ts');
    fs.writeFileSync(extra, '// Unregistered locale');
    expect(() => synchronizeStringCatalogs({ root, mode: 'write' })).toThrow('Unexpected locale catalogs: xx.ts');
    expect(snapshotCatalogs({ root })).toEqual(before);
    expect(fs.readFileSync(extra, 'utf8')).toBe('// Unregistered locale');
  });

  it('reads every destination before writing any changed file', () => {
    const root = createFixture({ keys: [messageKey] });
    synchronizeStringCatalogs({ root, mode: 'write' });
    const paths = createBoundaryStringProjectPaths({ root });
    fs.writeFileSync(paths.catalogFilePathsByLocale.en, '// stale\n');
    fs.unlinkSync(paths.catalogFilePathsByLocale.de);
    fs.mkdirSync(paths.catalogFilePathsByLocale.de);
    expect(() => synchronizeStringCatalogs({ root, mode: 'write' })).toThrow('Expected a regular catalog file: src/strings/catalogs/de.ts');
    expect(readCatalog({ root, locale: 'en' })).toBe('// stale\n');
  });

  it('accepts CRLF checkouts without rewriting their bytes or timestamps', () => {
    const root = createFixture({ keys: [messageKey] });
    synchronizeStringCatalogs({ root, mode: 'write' });
    for (const filePath of Object.values(createBoundaryStringProjectPaths({ root }).catalogFilePathsByLocale)) {
      fs.writeFileSync(filePath, fs.readFileSync(filePath, 'utf8').replaceAll('\n', '\r\n'));
    }
    const before = snapshotCatalogs({ root });
    expect(synchronizeStringCatalogs({ root, mode: 'check' }).changedFiles).toEqual([]);
    expect(synchronizeStringCatalogs({ root, mode: 'write' }).changedFiles).toEqual([]);
    expect(snapshotCatalogs({ root })).toEqual(before);
  });

  it('preserves an existing file on replacement failure and can recover a partially updated set', () => {
    const root = createFixture({ keys: [messageKey] });
    synchronizeStringCatalogs({ root, mode: 'write' });
    const originalJapanese = readCatalog({ root, locale: 'ja' });
    addMessage({ root, key: 'Example__added' });
    const rename = fs.renameSync;
    let replacements = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
      replacements++;
      if (replacements === 2) {
        throw new Error('Simulated replacement failure');
      }
      rename(oldPath, newPath);
    });
    expect(() => synchronizeStringCatalogs({ root, mode: 'write' })).toThrow('Simulated replacement failure');
    expect(readCatalog({ root, locale: 'ja' })).toBe(originalJapanese);
    expect(readCatalog({ root, locale: 'en' })).toContain('Example__added');
    expect(fs.readdirSync(path.join(root, 'src/strings/catalogs')).some(name => name.startsWith('.strings-catalog-'))).toBe(false);
    vi.restoreAllMocks();
    expect(synchronizeStringCatalogs({ root, mode: 'write' }).changedFiles).toHaveLength(BOUNDARY_STRING_LOCALES.length - 1);
    expect(synchronizeStringCatalogs({ root, mode: 'check' }).changedFiles).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('rejects linked message directories and locale files', () => {
    const root = createFixture({ keys: [messageKey] });
    const paths = createBoundaryStringProjectPaths({ root });
    fs.symlinkSync(path.join(paths.messagesDirectoryPath, messageKey), path.join(paths.messagesDirectoryPath, 'Example__linked'), 'dir');
    expect(() => synchronizeStringCatalogs({ root, mode: 'write' })).toThrow('Expected a regular message directory');
    fs.unlinkSync(path.join(paths.messagesDirectoryPath, 'Example__linked'));
    const japanese = path.join(paths.messagesDirectoryPath, messageKey, 'ja.ts');
    fs.unlinkSync(japanese);
    fs.symlinkSync(path.join(paths.messagesDirectoryPath, messageKey, 'en.ts'), japanese);
    expect(() => synchronizeStringCatalogs({ root, mode: 'write' })).toThrow('Missing or non-regular locale file:');
    expect(fs.existsSync(path.join(root, 'src/strings/catalogs'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('rejects linked output directories and files without overwriting their targets', () => {
    const root = createFixture({ keys: [messageKey] });
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const directory = path.join(root, 'src/strings/catalogs');
    fs.symlinkSync(outside, directory, 'dir');
    expect(() => synchronizeStringCatalogs({ root, mode: 'write' })).toThrow('Expected a regular catalog directory');
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.unlinkSync(directory);
    synchronizeStringCatalogs({ root, mode: 'write' });
    const paths = createBoundaryStringProjectPaths({ root });
    const target = path.join(outside, 'target.ts');
    fs.writeFileSync(target, '// Do not overwrite');
    fs.unlinkSync(paths.catalogFilePathsByLocale.de);
    fs.symlinkSync(target, paths.catalogFilePathsByLocale.de);
    expect(() => synchronizeStringCatalogs({ root, mode: 'write' })).toThrow('Expected a regular catalog file');
    expect(fs.readFileSync(target, 'utf8')).toBe('// Do not overwrite');
  });
});

describe('Generated catalog type contracts', () => {
  it('preserves exact keys and parameters while allowing different function implementation styles', () => {
    const root = createFixture({ keys: [messageKey] });
    const directory = path.join(root, 'src/strings/messages', messageKey);
    fs.writeFileSync(path.join(directory, 'en.ts'), `export const ${messageKey} = ({ name }: { name: string }): string => name;\n`);
    for (const locale of BOUNDARY_STRING_LOCALES.filter(locale => locale !== 'en')) {
      fs.writeFileSync(path.join(directory, `${locale}.ts`), `\
function translated({ name }: { name: string }): string {
  return name.length === 0 ? 'Hello' : name;
}
export { translated as ${messageKey} };
`);
    }
    synchronizeStringCatalogs({ root, mode: 'write' });
    const consumer = path.join(root, 'consumer.ts');
    fs.writeFileSync(consumer, `\
import { catalog, type StringKey, type Strings } from './src/strings/catalogs/en';
const key: StringKey = '${messageKey}';
const value: string = catalog[key]({ name: 'Ada' });
const args: Parameters<Strings['${messageKey}']>[0] = { name: 'Ada' };
// @ts-expect-error Catalog keys must not widen to string.
const unknownKey: StringKey = 'Unknown__message';
// @ts-expect-error Message parameters must not be erased by the catalog contract.
catalog.${messageKey}({ wrong: 'Ada' });
`);
    expect(checkFixtureTypes({ root, additionalFiles: [consumer] })).toEqual([]);
  });

  it.each([
    { locale: 'en', source: `export const ${messageKey} = async (): Promise<string> => 'Hello';`, code: 2322 },
    { locale: 'en', source: `export const ${messageKey} = (): number => 42;`, code: 2322 },
    { locale: 'ja', source: `export const ${messageKey} = async (): Promise<string> => 'Hello';`, code: 2322 },
    { locale: 'ja', source: `export const ${messageKey} = ({ required }: { required: string }): string => required;`, code: 2322 },
    { locale: 'ja', source: "export const Example__typo = (): string => 'Hello';", code: 2305 },
  ])('delegates invalid signatures and missing exports to TypeScript: $locale / $source', ({ locale, source, code }) => {
    const root = createFixture({ keys: [messageKey] });
    fs.writeFileSync(path.join(root, 'src/strings/messages', messageKey, `${locale}.ts`), `${source}\n`);
    // Generation validates topology, not a home-grown subset of TypeScript.
    synchronizeStringCatalogs({ root, mode: 'write' });
    expect(checkFixtureTypes({ root, additionalFiles: [] })).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  });
});

describe('String catalog command', () => {
  it('runs write and non-writing checks against the script location rather than the working directory', () => {
    const root = createFixture({ keys: [messageKey] });
    const cwd = createFixture({ keys: [] });
    const script = path.join(root, 'scripts/generate-string-catalogs.ts');
    fs.mkdirSync(path.dirname(script));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.copyFileSync(fileURLToPath(new URL('../../scripts/generate-string-catalogs.ts', import.meta.url)), script);
    // Run the exact entry point with the real implementation graph. Only the
    // script's repository root is a fixture; no runtime modules are stubbed.
    fs.symlinkSync(fileURLToPath(new URL('..', import.meta.url)), path.join(root, 'build'), 'junction');
    const run = ({ args }: { args: string[] }) => spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), script, ...args],
      { cwd, encoding: 'utf8', timeout: 10_000 },
    );
    const generated = run({ args: [] });
    expect(generated.error).toBeUndefined();
    expect(generated.status, generated.stderr).toBe(0);
    expect(fs.existsSync(path.join(cwd, 'src/strings/catalogs'))).toBe(false);
    const before = snapshotCatalogs({ root });
    expect(run({ args: ['--check'] }).status).toBe(0);
    expect(snapshotCatalogs({ root })).toEqual(before);
    fs.writeFileSync(createBoundaryStringProjectPaths({ root }).catalogFilePathsByLocale.en, '// stale\n');
    const stale = snapshotCatalogs({ root });
    const checked = run({ args: ['--check'] });
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain('src/strings/catalogs/en.ts');
    expect(snapshotCatalogs({ root })).toEqual(stale);
    expect(run({ args: [] }).status).toBe(0);
    expect(run({ args: ['--check'] }).status).toBe(0);
  }, 20_000);

  it.each([
    { args: ['--help'], status: 0 },
    { args: ['--chekc'], status: 1 },
    { args: ['--check', '--help'], status: 1 },
    { args: ['--write'], status: 1 },
  ])('handles $args without initializing the application', ({ args, status }) => {
    const cwd = createFixture({ keys: [] });
    const script = fileURLToPath(new URL('../../scripts/generate-string-catalogs.ts', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), script, ...args], { cwd, encoding: 'utf8', timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    expect(`${result.stdout}${result.stderr}`).toContain('Usage: npm run strings:catalogs');
    expect(fs.existsSync(path.join(cwd, 'src/strings/catalogs'))).toBe(false);
  });
});
