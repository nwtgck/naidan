import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh sed', () => {
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

  async function readFile({
    path,
  }: {
    path: string;
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) throw new Error('path must include a file name');

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment);
    }

    const handle = await dir.getFileHandle(fileName);
    const file = await handle.getFile();
    return await file.text();
  }

  async function execute({
    script,
    stdinText,
  }: {
    script: string;
    stdinText?: string;
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

  it('applies substitution scripts from the command line', async () => {
    await writeFile({ path: 'input.txt', data: `\
alpha
beta
` });

    const { result, stdout, stderr } = await execute({
      script: "sed 's/a/A/g' input.txt",
    });

    expect(stdout.text).toBe(`\
AlphA
betA
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports multiple -e scripts with -n and p', async () => {
    await writeFile({ path: 'input.txt', data: `\
alpha
beta
` });

    const { result, stdout, stderr } = await execute({
      script: "sed -n -e 's/a/A/gp' -e '/beta/p' input.txt",
    });

    expect(stdout.text).toBe(`\
AlphA
betA
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports script files with -f', async () => {
    await writeFile({ path: 'script.sed', data: `\
1d
s/e/E/g
` });
    await writeFile({ path: 'input.txt', data: `\
alpha
beta
` });

    const { result, stdout, stderr } = await execute({
      script: 'sed -f script.sed input.txt',
    });

    expect(stdout.text).toBe('bEta\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports regex and range addresses', async () => {
    await writeFile({ path: 'input.txt', data: `\
alpha
beta
gamma
omega
` });

    const { result, stdout, stderr } = await execute({
      script: "sed '/beta/,/omega/d' input.txt",
    });

    expect(stdout.text).toBe('alpha\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports in-place editing with backup suffixes', async () => {
    await writeFile({ path: 'input.txt', data: `\
alpha
beta
` });

    const { result, stdout, stderr } = await execute({
      script: "sed -i.bak 's/a/A/g' input.txt",
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await readFile({ path: 'input.txt' })).toBe(`\
AlphA
betA
`);
    expect(await readFile({ path: 'input.txt.bak' })).toBe(`\
alpha
beta
`);
  });

  it('reads from stdin when no file is given', async () => {
    const { result, stdout, stderr } = await execute({
      script: "sed 's/a/A/g'",
      stdinText: `\
alpha
beta
`,
    });

    expect(stdout.text).toBe(`\
AlphA
betA
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('coalesces stdout writes when many stdin lines are transformed', async () => {
    const stdinText = Array.from({ length: 200 }, () => 'w:t> alpha xml:space').join('\n') + '\n';

    const { result, stdout, stderr } = await execute({
      script: "sed -e 's/w:t[^>]*>//g' -e 's/xml:.*//g' -e 's/ //g'",
      stdinText,
    });

    expect(stdout.text).toBe(Array.from({ length: 200 }, () => 'alpha\n').join(''));
    expect(stdout.chunkCount).toBeLessThan(20);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports q to quit after the addressed line', async () => {
    await writeFile({ path: 'input.txt', data: `\
alpha
beta
gamma
` });

    const { result, stdout, stderr } = await execute({
      script: "sed '2q' input.txt",
    });

    expect(stdout.text).toBe(`\
alpha
beta
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports y for character translation', async () => {
    await writeFile({ path: 'input.txt', data: `\
alpha
beta
` });

    const { result, stdout, stderr } = await execute({
      script: "sed 'y/ab/AB/' input.txt",
    });

    expect(stdout.text).toBe(`\
AlphA
BetA
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports i and a text commands', async () => {
    await writeFile({ path: 'input.txt', data: `\
alpha
beta
gamma
` });

    const { result, stdout, stderr } = await execute({
      script: "sed -e '2i\\BEFORE' -e '2a\\AFTER' input.txt",
    });

    expect(stdout.text).toBe(`\
alpha
BEFORE
beta
AFTER
gamma
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports c for line and range replacement', async () => {
    await writeFile({ path: 'input.txt', data: `\
alpha
beta
gamma
delta
` });

    const single = await execute({
      script: "sed '2c\\MIDDLE' input.txt",
    });
    const ranged = await execute({
      script: "sed '2,3c\\BLOCK' input.txt",
    });

    expect(single.stdout.text).toBe(`\
alpha
MIDDLE
gamma
delta
`);
    expect(single.stderr.text).toBe('');
    expect(single.result.exitCode).toBe(0);

    expect(ranged.stdout.text).toBe(`\
alpha
BLOCK
delta
`);
    expect(ranged.stderr.text).toBe('');
    expect(ranged.result.exitCode).toBe(0);
  });

  it('reports unsupported commands with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: "sed 'b label' input.txt",
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("sed: unsupported sed command 'b'");
    expect(stderr.text).toContain('usage: sed');
    expect(result.exitCode).toBe(1);
  });
});
