// @vitest-environment node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const usage = `\
Usage: npm run strings:catalogs [-- --check | --help]

Regenerate locale catalogs from the message directories and supported locales.
  --check  Compare without writing; exit nonzero if any catalog differs.
  --help   Show this help without reading or writing catalogs.

Only catalog files are written. Message implementations are never modified.
See scripts/README.md for the validation boundary and language-addition workflow.
`;

afterEach(() => {
  vi.doUnmock('./generate-catalogs');
  vi.doUnmock('./string-catalog-cli');
  vi.restoreAllMocks();
  vi.resetModules();
});

describe.sequential('String catalog CLI boundary', () => {
  it.each([
    { args: ['--help'], exitCode: 0 },
    { args: ['--chekc'], exitCode: 1 },
    { args: ['--check', '--help'], exitCode: 1 },
    { args: ['--write'], exitCode: 1 },
    { args: ['--check', '--check'], exitCode: 1 },
    { args: ['--help', '--help'], exitCode: 1 },
    { args: ['--'], exitCode: 1 },
    { args: [''], exitCode: 1 },
  ])('returns exact output for $args before resolving the URL or reading catalogs', async ({ args, exitCode }) => {
    const synchronize = vi.fn();
    vi.doMock('./generate-catalogs', () => ({ synchronizeStringCatalogs: synchronize }));
    const { runStringCatalogCli } = await import('./string-catalog-cli');
    const result = runStringCatalogCli({ args, scriptUrl: 'not a URL' });
    expect(result).toEqual(exitCode === 0
      ? { exitCode: 0, stdout: usage, stderr: '' }
      : { exitCode: 1, stdout: '', stderr: `Unknown or conflicting arguments: ${args.join(' ')}\n${usage}` });
    expect(synchronize).not.toHaveBeenCalled();
  });

  it.each([
    { thrown: new Error('Simulated read failure'), message: 'Simulated read failure' },
    { thrown: 'Thrown string', message: 'Thrown string' },
    { thrown: undefined, message: 'undefined' },
  ])('returns thrown generation values as stderr: $message', async ({ thrown, message }) => {
    const synchronize = vi.fn(() => {
      throw thrown;
    });
    vi.doMock('./generate-catalogs', () => ({ synchronizeStringCatalogs: synchronize }));
    const { runStringCatalogCli } = await import('./string-catalog-cli');
    const scriptUrl = new URL('../../scripts/fixture.ts', import.meta.url).href;
    expect(runStringCatalogCli({ args: [], scriptUrl })).toEqual({ exitCode: 1, stdout: '', stderr: `${message}\n` });
    expect(synchronize).toHaveBeenCalledExactlyOnceWith({ root: fileURLToPath(new URL('..', scriptUrl)), mode: 'write' });
  });

  it('returns URL resolution failures without entering catalog synchronization', async () => {
    const synchronize = vi.fn();
    vi.doMock('./generate-catalogs', () => ({ synchronizeStringCatalogs: synchronize }));
    const { runStringCatalogCli } = await import('./string-catalog-cli');
    const result = runStringCatalogCli({ args: ['--check'], scriptUrl: 'not a URL' });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^Invalid URL.*\n$/);
    expect(synchronize).not.toHaveBeenCalled();
  });

  it('preserves the order of all stale catalog paths and writes no process output', async () => {
    const synchronize = vi.fn(() => ({ changedFiles: ['src/strings/catalogs/en.ts', 'src/strings/catalogs/ja.ts'], messageCount: 3, localeCount: 12 }));
    vi.doMock('./generate-catalogs', () => ({ synchronizeStringCatalogs: synchronize }));
    const { runStringCatalogCli } = await import('./string-catalog-cli');
    const scriptUrl = new URL('../../scripts/fixture.ts', import.meta.url).href;
    const argv = process.argv;
    const environment = { ...process.env };
    const exitCode = process.exitCode;
    using stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    using stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    using log = vi.spyOn(console, 'log').mockImplementation(() => {});
    using error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runStringCatalogCli({ args: ['--check'], scriptUrl })).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: `\
String catalogs differ:
  src/strings/catalogs/en.ts
  src/strings/catalogs/ja.ts
Run \`npm run strings:catalogs\` to regenerate them.
`,
    });
    expect(synchronize).toHaveBeenCalledExactlyOnceWith({ root: fileURLToPath(new URL('..', scriptUrl)), mode: 'check' });
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(process.argv).toBe(argv);
    expect(process.env).toEqual(environment);
    expect(process.exitCode).toBe(exitCode);
  });

  it('imports the real function module without catalog I/O, output, or process changes', async () => {
    vi.resetModules();
    const argv = process.argv;
    const environment = { ...process.env };
    const exitCode = process.exitCode;
    using reads = vi.spyOn(fs, 'readFileSync');
    using stats = vi.spyOn(fs, 'lstatSync');
    using directories = vi.spyOn(fs, 'readdirSync');
    using writes = vi.spyOn(fs, 'writeFileSync');
    using mkdirs = vi.spyOn(fs, 'mkdirSync');
    using renames = vi.spyOn(fs, 'renameSync');
    using stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    using stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    using log = vi.spyOn(console, 'log').mockImplementation(() => {});
    using error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const module = await import('./string-catalog-cli');
    expect(typeof module.runStringCatalogCli).toBe('function');
    const catalogAccesses = [...reads.mock.calls, ...stats.mock.calls, ...directories.mock.calls]
      .filter(([file]) => /src[/\\]strings[/\\](?:messages|catalogs)(?:[/\\]|$)/.test(String(file)));
    expect(catalogAccesses).toEqual([]);
    expect(writes).not.toHaveBeenCalled();
    expect(mkdirs).not.toHaveBeenCalled();
    expect(renames).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(process.argv).toBe(argv);
    expect(process.env).toEqual(environment);
    expect(process.exitCode).toBe(exitCode);
  });

  it.each([
    { exitCode: 0 as const, stdout: 'Generated catalogs.\n', stderr: '' },
    { exitCode: 1 as const, stdout: 'Before failure.\n', stderr: 'Catalog failure.\n' },
    { exitCode: 0 as const, stdout: '', stderr: '' },
  ])('connects the actual entry to argv, URL, streams, and exitCode: $exitCode / $stdout / $stderr', async result => {
    const run = vi.fn(() => result);
    vi.doMock('./string-catalog-cli', () => ({ runStringCatalogCli: run }));
    const argv = process.argv;
    const exitCode = process.exitCode;
    using _processState = {
      [Symbol.dispose]() {
        process.argv = argv;
        process.exitCode = exitCode;
      },
    };
    using stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    using stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const scriptUrl = new URL('../../scripts/generate-string-catalogs.ts', import.meta.url).href;
    for (const args of [['--check'], ['--help', 'argument with spaces']]) {
      vi.resetModules();
      run.mockClear();
      stdout.mockClear();
      stderr.mockClear();
      process.argv = ['node', 'entry', ...args];
      process.exitCode = 7;
      await import('../../scripts/generate-string-catalogs');
      expect(run).toHaveBeenCalledExactlyOnceWith({ args, scriptUrl });
      expect(stdout.mock.calls).toEqual(result.stdout === '' ? [] : [[result.stdout]]);
      expect(stderr.mock.calls).toEqual(result.stderr === '' ? [] : [[result.stderr]]);
      if (result.stdout !== '' && result.stderr !== '') {
        expect(stdout.mock.invocationCallOrder[0]).toBeLessThan(stderr.mock.invocationCallOrder[0]!);
      }
      expect(process.exitCode).toBe(result.exitCode);
    }
  });
});
