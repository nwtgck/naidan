import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh awk', () => {
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
    data: string;
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

  it('prints help and rejects invalid options', async () => {
    const help = await execute({ script: 'awk --help' });
    const invalid = await execute({ script: 'awk --bogus' });

    expect(help.stdout.text).toContain('Pattern scanning and processing language');
    expect(help.stdout.text).toContain('usage: awk [-F FS] [-v VAR=VALUE] [-f PROGRAM_FILE] [--] PROGRAM [FILE]...');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("awk: unrecognized option '--bogus'");
    expect(invalid.stderr.text).toContain('usage: awk [-F FS] [-v VAR=VALUE] [-f PROGRAM_FILE] [--] PROGRAM [FILE]...');
    expect(invalid.result.exitCode).toBe(2);
  });

  it('supports inline programs with BEGIN, END, fields, and variables', async () => {
    await writeFile({
      path: 'people.txt',
      data: `\
alice:10
bob:20
`,
    });

    const { result, stdout, stderr } = await execute({
      script: `\
awk -F: -v prefix=ID 'BEGIN { print prefix } { print $1, $2 } END { print NR }' people.txt`,
    });

    expect(stdout.text).toBe(`\
ID
alice 10
bob 20
2
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports regex patterns and -f program files', async () => {
    await writeFile({
      path: 'program.awk',
      data: `\
/foo/ { print $1 }
END { print NR }`,
    });
    await writeFile({
      path: 'input.txt',
      data: `\
foo one
bar two
foo three
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'awk -f program.awk input.txt',
    });

    expect(stdout.text).toBe(`\
foo
foo
3
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reads stdin when no files are provided', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
awk '{ print $1 }'`,
      stdinText: `\
alpha beta
gamma delta
`,
    });

    expect(stdout.text).toBe(`\
alpha
gamma
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports missing program and file errors', async () => {
    const missingProgram = await execute({ script: 'awk' });
    const missingFile = await execute({ script: `awk '{ print $1 }' missing.txt` });

    expect(missingProgram.stdout.text).toBe('');
    expect(missingProgram.stderr.text).toContain('awk: missing program source');
    expect(missingProgram.stderr.text).toContain('usage: awk [-F FS] [-v VAR=VALUE] [-f PROGRAM_FILE] [--] PROGRAM [FILE]...');
    expect(missingProgram.result.exitCode).toBe(1);

    expect(missingFile.stdout.text).toBe('');
    expect(missingFile.stderr.text).toContain('awk: missing.txt:');
    expect(missingFile.result.exitCode).toBe(1);
  });

  it('supports if/else with logical operators and string concatenation', async () => {
    await writeFile({
      path: 'scores.txt',
      data: `\
alice 10
bob 20
carol 30
`,
    });

    const { result, stdout, stderr } = await execute({
      script: `\
awk '{ if ($2 >= 20 && !($1 == "carol")) print "ok:" $1; else print "skip:" $1 }' scores.txt`,
    });

    expect(stdout.text).toBe(`\
skip:alice
ok:bob
skip:carol
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports next to skip remaining actions for a record', async () => {
    await writeFile({
      path: 'events.txt',
      data: `\
keep one
skip two
keep three
`,
    });

    const { result, stdout, stderr } = await execute({
      script: `\
awk '/skip/ { next } { print $1 }' events.txt`,
    });

    expect(stdout.text).toBe(`\
keep
keep
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
