import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { createTextShellSource, type ShellSource } from '@/features/wesh/shell/source';
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

function createTestReadErrorHandle({ type, message }: {
  type: 'file' | 'chardev',
  message: string,
}): WeshFileHandle {
  const base = createTestReadHandleFromBytes({ bytes: new Uint8Array() });
  return {
    read: async () => {
      throw new Error(message);
    },
    write: args => base.write(args),
    close: () => base.close(),
    async stat() {
      return { ...await base.stat(), type };
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
      source: createTextShellSource({ text: script }),
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

  it('passes supported -o and +o execution-option names into shell invocation state', async () => {
    const { result } = await execute({
      script: "bash -o errexit -o nounset -o noexec +o noexec -c 'true'",
      stdin: '',
    });

    expect(result.exitCode).toBe(23);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      executionOptions: {
        errexit: true,
        nounset: true,
        pipefail: false,
      },
      mode: 'execute',
    });
  });

  it('accepts Bash nolog as an ignored invocation shell option', async () => {
    for (const option of ['-o', '+o'] as const) {
      invocations = [];
      const { result, stderr } = await execute({
        script: `bash ${option} nolog -c 'true'`,
        stdin: '',
      });

      expect(result.exitCode).toBe(23);
      expect(stderr.text).toBe('');
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toMatchObject({
        executionOptions: {
          errexit: false,
          nounset: false,
          pipefail: false,
        },
        mode: 'execute',
      });
    }
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

  it('preserves successive -OO and +OO value claims through the Bash adapter', async () => {
    const minus = await execute({
      script: "bash -OO extglob nullglob -c 'true'",
      stdin: '',
    });
    const plus = await execute({
      script: "bash +OO extglob nullglob -c 'true'",
      stdin: '',
    });

    expect(minus.result.exitCode).toBe(23);
    expect(plus.result.exitCode).toBe(23);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toMatchObject({
      shellOptionOverrides: [
        { name: 'extglob', enabled: true },
        { name: 'nullglob', enabled: true },
      ],
    });
    expect(invocations[1]).toMatchObject({
      shellOptionOverrides: [
        { name: 'extglob', enabled: false },
        { name: 'nullglob', enabled: false },
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

  it('searches PATH for slashless Bash script operands after a cwd miss', async () => {
    const pathDirectory = await rootHandle.getDirectoryHandle('path-scripts', { create: true });
    const pathScript = await pathDirectory.getFileHandle('path-script', { create: true });
    const writable = await pathScript.createWritable();
    await writable.write("printf 'from path\\n'\n");
    await writable.close();

    const { result, stdout, stderr } = await execute({
      script: 'PATH=/path-scripts bash path-script arg',
      stdin: '',
    });

    expect(result.exitCode).toBe(23);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(invocations).toHaveLength(1);
    expect(capturedSourceTexts[0]).toBe("printf 'from path\\n'\n");
    expect(invocations[0]).toMatchObject({
      argv0: 'path-script',
      positionalArgs: ['arg'],
    });
  });

  it('prefers the cwd script over PATH and does not search PATH for slash-containing operands', async () => {
    const cwdScript = await rootHandle.getFileHandle('same-name', { create: true });
    const cwdWritable = await cwdScript.createWritable();
    await cwdWritable.write('cwd\n');
    await cwdWritable.close();

    const pathDirectory = await rootHandle.getDirectoryHandle('path-precedence', { create: true });
    const pathScript = await pathDirectory.getFileHandle('same-name', { create: true });
    const pathWritable = await pathScript.createWritable();
    await pathWritable.write('path\n');
    await pathWritable.close();
    const onlyOnPath = await pathDirectory.getFileHandle('only-on-path', { create: true });
    const onlyOnPathWritable = await onlyOnPath.createWritable();
    await onlyOnPathWritable.write('only path\n');
    await onlyOnPathWritable.close();

    const direct = await execute({
      script: 'PATH=/path-precedence bash same-name',
      stdin: '',
    });
    const explicitMissing = await execute({
      script: 'PATH=/path-precedence bash ./only-on-path',
      stdin: '',
    });

    expect(direct.result.exitCode).toBe(23);
    expect(direct.stderr.text).toBe('');
    expect(capturedSourceTexts[0]).toBe('cwd\n');
    expect(explicitMissing.result.exitCode).toBe(127);
    expect(explicitMissing.stderr.text).toBe('bash: ./only-on-path: No such file or directory\n');
    expect(invocations).toHaveLength(1);
  });

  it('skips unusable PATH candidates but selects the first readable script candidate', async () => {
    const firstDirectory = await rootHandle.getDirectoryHandle('path-first', { create: true });
    await firstDirectory.getDirectoryHandle('probe', { create: true });
    const secondDirectory = await rootHandle.getDirectoryHandle('path-second', { create: true });
    const secondScript = await secondDirectory.getFileHandle('probe', { create: true });
    const writable = await secondScript.createWritable();
    await writable.write('second\n');
    await writable.close();

    const { result, stderr } = await execute({
      script: 'PATH=/path-first:/path-second bash probe',
      stdin: '',
    });

    expect(result.exitCode).toBe(23);
    expect(stderr.text).toBe('');
    expect(capturedSourceTexts[0]).toBe('second\n');
    expect(invocations[0]).toMatchObject({ argv0: 'probe' });

    const fallbackScript = await secondDirectory.getFileHandle('unreadable-probe', { create: true });
    const fallbackWritable = await fallbackScript.createWritable();
    await fallbackWritable.write('fallback\n');
    await fallbackWritable.close();
    wesh.vfs.registerSpecialFile({
      path: '/path-first/unreadable-probe',
      type: 'file',
      handler: () => {
        throw new Error('Permission denied');
      },
    });
    try {
      const unreadable = await execute({
        script: 'PATH=/path-first:/path-second bash unreadable-probe',
        stdin: '',
      });
      expect(unreadable.result.exitCode).toBe(23);
      expect(unreadable.stderr.text).toBe('');
      expect(capturedSourceTexts[1]).toBe('fallback\n');
      expect(invocations[1]).toMatchObject({ argv0: 'unreadable-probe' });
    } finally {
      wesh.vfs.unregisterSpecialFile({ path: '/path-first/unreadable-probe' });
    }
  });

  it('selects FIFO and character-device scripts found through PATH', async () => {
    await rootHandle.getDirectoryHandle('path-special', { create: true });
    const fifoSource = "printf 'from PATH fifo\\n'\n";
    const fifoHandle = createTestReadHandleFromText({ text: fifoSource });
    wesh.vfs.registerSpecialFile({
      path: '/path-special/fifo-probe',
      type: 'fifo',
      handler: () => fifoHandle,
    });
    const chardevSource = "printf 'from PATH chardev\\n'\n";
    const chardevHandle = createTestCharacterDeviceHandleFromBytes({
      bytes: new TextEncoder().encode(chardevSource),
    });
    wesh.vfs.registerSpecialFile({
      path: '/path-special/chardev-probe',
      type: 'chardev',
      handler: () => chardevHandle,
    });

    try {
      const fifo = await execute({
        script: 'PATH=/path-special bash fifo-probe',
        stdin: '',
      });
      const chardev = await execute({
        script: 'PATH=/path-special bash chardev-probe',
        stdin: '',
      });

      expect(fifo.result.exitCode).toBe(23);
      expect(fifo.stderr.text).toBe('');
      expect(chardev.result.exitCode).toBe(23);
      expect(chardev.stderr.text).toBe('');
      expect(capturedSourceTexts).toEqual([fifoSource, chardevSource]);
      expect(invocations).toHaveLength(2);
      expect(invocations[0]).toMatchObject({ argv0: 'fifo-probe' });
      expect(invocations[1]).toMatchObject({ argv0: 'chardev-probe' });
    } finally {
      wesh.vfs.unregisterSpecialFile({ path: '/path-special/fifo-probe' });
      wesh.vfs.unregisterSpecialFile({ path: '/path-special/chardev-probe' });
    }
  });

  it('does not skip a PATH candidate that is found but fails with a non-search open error', async () => {
    const fallbackDirectory = await rootHandle.getDirectoryHandle('path-io-fallback', { create: true });
    const fallbackScript = await fallbackDirectory.getFileHandle('io-probe', { create: true });
    const writable = await fallbackScript.createWritable();
    await writable.write('fallback\n');
    await writable.close();
    await rootHandle.getDirectoryHandle('path-io-first', { create: true });
    wesh.vfs.registerSpecialFile({
      path: '/path-io-first/io-probe',
      type: 'file',
      handler: () => {
        throw new Error('Input/output error');
      },
    });

    try {
      const normal = await execute({
        script: 'PATH=/path-io-first:/path-io-fallback bash io-probe',
        stdin: '',
      });
      const errexit = await execute({
        script: 'PATH=/path-io-first:/path-io-fallback bash -e io-probe',
        stdin: '',
      });

      expect(normal.result.exitCode).toBe(126);
      expect(normal.stderr.text).toBe('bash: /path-io-first/io-probe: Input/output error\n');
      expect(errexit.result.exitCode).toBe(1);
      expect(errexit.stderr.text).toBe('bash: /path-io-first/io-probe: Input/output error\n');
      expect(invocations).toHaveLength(0);
    } finally {
      wesh.vfs.unregisterSpecialFile({ path: '/path-io-first/io-probe' });
    }
  });

  it('does not fall through after a selected PATH script has a regular-file read error', async () => {
    const fallbackDirectory = await rootHandle.getDirectoryHandle('path-read-fallback', { create: true });
    const fallbackScript = await fallbackDirectory.getFileHandle('read-probe', { create: true });
    const writable = await fallbackScript.createWritable();
    await writable.write('fallback\n');
    await writable.close();
    await rootHandle.getDirectoryHandle('path-read-first', { create: true });
    wesh.vfs.registerSpecialFile({
      path: '/path-read-first/read-probe',
      type: 'file',
      handler: () => createTestReadErrorHandle({ type: 'file', message: 'Input/output error' }),
    });

    try {
      const normal = await execute({
        script: 'PATH=/path-read-first:/path-read-fallback bash read-probe',
        stdin: '',
      });
      const errexit = await execute({
        script: 'PATH=/path-read-first:/path-read-fallback bash -e read-probe',
        stdin: '',
      });

      expect(normal.result.exitCode).toBe(126);
      expect(normal.stderr.text).toBe(
        '/path-read-first/read-probe: /path-read-first/read-probe: Input/output error\n',
      );
      expect(errexit.result.exitCode).toBe(1);
      expect(errexit.stderr.text).toBe(
        '/path-read-first/read-probe: /path-read-first/read-probe: Input/output error\n',
      );
      expect(invocations).toHaveLength(0);
    } finally {
      wesh.vfs.unregisterSpecialFile({ path: '/path-read-first/read-probe' });
    }
  });

  it('reports the original script operand when every PATH candidate is unusable', async () => {
    const firstDirectory = await rootHandle.getDirectoryHandle('path-unusable-first', { create: true });
    await firstDirectory.getDirectoryHandle('missing-probe', { create: true });
    await rootHandle.getDirectoryHandle('path-unusable-second', { create: true });
    await execute({
      script: 'ln -s /missing-target /path-unusable-second/missing-probe',
      stdin: '',
    });

    const normal = await execute({
      script: 'PATH=/path-unusable-first:/path-unusable-second bash missing-probe',
      stdin: '',
    });
    const errexit = await execute({
      script: 'PATH=/path-unusable-first:/path-unusable-second bash -e missing-probe',
      stdin: '',
    });

    expect(normal.result.exitCode).toBe(127);
    expect(normal.stderr.text).toBe('bash: missing-probe: No such file or directory\n');
    expect(errexit.result.exitCode).toBe(1);
    expect(errexit.stderr.text).toBe('bash: missing-probe: No such file or directory\n');
    expect(invocations).toHaveLength(0);
  });

  it('matches Bash PATH fallback for broken and looping script symlinks', async () => {
    const pathDirectory = await rootHandle.getDirectoryHandle('path-symlink-fallback', { create: true });
    for (const name of ['broken-probe', 'loop-probe'] as const) {
      const script = await pathDirectory.getFileHandle(name, { create: true });
      const writable = await script.createWritable();
      await writable.write(`${name}\n`);
      await writable.close();
    }

    await execute({
      script: 'ln -s /missing-target /broken-probe; ln -s /loop-other /loop-probe; ln -s /loop-probe /loop-other',
      stdin: '',
    });

    const broken = await execute({
      script: 'PATH=/path-symlink-fallback bash broken-probe',
      stdin: '',
    });
    const loop = await execute({
      script: 'PATH=/path-symlink-fallback bash loop-probe',
      stdin: '',
    });

    expect(broken.result.exitCode).toBe(23);
    expect(broken.stderr.text).toBe('');
    expect(capturedSourceTexts[0]).toBe('broken-probe\n');
    expect(loop.result.exitCode).toBe(126);
    expect(loop.stderr.text).toBe('bash: loop-probe: Too many levels of symbolic links\n');
    expect(invocations).toHaveLength(1);
  });

  it('does not fall back to PATH when the cwd script exists but cannot be opened', async () => {
    const pathDirectory = await rootHandle.getDirectoryHandle('path-fallback', { create: true });
    const pathScript = await pathDirectory.getFileHandle('blocked', { create: true });
    const writable = await pathScript.createWritable();
    await writable.write('fallback\n');
    await writable.close();
    wesh.vfs.registerSpecialFile({
      path: '/blocked',
      type: 'file',
      handler: () => {
        throw new Error('Permission denied');
      },
    });

    try {
      const { result, stderr } = await execute({
        script: 'PATH=/path-fallback bash blocked',
        stdin: '',
      });

      expect(result.exitCode).toBe(126);
      expect(stderr.text).toBe('bash: blocked: Permission denied\n');
      expect(invocations).toHaveLength(0);
    } finally {
      wesh.vfs.unregisterSpecialFile({ path: '/blocked' });
    }
  });

  it('uses the resolved PATH candidate in binary-script diagnostics while preserving argv0', async () => {
    const pathDirectory = await rootHandle.getDirectoryHandle('path-binary', { create: true });
    const pathScript = await pathDirectory.getFileHandle('binary-probe', { create: true });
    const writable = await pathScript.createWritable();
    await writable.write(new Uint8Array([
      ...new TextEncoder().encode('echo '),
      0,
      ...new TextEncoder().encode('bad\n'),
    ]));
    await writable.close();

    const { result, stderr } = await execute({
      script: 'PATH=/path-binary bash binary-probe',
      stdin: '',
    });

    expect(result.exitCode).toBe(126);
    expect(stderr.text).toBe(
      '/path-binary/binary-probe: /path-binary/binary-probe: cannot execute binary file\n',
    );

    const relative = await execute({
      script: 'PATH=path-binary bash binary-probe',
      stdin: '',
    });
    expect(relative.result.exitCode).toBe(126);
    expect(relative.stderr.text).toBe(
      'path-binary/binary-probe: path-binary/binary-probe: cannot execute binary file\n',
    );
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

  it('uses Bash errexit status 1 for script-path startup failures but not the binary gate', async () => {
    await rootHandle.getDirectoryHandle('errexit-dir', { create: true });
    const plainFile = await rootHandle.getFileHandle('errexit-plain', { create: true });
    const plainWritable = await plainFile.createWritable();
    await plainWritable.write(':\n');
    await plainWritable.close();
    await execute({
      script: 'ln -s /errexit-loop2 /errexit-loop1; ln -s /errexit-loop1 /errexit-loop2',
      stdin: '',
    });
    const binaryFile = await rootHandle.getFileHandle('errexit-binary', { create: true });
    const binaryWritable = await binaryFile.createWritable();
    await binaryWritable.write(new Uint8Array([
      ...new TextEncoder().encode('echo '),
      0,
      ...new TextEncoder().encode('bad\n'),
    ]));
    await binaryWritable.close();

    const cases = [
      { script: "bash -e ''", exitCode: 1, stderr: 'bash: : No such file or directory\n' },
      { script: 'bash -e /missing-errexit.sh', exitCode: 1, stderr: 'bash: /missing-errexit.sh: No such file or directory\n' },
      { script: 'bash -o errexit /missing-named.sh', exitCode: 1, stderr: 'bash: /missing-named.sh: No such file or directory\n' },
      { script: 'bash -e +o errexit /missing-disabled.sh', exitCode: 127, stderr: 'bash: /missing-disabled.sh: No such file or directory\n' },
      { script: 'bash -e /errexit-dir', exitCode: 1, stderr: '/errexit-dir: /errexit-dir: Is a directory\n' },
      { script: 'bash -e /errexit-dir/', exitCode: 1, stderr: '/errexit-dir/: /errexit-dir/: Is a directory\n' },
      { script: 'bash -e /errexit-plain/', exitCode: 1, stderr: 'bash: /errexit-plain/: Not a directory\n' },
      { script: 'bash -e /errexit-plain/child', exitCode: 1, stderr: 'bash: /errexit-plain/child: Not a directory\n' },
      { script: 'bash -e /errexit-loop1', exitCode: 1, stderr: 'bash: /errexit-loop1: Too many levels of symbolic links\n' },
      { script: 'bash -e /errexit-binary', exitCode: 126, stderr: '/errexit-binary: /errexit-binary: cannot execute binary file\n' },
    ] as const;

    for (const expected of cases) {
      const { result, stdout, stderr } = await execute({
        script: expected.script,
        stdin: '',
      });
      expect(result.exitCode, expected.script).toBe(expected.exitCode);
      expect(stdout.text, expected.script).toBe('');
      expect(stderr.text, expected.script).toBe(expected.stderr);
    }
    expect(invocations).toHaveLength(0);
  });

  it('applies errexit to otherwise-unclassified script open failures', async () => {
    wesh.vfs.registerSpecialFile({
      path: '/open-error.file',
      type: 'file',
      handler: () => {
        throw new Error('Permission denied');
      },
    });

    try {
      for (const expected of [
        { script: 'bash /open-error.file', exitCode: 126 },
        { script: 'bash -e /open-error.file', exitCode: 1 },
        { script: 'bash -o errexit /open-error.file', exitCode: 1 },
        { script: 'bash -e +o errexit /open-error.file', exitCode: 126 },
      ] as const) {
        const { result, stdout, stderr } = await execute({
          script: expected.script,
          stdin: '',
        });
        expect(result.exitCode, expected.script).toBe(expected.exitCode);
        expect(stdout.text, expected.script).toBe('');
        expect(stderr.text, expected.script).toBe(
          'bash: /open-error.file: Permission denied\n',
        );
      }
      expect(invocations).toHaveLength(0);
    } finally {
      wesh.vfs.unregisterSpecialFile({ path: '/open-error.file' });
    }
  });

  it('matches Bash read-error diagnostics and errexit status by source type', async () => {
    wesh.vfs.registerSpecialFile({
      path: '/read-error.file',
      type: 'file',
      handler: () => createTestReadErrorHandle({ type: 'file', message: 'Input/output error' }),
    });
    wesh.vfs.registerSpecialFile({
      path: '/read-error.chardev',
      type: 'chardev',
      handler: () => createTestReadErrorHandle({ type: 'chardev', message: 'Input/output error' }),
    });

    try {
      const cases = [
        {
          script: 'bash /read-error.file',
          exitCode: 126,
          stderr: '/read-error.file: /read-error.file: Input/output error\n',
        },
        {
          script: 'bash -e /read-error.file',
          exitCode: 1,
          stderr: '/read-error.file: /read-error.file: Input/output error\n',
        },
        {
          script: 'bash /read-error.chardev',
          exitCode: 2,
          stderr: '/read-error.chardev: error reading input file: Input/output error\n',
        },
        {
          script: 'bash -e /read-error.chardev',
          exitCode: 2,
          stderr: '/read-error.chardev: error reading input file: Input/output error\n',
        },
      ] as const;

      for (const expected of cases) {
        const { result, stdout, stderr } = await execute({
          script: expected.script,
          stdin: '',
        });
        expect(result.exitCode, expected.script).toBe(expected.exitCode);
        expect(stdout.text, expected.script).toBe('');
        expect(stderr.text, expected.script).toBe(expected.stderr);
      }
      expect(invocations).toHaveLength(0);
    } finally {
      wesh.vfs.unregisterSpecialFile({ path: '/read-error.file' });
      wesh.vfs.unregisterSpecialFile({ path: '/read-error.chardev' });
    }
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
