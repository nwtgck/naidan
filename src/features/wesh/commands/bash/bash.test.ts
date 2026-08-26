import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { readShellSourceToText } from '@/features/wesh/shell/source';
import type { ShellInvocation } from '@/features/wesh/shell/invocation';
import type { WeshFileHandle } from '@/features/wesh/types';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';
import { createBashCommandDefinition } from './index';

async function readFileHandleText({ handle }: {
  handle: WeshFileHandle,
}): Promise<string | undefined> {
  const stat = await handle.stat();
  if (stat.type !== 'file') {
    return undefined;
  }
  const buffer = new Uint8Array(stat.size);
  const { bytesRead } = await handle.read({
    buffer,
    offset: 0,
    length: buffer.length,
    position: undefined,
  });
  return new TextDecoder().decode(buffer.subarray(0, bytesRead));
}

describe('bash command entrypoint', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;
  let invocations: ShellInvocation[];
  let capturedSourceTexts: Array<string | undefined>;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
    });
    await wesh.init();
    invocations = [];
    capturedSourceTexts = [];
    wesh.registerCommand({
      definition: createBashCommandDefinition({
        executeShellInvocation: async ({ context: _context, invocation }) => {
          invocations.push(invocation);
          capturedSourceTexts.push(invocation.source.kind === 'handle'
            ? await readFileHandleText({ handle: invocation.source.handle })
            : await readShellSourceToText({ source: invocation.source }));
          return { exitCode: 23 };
        },
      }),
    });
  });

  async function execute({ script, stdin }: {
    script: string,
    stdin: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: stdin }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return { result, stdout, stderr };
  }


  it('converts bash -c into a shell invocation without implementing shell semantics', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
bash -e -u -o pipefail -c 'printf "%s" "$1"' script-name value
`,
      stdin: '',
    });

    expect(result.exitCode).toBe(23);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(invocations).toHaveLength(1);
    expect(capturedSourceTexts[0]).toBe('printf "%s" "$1"');
    expect(invocations[0]).toMatchObject({
      argv0: 'script-name',
      positionalArgs: ['value'],
      executionOptions: {
        errexit: true,
        nounset: true,
        pipefail: true,
      },
      mode: 'execute',
    });
  });

  it('passes Bash -O and +O overrides to shell core without implementing shopt semantics', async () => {
    const { result } = await execute({
      script: "bash -O extglob -O nullglob +O extglob -c 'true'",
      stdin: '',
    });

    expect(result.exitCode).toBe(23);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      shellOptionOverrides: [
        { name: 'extglob', enabled: false },
        { name: 'nullglob', enabled: true },
      ],
    });
  });

  it('passes stdin through as the shell source for bash -s', async () => {
    const { result } = await execute({
      script: 'bash -s one two',
      stdin: "printf 'from stdin\\n'\n",
    });

    expect(result.exitCode).toBe(23);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      source: { kind: 'handle' },
      argv0: 'bash',
      positionalArgs: ['one', 'two'],
    });
  });

  it('preserves a script shebang for the shell parser to treat as a comment', async () => {
    const scriptFile = await rootHandle.getFileHandle('script.sh', { create: true });
    const writable = await scriptFile.createWritable();
    await writable.write(`\
#!/usr/bin/env bash
printf 'ok\\n'
`);
    await writable.close();

    const { result } = await execute({
      script: 'bash /script.sh arg',
      stdin: '',
    });

    expect(result.exitCode).toBe(23);
    expect(invocations).toHaveLength(1);
    expect(capturedSourceTexts[0]).toBe(`\
#!/usr/bin/env bash
printf 'ok\\n'
`);
    expect(invocations[0]).toMatchObject({
      argv0: '/script.sh',
      positionalArgs: ['arg'],
    });
  });

  it('uses Bash status 127 for an empty script path', async () => {
    const { result, stderr } = await execute({
      script: "bash ''",
      stdin: '',
    });

    expect(result.exitCode).toBe(127);
    expect(stderr.text).toBe('bash: : No such file or directory\n');
    expect(invocations).toHaveLength(0);
  });

  it('rejects Bash binary script prefixes without consuming the file cursor', async () => {
    const binaryScript = await rootHandle.getFileHandle('binary.sh', { create: true });
    const writable = await binaryScript.createWritable();
    await writable.write(new Uint8Array([
      ...new TextEncoder().encode('echo '),
      0,
      ...new TextEncoder().encode(`\
bad
printf after
`),
    ]));
    await writable.close();

    const { result, stderr } = await execute({
      script: 'bash /binary.sh',
      stdin: '',
    });

    expect(result.exitCode).toBe(126);
    expect(stderr.text).toBe('bash: /binary.sh: cannot execute binary file\n');
    expect(invocations).toHaveLength(0);
  });

  it('does not classify NUL after the first newline or at byte 80 as a binary prefix', async () => {
    const afterNewline = await rootHandle.getFileHandle('nul-after-newline.sh', { create: true });
    const afterNewlineWritable = await afterNewline.createWritable();
    await afterNewlineWritable.write(new Uint8Array([
      ...new TextEncoder().encode(':\n'),
      0,
      ...new TextEncoder().encode(`\
printf later
`),
    ]));
    await afterNewlineWritable.close();

    const atByte80 = await rootHandle.getFileHandle('nul-at-byte-80.sh', { create: true });
    const atByte80Writable = await atByte80.createWritable();
    await atByte80Writable.write(new Uint8Array([
      ...new TextEncoder().encode('a'.repeat(80)),
      0,
      0x0a,
    ]));
    await atByte80Writable.close();

    expect((await execute({ script: 'bash /nul-after-newline.sh', stdin: '' })).result.exitCode)
      .toBe(23);
    expect((await execute({ script: 'bash /nul-at-byte-80.sh', stdin: '' })).result.exitCode)
      .toBe(23);
    expect(invocations).toHaveLength(2);
  });

  it('keeps help handling in the bash command layer', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'bash --help',
      stdin: '',
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
bash: bash shell compatibility entrypoint
usage: bash [-c command] [file [argument...]]
`);
    expect(stderr.text).toBe('');
    expect(invocations).toHaveLength(0);
  });

  it('reports script-open failures before entering shell core', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'bash /missing.sh',
      stdin: '',
    });

    expect(result.exitCode).toBe(127);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('bash: /missing.sh: No such file or directory\n');
    expect(invocations).toHaveLength(0);
  });

  it('uses Bash status 126 and directory diagnostics for invalid script path types', async () => {
    await rootHandle.getDirectoryHandle('script-dir', { create: true });
    const scriptFile = await rootHandle.getFileHandle('plain-file', { create: true });
    const writable = await scriptFile.createWritable();
    await writable.write(':\n');
    await writable.close();

    const directory = await execute({
      script: 'bash /script-dir',
      stdin: '',
    });
    const trailingSlash = await execute({
      script: 'bash /plain-file/',
      stdin: '',
    });
    const nonDirectoryParent = await execute({
      script: 'bash /plain-file/child',
      stdin: '',
    });

    expect(directory.result.exitCode).toBe(126);
    expect(directory.stdout.text).toBe('');
    expect(directory.stderr.text).toBe('/script-dir: /script-dir: Is a directory\n');
    expect(trailingSlash.result.exitCode).toBe(126);
    expect(trailingSlash.stderr.text).toBe('bash: /plain-file/: Not a directory\n');
    expect(nonDirectoryParent.result.exitCode).toBe(126);
    expect(nonDirectoryParent.stderr.text).toBe('bash: /plain-file/child: Not a directory\n');
    expect(invocations).toHaveLength(0);
  });

  it('normalizes Bash diagnostics for a script path symlink loop', async () => {
    await execute({
      script: 'ln -s /loop2 /loop1; ln -s /loop1 /loop2',
      stdin: '',
    });

    const { result, stdout, stderr } = await execute({
      script: 'bash /loop1',
      stdin: '',
    });

    expect(result.exitCode).toBe(126);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('bash: /loop1: Too many levels of symbolic links\n');
    expect(invocations).toHaveLength(0);
  });

  it('keeps parse-only mode in the generic shell invocation', async () => {
    const { result } = await execute({
      script: "bash -n -c 'if true; then'",
      stdin: '',
    });

    expect(result.exitCode).toBe(23);
    expect(invocations[0]).toMatchObject({ mode: 'parse-only' });
  });
});
