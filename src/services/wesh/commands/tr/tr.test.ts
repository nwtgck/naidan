import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';
import { trCommandDefinition } from './index';

vi.mock('@/services/wesh/commands', () => ({
  builtinCommands: [],
}));

describe('wesh tr', () => {
  let wesh: import('@/services/wesh/index').Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    const { Wesh } = await import('@/services/wesh/index');
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
    wesh.registerCommand({ definition: trCommandDefinition });
  });

  async function execute({
    script,
    stdinText,
  }: {
    script: string;
    stdinText: string | undefined;
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: stdinText ?? '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('translates characters and repeats the last character in set2', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'tr abc X',
      stdinText: 'abc cab',
    });

    expect(stdout.text).toBe('XXX XXX');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves embedded newlines instead of treating stdin as line oriented', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'tr a X',
      stdinText: `\
a
a`,
    });

    expect(stdout.text).toBe(`\
X
X`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports character classes', async () => {
    const { result, stdout, stderr } = await execute({
      script: `tr '[:lower:]' '[:upper:]'`,
      stdinText: 'hello world',
    });

    expect(stdout.text).toBe('HELLO WORLD');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports ranges', async () => {
    const { result, stdout, stderr } = await execute({
      script: `tr 'a-z' 'A-Z'`,
      stdinText: 'hello world',
    });

    expect(stdout.text).toBe('HELLO WORLD');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports escape sequences and octal escapes in sets', async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`tr '\141\n' 'X_'`,
      stdinText: `\
a
a`,
    });

    expect(stdout.text).toBe('X_X');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('deletes characters with -d', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'tr -d ab',
      stdinText: 'aabbccab',
    });

    expect(stdout.text).toBe('cc');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('deletes the complement of set1 with -c', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'tr -cd a-z',
      stdinText: 'a1b!c2',
    });

    expect(stdout.text).toBe('abc');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports the -C alias for complement', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'tr -Cd a-z',
      stdinText: 'a1b!c2',
    });

    expect(stdout.text).toBe('abc');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('squeezes repeated translated characters with -s', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'tr -s a X',
      stdinText: 'aaaaabaaa',
    });

    expect(stdout.text).toBe('XbX');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('truncates set1 with -t instead of repeating the last set2 character', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'tr -t abc X',
      stdinText: 'abc',
    });

    expect(stdout.text).toBe('Xbc');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports GNU-style long options', async () => {
    const deleteResult = await execute({
      script: "tr --delete '[:digit:]'",
      stdinText: 'a1b2c3',
    });
    const squeezeResult = await execute({
      script: "tr --squeeze-repeats ' '",
      stdinText: 'a   b',
    });
    const truncateResult = await execute({
      script: 'tr --truncate-set1 abc X',
      stdinText: 'abc',
    });
    const complementResult = await execute({
      script: 'tr --complement --delete a-z',
      stdinText: 'a1b!c2',
    });

    expect(deleteResult.stdout.text).toBe('abc');
    expect(squeezeResult.stdout.text).toBe('a b');
    expect(truncateResult.stdout.text).toBe('Xbc');
    expect(complementResult.stdout.text).toBe('abc');
    expect(deleteResult.stderr.text).toBe('');
    expect(squeezeResult.stderr.text).toBe('');
    expect(truncateResult.stderr.text).toBe('');
    expect(complementResult.stderr.text).toBe('');
    expect(deleteResult.result.exitCode).toBe(0);
    expect(squeezeResult.result.exitCode).toBe(0);
    expect(truncateResult.result.exitCode).toBe(0);
    expect(complementResult.result.exitCode).toBe(0);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'tr --help',
      stdinText: undefined,
    });

    expect(stdout.text).toContain('Translate or delete characters');
    expect(stdout.text).toContain('usage: tr [OPTION]... SET1 [SET2]');
    expect(stdout.text).toContain('--help');
    expect(stdout.text).toContain('-d');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports missing operands with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'tr a',
      stdinText: 'a',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('tr: missing operand');
    expect(stderr.text).toContain('usage: tr [OPTION]... SET1 [SET2]');
    expect(stderr.text).toContain('try:');
    expect(result.exitCode).toBe(1);
  });

  it('reports extra operands with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'tr a b c',
      stdinText: 'abc',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("tr: extra operand 'c'");
    expect(stderr.text).toContain('usage: tr [OPTION]... SET1 [SET2]');
    expect(stderr.text).toContain('try:');
    expect(result.exitCode).toBe(1);
  });

  it('reports unknown options with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'tr -z a b',
      stdinText: 'abc',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("tr: invalid option -- 'z'");
    expect(stderr.text).toContain('usage: tr [OPTION]... SET1 [SET2]');
    expect(stderr.text).toContain('try:');
    expect(result.exitCode).toBe(1);
  });
});
