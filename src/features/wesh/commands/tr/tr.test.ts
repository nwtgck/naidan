import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromBytes,
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';
import { trCommandDefinition } from './definition';

vi.mock('@/features/wesh/commands', () => ({
  builtinCommands: [],
}));

describe('wesh tr', () => {
  let wesh: import('@/features/wesh/index').Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    const { Wesh } = await import('@/features/wesh/index');
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
    wesh.registerCommand({ definition: trCommandDefinition });
  });

  async function execute({
    script,
    stdinText,
  }: {
    script: string,
    stdinText: string | undefined,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: stdinText ?? '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  async function executeBytes({
    script,
    stdinBytes,
  }: {
    script: string,
    stdinBytes: Uint8Array,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromBytes({ bytes: stdinBytes }),
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


  it('uses set1 for deletion and set2 for squeezing when -d and -s are combined', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'tr -ds a b',
      stdinText: 'aaabbbbcc',
    });

    expect(stdout.text).toBe('bcc');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('expands ranges whose endpoints are octal escapes', async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`tr 'a-c' x`,
      stdinText: 'abc cab',
    });

    expect(stdout.text).toBe('xxx xxx');
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
  it('rejects ranges whose endpoints are in reverse order', async () => {
    const { result, stdout, stderr } = await execute({
      script: `tr 'z-a' 'A-Z'`,
      stdinText: 'abc',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("tr: range-endpoints of 'z-a' are in reverse collating sequence order");
    expect(result.exitCode).toBe(1);
  });

  it('supports GNU repeat constructs and literal bracket operands', async () => {
    const repeated = await execute({
      script: `tr abcd '[x*]'`,
      stdinText: 'abcd',
    });
    const bracketed = await execute({
      script: `tr '[abc]' XYZ`,
      stdinText: 'abc[]',
    });

    expect(repeated.stdout.text).toBe('xxxx');
    expect(repeated.stderr.text).toBe('');
    expect(repeated.result.exitCode).toBe(0);
    expect(bracketed.stdout.text).toBe('YZZXZ');
    expect(bracketed.stderr.text).toBe('');
    expect(bracketed.result.exitCode).toBe(0);
  });

  it('preserves invalid UTF-8 bytes while translating matching bytes', async () => {
    const { result, stdout, stderr } = await executeBytes({
      script: 'tr a b',
      stdinBytes: new Uint8Array([0xff, 0xfe, 0x61, 0x0a]),
    });

    expect(stdout.buffer).toEqual(new Uint8Array([0xff, 0xfe, 0x62, 0x0a]));
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('translates NUL bytes without converting the stream to text', async () => {
    const { result, stdout, stderr } = await executeBytes({
      script: String.raw`tr '\000' X`,
      stdinBytes: new Uint8Array([0x41, 0x00, 0x42, 0x0a]),
    });

    expect(stdout.buffer).toEqual(new Uint8Array([0x41, 0x58, 0x42, 0x0a]));
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects invalid classes and misaligned case conversion classes', async () => {
    const unknownClass = await execute({
      script: `tr '[:bogus:]' X`,
      stdinText: 'abc',
    });
    const misalignedClass = await execute({
      script: `tr abc '[:upper:]'`,
      stdinText: 'abc',
    });

    expect(unknownClass.stdout.text).toBe('');
    expect(unknownClass.stderr.text).toContain("tr: invalid character class 'bogus'");
    expect(unknownClass.result.exitCode).toBe(1);
    expect(misalignedClass.stdout.text).toBe('');
    expect(misalignedClass.stderr.text).toContain('tr: misaligned [:upper:] and/or [:lower:] construct');
    expect(misalignedClass.result.exitCode).toBe(1);
  });

  it('warns about a trailing unescaped backslash without failing', async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`tr 'a\' XY`,
      stdinText: String.raw`a\b`,
    });

    expect(stdout.text).toBe('XYb');
    expect(stderr.text).toContain('tr: warning: an unescaped backslash at end of string is not portable');
    expect(result.exitCode).toBe(0);
  });


  it('treats operands after SET1 as operands even when they start with a dash', async () => {
    const { result, stdout, stderr } = await execute({
      script: `tr -s 'ac-' '-_'`,
      stdinText: 'aacc--__',
    });

    expect(stdout.text).toBe('-_');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('allows aligned same-case and opposite-case character classes', async () => {
    const lowerIdentity = await execute({
      script: `tr '[:lower:]' '[:lower:]'`,
      stdinText: 'aAzZ',
    });
    const upperToLower = await execute({
      script: `tr '[:upper:]' '[:lower:]'`,
      stdinText: 'aAzZ',
    });

    expect(lowerIdentity.stdout.text).toBe('aAzZ');
    expect(lowerIdentity.stderr.text).toBe('');
    expect(lowerIdentity.result.exitCode).toBe(0);
    expect(upperToLower.stdout.text).toBe('aazz');
    expect(upperToLower.stderr.text).toBe('');
    expect(upperToLower.result.exitCode).toBe(0);
  });

  it('does not expand enormous repeat constructs in memory', async () => {
    const translated = await execute({
      script: `tr '[x*9007199254740991][y*9007199254740991]z' abc`,
      stdinText: 'xyz',
    });
    expect(translated.stdout.text).toBe('ccc');
    expect(translated.stderr.text).toBe('');
    expect(translated.result.exitCode).toBe(0);

    const deleted = await execute({
      script: `tr -d '[x*9007199254740991]y'`,
      stdinText: 'xyz',
    });
    expect(deleted.stdout.text).toBe('z');
    expect(deleted.stderr.text).toBe('');
    expect(deleted.result.exitCode).toBe(0);

    const squeezed = await execute({
      script: `tr -s '[x*9007199254740991]y'`,
      stdinText: 'xyyyzzz',
    });
    expect(squeezed.stdout.text).toBe('xyzzz');
    expect(squeezed.stderr.text).toBe('');
    expect(squeezed.result.exitCode).toBe(0);
  });

  it('requires complemented character classes to translate the domain to one byte', async () => {
    const valid = await execute({
      script: `tr -c '[:upper:]' x`,
      stdinText: 'Aa1!',
    });
    const exactDomainRepeat = await execute({
      script: `tr -c '[:upper:]' '[x*230]'`,
      stdinText: 'Aa1!',
    });
    const invalid = await execute({
      script: `tr -c '[:upper:]' xy`,
      stdinText: 'Aa1!',
    });
    const overlongRepeat = await execute({
      script: `tr -c '[:upper:]' '[x*231]'`,
      stdinText: 'Aa1!',
    });

    expect(valid.stdout.text).toBe('Axxx');
    expect(valid.stderr.text).toBe('');
    expect(valid.result.exitCode).toBe(0);
    expect(exactDomainRepeat.stdout.text).toBe('Axxx');
    expect(exactDomainRepeat.stderr.text).toBe('');
    expect(exactDomainRepeat.result.exitCode).toBe(0);
    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain(
      'tr: when translating with complemented character classes, SET2 must map all characters in the domain to one',
    );
    expect(invalid.result.exitCode).toBe(1);
    expect(overlongRepeat.stdout.text).toBe('');
    expect(overlongRepeat.stderr.text).toContain(
      'tr: when translating with complemented character classes, SET2 must map all characters in the domain to one',
    );
    expect(overlongRepeat.result.exitCode).toBe(1);
  });

  it('rejects automatic SET2 repetition when deleting and squeezing', async () => {
    const automatic = await execute({
      script: `tr -ds abc '[x*]'`,
      stdinText: 'abcxxx',
    });
    const fixed = await execute({
      script: `tr -ds abc '[x*3]'`,
      stdinText: 'abcxxx',
    });

    expect(automatic.stdout.text).toBe('');
    expect(automatic.stderr.text).toContain(
      'tr: the [c*] construct may appear in SET2 only when translating',
    );
    expect(automatic.result.exitCode).toBe(1);
    expect(fixed.stdout.text).toBe('x');
    expect(fixed.stderr.text).toBe('');
    expect(fixed.result.exitCode).toBe(0);
  });

  it('expands blank and space classes in ascending byte order', async () => {
    const blank = await executeBytes({
      script: `tr '[:blank:]' XY`,
      stdinBytes: new Uint8Array([0x20, 0x09]),
    });
    const space = await executeBytes({
      script: `tr '[:space:]' XYZ`,
      stdinBytes: new Uint8Array([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]),
    });

    expect(blank.stdout.buffer).toEqual(new Uint8Array([0x59, 0x58]));
    expect(blank.stderr.text).toBe('');
    expect(blank.result.exitCode).toBe(0);
    expect(space.stdout.buffer).toEqual(new Uint8Array([0x5a, 0x58, 0x59, 0x5a, 0x5a, 0x5a]));
    expect(space.stderr.text).toBe('');
    expect(space.result.exitCode).toBe(0);
  });

  it('stops argv processing when --help is reached before a later invalid option', async () => {
    const helpFirst = await execute({
      script: 'tr --help --definitely-invalid-option',
      stdinText: undefined,
    });
    const invalidFirst = await execute({
      script: 'tr --definitely-invalid-option --help',
      stdinText: undefined,
    });

    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stdout.text).not.toBe('');
    expect(helpFirst.stderr.text).toBe('');

    expect(invalidFirst.result.exitCode).not.toBe(0);
    expect(invalidFirst.stderr.text).not.toBe('');
  });

});
