import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh touch', () => {
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
    mtime,
  }: {
    path: string,
    data: string,
    mtime?: number,
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) {
      throw new Error('path must include a file name');
    }

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
    if (mtime !== undefined) {
      handle.lastModified = mtime;
    }
  }

  async function execute({
    script,
  }: {
    script: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints help and reports missing operands with usage', async () => {
    const help = await execute({
      script: 'touch --help',
    });
    const missing = await execute({
      script: 'touch',
    });

    expect(help.stdout.text).toContain('Update file timestamps or create empty files');
    expect(help.stdout.text).toContain('usage: touch [-chm] [-d STRING] [-r FILE] [-t STAMP] path...');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('touch: missing file operand');
    expect(missing.stderr.text).toContain('usage: touch');
    expect(missing.result.exitCode).toBe(1);
  });

  it('creates missing files by default', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
touch created.txt
test -e created.txt
echo $?`,
    });

    expect(stdout.text).toBe('0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('creates multiple files and accepts option-like paths after --', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
mkdir dir
touch a b dir/c -- -target
printf 'a=%s b=%s c=%s option=%s\n' \
  "$(test -e a; echo $?)" \
  "$(test -e b; echo $?)" \
  "$(test -e dir/c; echo $?)" \
  "$(test -e ./-target; echo $?)"`,
    });

    expect(stdout.text).toBe('a=0 b=0 c=0 option=0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -c to avoid creating missing files', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
touch -c missing.txt
test -e missing.txt
echo $?`,
    });

    expect(stdout.text).toBe('1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('updates mtime for existing files without changing contents', async () => {
    await writeFile({ path: 'file.txt', data: 'payload' });
    const before = await wesh.vfs.stat({ path: '/file.txt' });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });

    const { result, stdout, stderr } = await execute({
      script: `\
touch file.txt
cat file.txt`,
    });
    const after = await wesh.vfs.stat({ path: '/file.txt' });

    expect(stdout.text).toBe('payload');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(after.mtime).toBeGreaterThan(before.mtime);
  });

  it('persists a current-time update across a Wesh reload without changing file contents', async () => {
    await writeFile({ path: 'file.txt', data: 'payload', mtime: 1_000 });

    const touched = await execute({ script: 'touch file.txt' });
    const reloaded = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await reloaded.init();
    const afterReload = await reloaded.vfs.stat({ path: '/file.txt' });
    const content = await (await rootHandle.getFileHandle('file.txt')).getFile();

    expect(touched.stdout.text).toBe('');
    expect(touched.stderr.text).toBe('');
    expect(touched.result.exitCode).toBe(0);
    expect(afterReload.mtime).toBeGreaterThan(1_000);
    expect(await content.text()).toBe('payload');
  });

  it('silently ignores missing paths under -c even when an intermediate directory is absent', async () => {
    const result = await execute({
      script: `\
mkdir dir
ln -s ../missing-parent/target dir/link
touch -c missing/target a/b/c dir/link ''
printf 'status=%s missing=%s deep=%s link=%s target=%s\n' \
  "$?" \
  "$(test -e missing/target; echo $?)" \
  "$(test -e a/b/c; echo $?)" \
  "$(test -L dir/link; echo $?)" \
  "$(test -e missing-parent/target; echo $?)"`,
    });

    expect(result.stdout.text).toBe('status=0 missing=1 deep=1 link=0 target=1\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('does not hide non-missing path errors under -c', async () => {
    await writeFile({ path: 'file', data: 'payload' });

    const ordinary = await execute({
      script: `\
touch -c file/child
echo $?`,
    });
    const noDereference = await execute({
      script: `\
touch -hc file/child
echo $?`,
    });

    for (const { result, stdout, stderr } of [ordinary, noDereference]) {
      expect(stdout.text).toBe('1\n');
      expect(stderr.text).toContain("touch: cannot touch 'file/child':");
      expect(stderr.text).toMatch(/not a directory/i);
      expect(result.exitCode).toBe(0);
    }
  });

  it('returns non-zero when a target path cannot be touched', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
touch missing/file.txt
echo $?`,
    });

    expect(stdout.text).toBe('1\n');
    expect(stderr.text).toContain("touch: cannot touch 'missing/file.txt':");
    expect(result.exitCode).toBe(0);
  });

  it('fails when the reference file does not exist', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
touch -r missing.txt target.txt
echo $?`,
    });

    expect(stdout.text).toBe('1\n');
    expect(stderr.text).toContain("touch: failed to get attributes of 'missing.txt':");
    expect(result.exitCode).toBe(0);
  });

  it('updates a regular file with --no-dereference without requiring symlink metadata support', async () => {
    await writeFile({ path: 'regular.txt', data: 'payload', mtime: 1_000 });

    const result = await execute({ script: 'touch -h regular.txt' });
    const after = await wesh.vfs.stat({ path: '/regular.txt' });

    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
    expect(after.mtime).toBeGreaterThan(1_000);
    expect(await (await rootHandle.getFileHandle('regular.txt')).getFile().then(file => file.text())).toBe('payload');
  });

  it('does not create a missing operand with --no-dereference', async () => {
    const short = await execute({
      script: `\
touch -h short-missing
printf 'status=%s exists=%s\n' "$?" "$(test -e short-missing; echo $?)"`,
    });
    const long = await execute({
      script: `\
touch --no-dereference long-missing
printf 'status=%s exists=%s\n' "$?" "$(test -e long-missing; echo $?)"`,
    });

    expect(short.stdout.text).toBe('status=1 exists=1\n');
    expect(short.stderr.text).toContain("touch: cannot touch 'short-missing':");
    expect(short.result.exitCode).toBe(0);
    expect(long.stdout.text).toBe('status=1 exists=1\n');
    expect(long.stderr.text).toContain("touch: cannot touch 'long-missing':");
    expect(long.result.exitCode).toBe(0);
  });

  it('follows a dangling symbolic link and creates its target', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
ln -s target link
touch link
printf 'link=%s target=%s\n' "$(test -L link; echo $?)" "$(test -e target; echo $?)"`,
    });

    expect(stdout.text).toBe('link=0 target=0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('treats a lone dash as the GNU-compatible special operand', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
touch -
printf 'status=%s exists=%s\n' "$?" "$(test -e ./-; echo $?)"`,
    });

    expect(stdout.text).toBe('status=0 exists=1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accepts only ASCII whitespace in date expressions', async () => {
    const validValues = [
      ' now ',
      'today',
      ' 1 day ',
      '\t1 day\n',
      'NEXT DAY',
      '2024-01-02',
    ];
    for (const value of validValues) {
      const result = await execute({
        script: `touch -c -d '${value}' missing`,
      });
      expect(result.stdout.text).toBe('');
      expect(result.stderr.text).toBe('');
      expect(result.result.exitCode).toBe(0);
    }

    const invalidValues = [
      '\u00a0now',
      'now\u00a0',
      '1\u00a0day',
      '1\u2003day',
      'next\u202fday',
      '\ufeff2024-01-02',
      '1.5 hours',
      '0.5 day',
      '2024-01-02\u3000',
    ];
    for (const value of invalidValues) {
      const result = await execute({
        script: `touch -c -d '${value}' missing`,
      });
      expect(result.stdout.text).toBe('');
      expect(result.stderr.text).toContain('touch: invalid date format');
      expect(result.result.exitCode).toBe(1);
    }
  });

  it('rejects timestamp combinations with date or reference before creating targets', async () => {
    await writeFile({ path: 'reference.txt', data: 'reference' });

    const dateConflict = await execute({
      script: 'touch -d @1 -t 197001010000.02 date-conflict.txt',
    });
    const referenceConflict = await execute({
      script: 'touch -r reference.txt -t 197001010000.02 reference-conflict.txt',
    });

    expect(dateConflict.stdout.text).toBe('');
    expect(dateConflict.stderr.text).toContain('touch: cannot specify times from more than one source');
    expect(dateConflict.result.exitCode).toBe(1);
    await expect(wesh.vfs.stat({ path: '/date-conflict.txt' })).rejects.toThrow();

    expect(referenceConflict.stdout.text).toBe('');
    expect(referenceConflict.stderr.text).toContain('touch: cannot specify times from more than one source');
    expect(referenceConflict.result.exitCode).toBe(1);
    await expect(wesh.vfs.stat({ path: '/reference-conflict.txt' })).rejects.toThrow();
  });

  it('rejects a trailing slash after a symbolic link to a regular file', async () => {
    await writeFile({ path: 'file.txt', data: 'file' });
    const linked = await execute({ script: 'ln -s file.txt file-link' });
    expect(linked.result.exitCode).toBe(0);

    const ordinary = await execute({ script: 'touch -h file-link/' });
    const noCreate = await execute({ script: 'touch -hc file-link/' });

    for (const { result, stdout, stderr } of [ordinary, noCreate]) {
      expect(stdout.text).toBe('');
      expect(stderr.text).toContain("touch: cannot touch 'file-link/':");
      expect(result.exitCode).toBe(1);
    }
  });

  it('rejects unsupported access-time selection instead of fabricating metadata', async () => {
    const result = await execute({
      script: 'touch --time=access -d @1 file.txt',
    });

    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toContain("touch: invalid argument 'access' for '--time'");
    expect(result.result.exitCode).toBe(1);
    await expect(wesh.vfs.stat({ path: '/file.txt' })).rejects.toThrow();
  });

  it('reports an empty operand but continues to later operands', async () => {
    const result = await execute({
      script: `touch '' created
printf 'status=%s created=%s\n' "$?" "$(test -e created; echo $?)"`,
    });

    expect(result.stdout.text).toBe('status=1 created=0\n');
    expect(result.stderr.text).toContain("touch: cannot touch '':");
    expect(result.result.exitCode).toBe(0);
  });

  it('validates -t and --time semantics before a later --help', async () => {
    const invalidTimestamp = await execute({ script: 'touch -t bogus --help' });
    const helpFirstTimestamp = await execute({ script: 'touch --help -t bogus' });
    const invalidTimeKind = await execute({ script: 'touch --time=bogus --help' });
    const conflictingSources = await execute({ script: 'touch -t 202401010000 -d now --help' });

    expect(invalidTimestamp.result.exitCode).toBe(1);
    expect(invalidTimestamp.stderr.text).toContain("invalid date format 'bogus'");
    expect(helpFirstTimestamp.result.exitCode).toBe(0);
    expect(helpFirstTimestamp.stderr.text).toBe('');
    expect(invalidTimeKind.result.exitCode).toBe(1);
    expect(invalidTimeKind.stderr.text).toContain("invalid argument 'bogus' for '--time'");
    expect(conflictingSources.result.exitCode).toBe(0);
    expect(conflictingSources.stderr.text).toBe('');
  });

  it('stops argv processing when --help is reached before a later invalid option', async () => {
    const helpFirst = await execute({ script: 'touch --help --definitely-invalid-option' });
    const invalidFirst = await execute({ script: 'touch --definitely-invalid-option --help' });

    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stdout.text).not.toBe('');
    expect(helpFirst.stderr.text).toBe('');

    expect(invalidFirst.result.exitCode).not.toBe(0);
    expect(invalidFirst.stderr.text).not.toBe('');
  });

});
