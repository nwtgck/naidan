import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh grep', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    path,
    data,
  }: {
    path: string;
    data: string | Uint8Array;
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
  }: {
    script: string;
    stdinText?: string;
  }) {
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createWeshReadFileHandleFromText({ text: stdinText ?? '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints matching lines and returns 0 when a match is found', async () => {
    await writeFile({ path: 'notes.txt', data: 'alpha\nbeta\nalpha beta\n' });

    const { result, stdout, stderr } = await execute({ script: 'grep alpha notes.txt' });

    expect(stdout.text).toBe('alpha\nalpha beta\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('returns 1 without stderr when no lines match', async () => {
    await writeFile({ path: 'notes.txt', data: 'alpha\nbeta\n' });

    const { result, stdout, stderr } = await execute({ script: 'grep gamma notes.txt' });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('supports repeated -e patterns', async () => {
    await writeFile({ path: 'notes.txt', data: 'alpha\nbeta\ngamma\n' });

    const { result, stdout, stderr } = await execute({
      script: 'grep -e alpha -e gamma notes.txt',
    });

    expect(stdout.text).toBe('alpha\ngamma\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accepts -E for extended regular expressions', async () => {
    await writeFile({ path: 'page_titles.txt', data: [
      'pages/a.xml.gz\t内閣総理大臣\n',
      'pages/b.xml.gz\t国会\n',
      'pages/c.xml.gz\t第99代内閣総理大臣\n',
    ].join('') });

    const { result, stdout, stderr } = await execute({
      script: 'grep -E "^pages/.*\\.xml\\.gz.*内閣総理大臣$" page_titles.txt',
    });

    expect(stdout.text).toBe('pages/a.xml.gz\t内閣総理大臣\npages/c.xml.gz\t第99代内閣総理大臣\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -f pattern files', async () => {
    await writeFile({ path: 'patterns.txt', data: 'alpha\ngamma\n' });
    await writeFile({ path: 'notes.txt', data: 'alpha\nbeta\ngamma\n' });

    const { result, stdout, stderr } = await execute({
      script: 'grep -f patterns.txt notes.txt',
    });

    expect(stdout.text).toBe('alpha\ngamma\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -c to print per-file match counts', async () => {
    await writeFile({ path: 'left.txt', data: 'alpha\nbeta\nalpha\n' });
    await writeFile({ path: 'right.txt', data: 'gamma\nalpha\n' });

    const { result, stdout, stderr } = await execute({
      script: 'grep -c alpha left.txt right.txt',
    });

    expect(stdout.text).toBe('left.txt:2\nright.txt:1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -l to print only matching file names once', async () => {
    await writeFile({ path: 'left.txt', data: 'alpha\nbeta\nalpha\n' });
    await writeFile({ path: 'right.txt', data: 'gamma\n' });

    const { result, stdout, stderr } = await execute({
      script: 'grep -l alpha left.txt right.txt',
    });

    expect(stdout.text).toBe('left.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -h and -H to control filename prefixes', async () => {
    await writeFile({ path: 'left.txt', data: 'alpha\n' });
    await writeFile({ path: 'right.txt', data: 'alpha\n' });

    const withoutNames = await execute({
      script: 'grep -h alpha left.txt right.txt',
    });
    const withNames = await execute({
      script: 'grep -H alpha left.txt',
    });

    expect(withoutNames.stdout.text).toBe('alpha\nalpha\n');
    expect(withNames.stdout.text).toBe('left.txt:alpha\n');
    expect(withoutNames.stderr.text).toBe('');
    expect(withNames.stderr.text).toBe('');
    expect(withoutNames.result.exitCode).toBe(0);
    expect(withNames.result.exitCode).toBe(0);
  });

  it('supports -q to suppress output while preserving the exit status', async () => {
    await writeFile({ path: 'notes.txt', data: 'alpha\nbeta\n' });

    const matched = await execute({ script: 'grep -q alpha notes.txt' });
    const missed = await execute({ script: 'grep -q gamma notes.txt' });

    expect(matched.stdout.text).toBe('');
    expect(missed.stdout.text).toBe('');
    expect(matched.stderr.text).toBe('');
    expect(missed.stderr.text).toBe('');
    expect(matched.result.exitCode).toBe(0);
    expect(missed.result.exitCode).toBe(1);
  });

  it('treats - as stdin when it appears in the file list', async () => {
    await writeFile({ path: 'notes.txt', data: 'alpha file\nbeta file\n' });

    const { result, stdout, stderr } = await execute({
      script: 'grep alpha - notes.txt',
      stdinText: 'alpha stdin\nbeta stdin\n',
    });

    expect(stdout.text).toBe('(standard input):alpha stdin\nnotes.txt:alpha file\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints usage on invalid options', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'grep --definitely-not-real alpha',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("grep: unrecognized option '--definitely-not-real'");
    expect(stderr.text).toContain('usage: grep');
    expect(result.exitCode).toBe(2);
  });

  it('works in a pipeline with head -20 using -E', async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `pages/${index}.xml.gz\t内閣総理大臣\n`).join('');
    await writeFile({ path: 'page_titles.txt', data: lines });

    const { result, stdout, stderr } = await execute({
      script: 'grep -E "^pages/.*\\.xml\\.gz.*内閣総理大臣$" page_titles.txt | head -20',
    });

    expect(stdout.text.trimEnd().split('\n')).toHaveLength(20);
    expect(stdout.text).toContain('pages/0.xml.gz\t内閣総理大臣\n');
    expect(stdout.text).toContain('pages/19.xml.gz\t内閣総理大臣\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
