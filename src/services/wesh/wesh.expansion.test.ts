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
    directory,
    path,
    data,
  }: {
    directory?: MockFileSystemDirectoryHandle;
    path: string;
    data: string;
  }) {
    const targetDirectory = directory ?? rootHandle;
    const segments = path.split('/').filter((segment) => segment.length > 0);
    const fileName = segments.pop();
    if (fileName === undefined) {
      throw new Error(`Invalid file path: ${path}`);
    }

    let currentDirectory = targetDirectory;
    for (const segment of segments) {
      currentDirectory = await currentDirectory.getDirectoryHandle(segment, { create: true });
    }

    const handle = await currentDirectory.getFileHandle(fileName, { create: true });
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

  it('supports question-mark and character-class globs', async () => {
    await writeFile({ path: 'file1.txt', data: 'a' });
    await writeFile({ path: 'file2.txt', data: 'b' });
    await writeFile({ path: 'fileA.txt', data: 'c' });

    const question = await execute({
      script: 'for file in file?.txt; do echo "$file"; done',
    });
    expect(question.stdout.text).toBe(`\
file1.txt
file2.txt
fileA.txt
`);
    expect(question.stderr.text).toBe('');
    expect(question.result.exitCode).toBe(0);

    const characterClass = await execute({
      script: 'for file in file[12].txt; do echo "$file"; done',
    });
    expect(characterClass.stdout.text).toBe(`\
file1.txt
file2.txt
`);
    expect(characterClass.stderr.text).toBe('');
    expect(characterClass.result.exitCode).toBe(0);
  });

  it('treats ** like a single-segment glob unless globstar is enabled', async () => {
    await writeFile({ path: 'tree/alpha.txt', data: 'a' });
    await writeFile({ path: 'tree/deep/beta.txt', data: 'b' });
    await writeFile({ path: 'tree/deep/more/gamma.txt', data: 'c' });

    const defaultResult = await execute({
      script: 'for file in tree/**/*.txt; do echo "$file"; done',
    });
    expect(defaultResult.stdout.text).toBe('tree/deep/beta.txt\n');
    expect(defaultResult.stderr.text).toBe('');
    expect(defaultResult.result.exitCode).toBe(0);

    const { result, stdout, stderr } = await execute({
      script: `\
shopt -s globstar
for file in tree/**/*.txt; do echo "$file"; done`,
    });

    expect(stdout.text).toBe(`\
tree/alpha.txt
tree/deep/beta.txt
tree/deep/more/gamma.txt
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps relative parent segments in glob expansion results', async () => {
    await writeFile({ path: 'parent/item.txt', data: 'parent' });
    await execute({ script: 'mkdir -p child' });

    const { result, stdout, stderr } = await execute({
      script: 'cd child; for file in ../parent/*.txt; do echo "$file"; done',
    });

    expect(stdout.text).toBe('../parent/item.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports glob expansion inside mounted directories', async () => {
    const mountedRoot = new MockFileSystemDirectoryHandle('mounted');
    await writeFile({ directory: mountedRoot, path: 'nested/one.xml', data: '<one />' });
    await writeFile({ directory: mountedRoot, path: 'nested/deeper/two.xml', data: '<two />' });

    await wesh.vfs.mount({
      path: '/mounted',
      handle: mountedRoot as unknown as FileSystemDirectoryHandle,
      readOnly: false,
    });

    const { result, stdout, stderr } = await execute({
      script: `\
shopt -s globstar
for file in /mounted/**/*.xml; do echo "$file"; done`,
    });

    expect(stdout.text).toBe(`\
/mounted/nested/one.xml
/mounted/nested/deeper/two.xml
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports a normal path-not-found error for unmatched absolute globs', async () => {
    const mountedRoot = new MockFileSystemDirectoryHandle('mounted');
    await writeFile({ directory: mountedRoot, path: 'nested/one.xml', data: '<one />' });

    await wesh.vfs.mount({
      path: '/mounted',
      handle: mountedRoot as unknown as FileSystemDirectoryHandle,
      readOnly: false,
    });

    const { result, stdout, stderr } = await execute({
      script: 'ls /mounted/*.json',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('ls: /mounted/*.json:');
    expect(stderr.text).toContain("*.json");
    expect(stderr.text).not.toContain("getDirectoryHandle");
    expect(result.exitCode).toBe(1);
  });

  it('supports nullglob, failglob, and dotglob options', async () => {
    await writeFile({ path: '.hidden.txt', data: 'hidden' });
    await writeFile({ path: 'visible.txt', data: 'visible' });

    const nullglob = await execute({
      script: `\
shopt -s nullglob
echo begin
for file in *.missing; do echo "$file"; done
echo end`,
    });
    expect(nullglob.stdout.text).toBe(`\
begin
end
`);
    expect(nullglob.stderr.text).toBe('');
    expect(nullglob.result.exitCode).toBe(0);

    const failglob = await execute({
      script: `\
shopt -s failglob
echo *.missing`,
    });
    expect(failglob.stdout.text).toBe('');
    expect(failglob.stderr.text).toContain('wesh: no match: *.missing');
    expect(failglob.result.exitCode).toBe(1);

    const dotglob = await execute({
      script: `\
shopt -s dotglob
for file in *.txt; do echo "$file"; done`,
    });
    expect(dotglob.stdout.text).toBe(`\
.hidden.txt
visible.txt
`);
    expect(dotglob.stderr.text).toBe('');
    expect(dotglob.result.exitCode).toBe(0);
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

  it('supports prefix and suffix pattern removal parameter expansion', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
VALUE=src/services/wesh/index.ts
echo "\${VALUE#src/}"
echo "\${VALUE##*/}"
echo "\${VALUE%/*}"
echo "\${VALUE%%/*}"`,
    });

    expect(stdout.text).toBe(`\
services/wesh/index.ts
index.ts
src/services/wesh
src
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports common special parameters', async () => {
    const shellParams = await execute({
      script: `\
echo "$$"
echo "$#"
echo "$0"`,
    });

    const shellLines = shellParams.stdout.text.trimEnd().split('\n');
    expect(shellParams.result.exitCode).toBe(0);
    expect(shellParams.stderr.text).toBe('');
    expect(shellLines).toHaveLength(3);
    expect(shellLines[0]).toMatch(/^[0-9]+$/);
    expect(shellLines[1]).toBe('0');
    expect(shellLines[2]).toBe('/bin/wesh');

    const backgroundParams = await execute({
      script: 'sleep 0 & echo "$!"',
    });
    expect(backgroundParams.result.exitCode).toBe(0);
    expect(backgroundParams.stderr.text).toContain('[1] background');
    expect(backgroundParams.stdout.text).toMatch(/^[0-9]+\n$/);
  });
});
