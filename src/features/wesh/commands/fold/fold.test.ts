import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromBytes,
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh fold', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    path,
    data,
  }: {
    path: string,
    data: string,
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) throw new Error('path must include a file name');

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function execute({
    script,
    stdinText,
    stdinBytes,
  }: {
    script: string,
    stdinText?: string,
    stdinBytes?: Uint8Array,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: stdinBytes === undefined
        ? createTestReadHandleFromText({ text: stdinText ?? '' })
        : createTestReadHandleFromBytes({ bytes: stdinBytes }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('folds stdin to the requested width', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'fold -w 3',
      stdinText: 'abcdef\n',
    });

    expect(stdout.text).toBe(`\
abc
def
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });


  it('accepts leading C-locale whitespace in width operands', async () => {
    for (const whitespace of [' ', '\t', '\n', '\v', '\f', '\r']) {
      const execution = await execute({
        script: `fold -w '${whitespace}2'`,
        stdinText: 'abc\n',
      });
      expect(execution.stdout.text).toBe(`\
ab
c
`);
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it('accepts the obsolete -WIDTH form and rejects unsafe widths', async () => {
    const obsolete = await execute({
      script: 'fold -3',
      stdinText: 'abcdef\n',
    });
    const unsafe = await execute({
      script: `fold -${'9'.repeat(400)}`,
      stdinText: 'abcdef\n',
    });

    expect(obsolete.stdout.text).toBe(`\
abc
def
`);
    expect(obsolete.stderr.text).toBe('');
    expect(obsolete.result.exitCode).toBe(0);
    expect(unsafe.stdout.text).toBe('');
    expect(unsafe.stderr.text).toContain('fold: invalid width');
    expect(unsafe.result.exitCode).toBe(1);
  });

  it('supports long width option and preserves missing trailing newlines', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'fold --width=3',
      stdinText: 'abcdef',
    });

    expect(stdout.text).toBe(`\
abc
def`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('breaks at spaces when -s is set', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'fold -s -w 5',
      stdinText: 'abc def ghi\n',
    });

    expect(stdout.text).toBe([
      'abc ',
      'def ',
      'ghi',
      '',
    ].join('\n'));
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });


  it('preserves raw UTF-8 bytes when a fold boundary splits a character', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'fold -w 2',
      stdinBytes: new TextEncoder().encode('あいう\n'),
    });

    expect(Array.from(stdout.buffer)).toEqual([
      0xe3, 0x81, 0x0a,
      0x82, 0xe3, 0x0a,
      0x81, 0x84, 0x0a,
      0xe3, 0x81, 0x0a,
      0x86, 0x0a,
    ]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('counts terminal columns by default and raw bytes with -b', async () => {
    const defaultMode = await execute({
      script: 'fold -w 2',
      stdinText: 'ab\tcd\n',
    });
    const byteMode = await execute({
      script: 'fold -b -w 2',
      stdinText: 'ab\tcd\n',
    });

    expect(defaultMode.stdout.text).toBe([
      'ab',
      '\t',
      'cd',
      '',
    ].join('\n'));
    expect(defaultMode.stderr.text).toBe('');
    expect(defaultMode.result.exitCode).toBe(0);

    expect(byteMode.stdout.text).toBe(`\
ab
	c
d
`);
    expect(byteMode.stderr.text).toBe('');
    expect(byteMode.result.exitCode).toBe(0);
  });

  it('preserves invalid bytes and carriage returns without text decoding', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'fold -w 2',
      stdinBytes: Uint8Array.from([
        0xff, 0xfe, 0x41, 0x0a,
        0x61, 0x62, 0x0d, 0x63, 0x64, 0x0a,
      ]),
    });

    expect(Array.from(stdout.buffer)).toEqual([
      0xff, 0xfe, 0x0a, 0x41, 0x0a,
      0x61, 0x62, 0x0d, 0x63, 0x64, 0x0a,
    ]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reads stdin and files in operand order when - is used', async () => {
    await writeFile({ path: 'sample.txt', data: 'qrstuv\n' });

    const { result, stdout, stderr } = await execute({
      script: 'fold -w 4 - sample.txt',
      stdinText: 'abcdef\n',
    });

    expect(stdout.text).toBe(`\
abcd
ef
qrst
uv
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('continues after missing file errors and returns a failing exit code', async () => {
    await writeFile({ path: 'present.txt', data: 'abcd\n' });

    const { result, stdout, stderr } = await execute({
      script: 'fold -w 2 missing.txt present.txt',
    });

    expect(stdout.text).toBe(`\
ab
cd
`);
    expect(stderr.text).toContain('fold: missing.txt:');
    expect(result.exitCode).toBe(1);
  });

  it('prints usage errors for invalid widths', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'fold --width=0',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("fold: invalid width: '0'");
    expect(stderr.text).toContain('usage: fold [OPTION]... [FILE]...');
    expect(result.exitCode).toBe(1);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'fold --help',
    });

    expect(stdout.text).toContain('Wrap input lines to fit in specified width');
    expect(stdout.text).toContain('usage: fold [OPTION]... [FILE]...');
    expect(stdout.text).toContain('--bytes');
    expect(stdout.text).toContain('--width');
    expect(stdout.text).toContain('--spaces');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accepts an explicit positive sign in width operands', async () => {
    const execution = await execute({
      script: 'fold -w +2',
      stdinText: 'abc\n',
    });

    expect(execution.stdout.text).toBe(`\
ab
c
`);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('stops argv processing when --help is reached before a later invalid option', async () => {
    const helpFirst = await execute({ script: 'fold --help --definitely-invalid-option' });
    const invalidFirst = await execute({ script: 'fold --definitely-invalid-option --help' });

    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stdout.text).not.toBe('');
    expect(helpFirst.stderr.text).toBe('');

    expect(invalidFirst.result.exitCode).not.toBe(0);
    expect(invalidFirst.stderr.text).not.toBe('');
  });

});
