import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import type { ShellSource } from '@/features/wesh/shell/source';
import type { ShellInvocation } from '@/features/wesh/shell/invocation';
import type { WeshFileHandle } from '@/features/wesh/types';
import {
  createTestReadHandleFromBytes,
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';
import { createBashCommandDefinition, TEST_ONLY } from './index';

async function readRawShellSourceToText({ source }: {
  source: ShellSource,
}): Promise<string> {
  switch (source.kind) {
  case 'text':
    return source.text;
  case 'bytes':
  case 'handle': {
    const chunks: Uint8Array[] = [];
    while (true) {
      let chunk: Uint8Array | undefined;
      switch (source.kind) {
      case 'bytes':
        chunk = await source.read({ maximumBytes: 64 * 1024 });
        break;
      case 'handle': {
        const buffer = new Uint8Array(64 * 1024);
        const { bytesRead } = await source.handle.read({
          buffer,
          offset: 0,
          length: buffer.length,
          position: undefined,
        });
        chunk = bytesRead === 0 ? undefined : buffer.subarray(0, bytesRead);
        break;
      }
      default: {
        const _ex: never = source;
        throw new Error(`Unhandled shell source: ${JSON.stringify(_ex)}`);
      }
      }
      if (chunk === undefined) {
        break;
      }
      chunks.push(new Uint8Array(chunk));
    }
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(combined);
  }
  default: {
    const _ex: never = source;
    throw new Error(`Unhandled shell source: ${JSON.stringify(_ex)}`);
  }
  }
}

function createTestCharacterDeviceHandleFromBytes({ bytes }: {
  bytes: Uint8Array,
}): WeshFileHandle {
  const base = createTestReadHandleFromBytes({ bytes });
  return {
    read: args => base.read(args),
    write: args => base.write(args),
    close: () => base.close(),
    async stat() {
      return { ...await base.stat(), type: 'chardev' };
    },
    truncate: args => base.truncate(args),
    ioctl: args => base.ioctl(args),
  };
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
          capturedSourceTexts.push(await readRawShellSourceToText({ source: invocation.source }));
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

  it('detects Bash binary prefixes across short positioned reads', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('a'.repeat(78)),
      0,
      0x0a,
    ]);
    const positions: number[] = [];
    const handle = {
      async read({ buffer, offset = 0, length = buffer.length - offset, position = 0 }: {
        buffer: Uint8Array,
        offset?: number,
        length?: number,
        position?: number,
      }) {
        positions.push(position);
        const bytesRead = Math.min(7, length, bytes.length - position);
        if (bytesRead <= 0) return { bytesRead: 0 };
        buffer.set(bytes.subarray(position, position + bytesRead), offset);
        return { bytesRead };
      },
    } as unknown as WeshFileHandle;

    await expect(TEST_ONLY.hasBashBinaryScriptPrefix({ handle })).resolves.toBe(true);
    expect(positions).toEqual([0, 7, 14, 21, 28, 35, 42, 49, 56, 63, 70, 77]);
  });

  it('does not consume FIFO script bytes while probing regular-file binary prefixes', async () => {
    const sourceText = "printf 'from fifo\\n'\n";
    const fifoHandle = createTestReadHandleFromText({ text: sourceText });
    wesh.vfs.registerSpecialFile({
      path: '/script.fifo',
      type: 'fifo',
      handler: () => fifoHandle,
    });

    try {
      const { result, stderr } = await execute({
        script: 'bash /script.fifo',
        stdin: '',
      });

      expect(result.exitCode).toBe(23);
      expect(stderr.text).toBe('');
      expect(invocations).toHaveLength(1);
      expect(capturedSourceTexts[0]).toBe(sourceText);
    } finally {
      wesh.vfs.unregisterSpecialFile({ path: '/script.fifo' });
    }
  });

  it('does not apply regular-file binary-prefix rejection to FIFO scripts', async () => {
    const sourceBytes = new Uint8Array([
      ...new TextEncoder().encode('echo '),
      0,
      ...new TextEncoder().encode('bad\n'),
    ]);
    const fifoHandle = createTestReadHandleFromBytes({ bytes: sourceBytes });
    wesh.vfs.registerSpecialFile({
      path: '/binary-looking.fifo',
      type: 'fifo',
      handler: () => fifoHandle,
    });

    try {
      const { result, stderr } = await execute({
        script: 'bash /binary-looking.fifo',
        stdin: '',
      });

      expect(result.exitCode).toBe(23);
      expect(stderr.text).toBe('');
      expect(invocations).toHaveLength(1);
      expect(capturedSourceTexts[0]).toBe('echo \0bad\n');
    } finally {
      wesh.vfs.unregisterSpecialFile({ path: '/binary-looking.fifo' });
    }
  });

  it('replays a non-binary character-device prefix after sequential probing', async () => {
    const sourceText = `#${'x'.repeat(100)}\nprintf 'from chardev\\n'\n`;
    const chardevHandle = createTestCharacterDeviceHandleFromBytes({
      bytes: new TextEncoder().encode(sourceText),
    });
    wesh.vfs.registerSpecialFile({
      path: '/script.chardev',
      type: 'chardev',
      handler: () => chardevHandle,
    });

    try {
      const { result, stderr } = await execute({
        script: 'bash /script.chardev',
        stdin: '',
      });

      expect(result.exitCode).toBe(23);
      expect(stderr.text).toBe('');
      expect(invocations).toHaveLength(1);
      expect(capturedSourceTexts[0]).toBe(sourceText);
    } finally {
      wesh.vfs.unregisterSpecialFile({ path: '/script.chardev' });
    }
  });

  it('applies Bash binary-prefix rejection to character-device scripts', async () => {
    const sourceBytes = new Uint8Array([
      ...new TextEncoder().encode('echo '),
      0,
      ...new TextEncoder().encode('bad\n'),
    ]);
    const chardevHandle = createTestCharacterDeviceHandleFromBytes({ bytes: sourceBytes });
    wesh.vfs.registerSpecialFile({
      path: '/binary-looking.chardev',
      type: 'chardev',
      handler: () => chardevHandle,
    });

    try {
      const { result, stderr } = await execute({
        script: 'bash /binary-looking.chardev',
        stdin: '',
      });

      expect(result.exitCode).toBe(126);
      expect(stderr.text).toBe('/binary-looking.chardev: /binary-looking.chardev: cannot execute binary file\n');
      expect(invocations).toHaveLength(0);
    } finally {
      wesh.vfs.unregisterSpecialFile({ path: '/binary-looking.chardev' });
    }
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
    expect(stderr.text).toBe('/binary.sh: /binary.sh: cannot execute binary file\n');
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
