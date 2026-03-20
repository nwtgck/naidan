import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from './utils/test-stream';

describe('wesh shell expansion', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
      initialEnv: {
        GREETING: 'hello world',
        FOO: 'persisted',
      },
    });
    await wesh.init();
  });

  async function writeFile({
    path,
    data,
  }: {
    path: string;
    data: string;
  }) {
    const handle = await rootHandle.getFileHandle(path, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function execute({
    script,
  }: {
    script: string;
  }) {
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createWeshReadFileHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('keeps single-quoted text literal while expanding double-quoted text', async () => {
    const { result, stdout, stderr } = await execute({
      script: `echo '$GREETING' "$GREETING"`,
    });

    expect(stdout.text).toBe('$GREETING hello world\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('splits unquoted variables into multiple argv fields', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'for item in $GREETING; do echo "<$item>"; done',
    });

    expect(stdout.text).toBe('<hello>\n<world>\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('expands globs while leaving quoted globs untouched', async () => {
    await writeFile({ path: 'alpha.txt', data: 'a' });
    await writeFile({ path: 'beta.txt', data: 'b' });

    const unquoted = await execute({ script: 'for file in *.txt; do echo "$file"; done' });
    expect(unquoted.stderr.text).toBe('');
    expect(unquoted.result.exitCode).toBe(0);
    expect(unquoted.stdout.text).toContain('alpha.txt');
    expect(unquoted.stdout.text).toContain('beta.txt');

    const quoted = await execute({ script: 'echo "*.txt"' });
    expect(quoted.stdout.text).toBe('*.txt\n');
    expect(quoted.stderr.text).toBe('');
    expect(quoted.result.exitCode).toBe(0);
  });

  it('expands a leading tilde during execution', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'echo ~/project',
    });

    expect(stdout.text).toBe('/project\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('expands variables in unquoted heredocs but not in quoted heredocs', async () => {
    const expanded = await execute({
      script: `\
cat <<EOF
$FOO
EOF`,
    });
    expect(expanded.stdout.text).toBe('persisted\n');
    expect(expanded.stderr.text).toBe('');
    expect(expanded.result.exitCode).toBe(0);

    const literal = await execute({
      script: `\
cat <<'EOF'
$FOO
EOF`,
    });
    expect(literal.stdout.text).toBe('$FOO\n');
    expect(literal.stderr.text).toBe('');
    expect(literal.result.exitCode).toBe(0);
  });

  it('passes temporary environment variables to a command without persisting them', async () => {
    const inside = await execute({ script: 'FOO=temp env | grep ^FOO=' });
    expect(inside.stdout.text).toBe('FOO=temp\n');
    expect(inside.stderr.text).toBe('');
    expect(inside.result.exitCode).toBe(0);

    const after = await execute({ script: 'echo "$FOO"' });
    expect(after.stdout.text).toBe('persisted\n');
    expect(after.stderr.text).toBe('');
    expect(after.result.exitCode).toBe(0);
  });

  it('supports default, alternate, and length parameter expansion', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
unset EMPTY MISSING
EMPTY=
echo "\${MISSING:-fallback}"
echo "\${EMPTY:-fallback}"
echo "\${EMPTY-fallback}"
echo "\${FOO:+present}"
echo "\${#FOO}"`,
    });

    expect(stdout.text).toBe('fallback\nfallback\n\npresent\n9\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports assignment parameter expansion and persists the assigned value', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
unset CREATED
echo "\${CREATED:=made}"
echo "$CREATED"`,
    });

    expect(stdout.text).toBe('made\nmade\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports parameter expansion errors with :? semantics', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
unset REQUIRED
echo "\${REQUIRED:?required value}"`,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('wesh: REQUIRED: required value');
    expect(result.exitCode).toBe(1);
  });
});
