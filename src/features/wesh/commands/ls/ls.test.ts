import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh ls', () => {
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

  it('sorts directory entries by name by default', async () => {
    await writeFile({ path: 'dir/zeta.txt', data: 'z' });
    await writeFile({ path: 'dir/alpha.txt', data: 'a' });
    await writeFile({ path: 'dir/mid.txt', data: 'm' });

    const { result, stdout, stderr } = await execute({
      script: 'ls dir',
    });

    expect(stdout.text).toBe(`\
alpha.txt
mid.txt
zeta.txt
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses C-locale ordering and lists file operands before directories', async () => {
    for (const name of ['A', 'Z', '_', 'a', 'z', 'é', '\uE000', '😀']) {
      await writeFile({ path: `ordering/${name}`, data: name });
    }
    const orderingDirectory = await rootHandle.getDirectoryHandle('ordering', {
      create: true,
    });
    await orderingDirectory.getDirectoryHandle('a-dir', { create: true });
    await writeFile({ path: 'ordering/z-file', data: 'z' });

    const names = await execute({ script: 'ls -1 ordering' });
    const operands = await execute({
      script: 'ls -1 ordering/a-dir ordering/z-file',
    });

    expect(names.result.exitCode).toBe(0);
    expect(names.stdout.text).toBe('A\nZ\n_\na\na-dir\nz\nz-file\né\n\uE000\n😀\n');
    expect(names.stderr.text).toBe('');
    expect(operands.result.exitCode).toBe(0);
    expect(operands.stdout.text).toBe(`\
ordering/z-file

ordering/a-dir:
`);
    expect(operands.stderr.text).toBe('');
  });

  it('supports -d to list a directory itself rather than its contents', async () => {
    await writeFile({ path: 'dir/file.txt', data: 'payload' });

    const { result, stdout, stderr } = await execute({
      script: 'ls -d dir',
    });

    expect(stdout.text).toBe('dir\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -F to classify directory and symlink entries', async () => {
    await writeFile({ path: 'dir/file.txt', data: 'payload' });
    await wesh.vfs.symlink({
      path: '/dir.link',
      targetPath: '/dir',
    });

    const { result, stdout, stderr } = await execute({
      script: 'ls -F .',
    });

    expect(stdout.text).toContain('dir/');
    expect(stdout.text).toContain('dir.link@');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports GNU --classify optional values without clearing earlier -F', async () => {
    await rootHandle.getDirectoryHandle('dir', { create: true });

    const always = await execute({ script: 'ls -d --classify=always dir' });
    const auto = await execute({ script: 'ls -d --classify=auto dir' });
    const never = await execute({ script: 'ls -d --classify=never dir' });
    const earlierClassify = await execute({ script: 'ls -d -F --classify=never dir' });
    const invalid = await execute({ script: 'ls -d --classify=bogus dir' });

    expect(always.stdout.text).toBe('dir/\n');
    expect(always.result.exitCode).toBe(0);
    expect(auto.stdout.text).toBe('dir\n');
    expect(auto.result.exitCode).toBe(0);
    expect(never.stdout.text).toBe('dir\n');
    expect(never.result.exitCode).toBe(0);
    expect(earlierClassify.stdout.text).toBe('dir/\n');
    expect(earlierClassify.result.exitCode).toBe(0);
    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("invalid argument 'bogus' for '--classify'");
    expect(invalid.result.exitCode).toBe(1);
  });

  it('follows command-line directory symlinks by default unless the format describes the link', async () => {
    await writeFile({ path: 'target/file.txt', data: 'payload' });
    await wesh.vfs.symlink({
      path: '/target.link',
      targetPath: '/target',
    });

    const defaultListing = await execute({
      script: 'ls -1 target.link',
    });
    const classified = await execute({
      script: 'ls -1F target.link',
    });
    const logicalClassified = await execute({
      script: 'ls -1FL target.link',
    });

    expect(defaultListing.stdout.text).toBe('file.txt\n');
    expect(classified.stdout.text).toBe('target.link@\n');
    expect(logicalClassified.stdout.text).toBe('file.txt\n');
    expect(defaultListing.stderr.text).toBe('');
    expect(classified.stderr.text).toBe('');
    expect(logicalClassified.stderr.text).toBe('');
    expect(defaultListing.result.exitCode).toBe(0);
    expect(classified.result.exitCode).toBe(0);
    expect(logicalClassified.result.exitCode).toBe(0);
  });

  it('lists a broken command-line symlink by default but errors for explicit traversal', async () => {
    await wesh.vfs.symlink({
      path: '/broken.link',
      targetPath: '/missing',
    });

    const defaultListing = await execute({ script: 'ls -1 broken.link' });
    const commandLineTraversal = await execute({ script: 'ls -1H broken.link' });

    expect(defaultListing.stdout.text).toBe('broken.link\n');
    expect(defaultListing.stderr.text).toBe('');
    expect(defaultListing.result.exitCode).toBe(0);
    expect(commandLineTraversal.stdout.text).toBe('');
    expect(commandLineTraversal.stderr.text).toContain('ls: broken.link:');
    expect(commandLineTraversal.result.exitCode).toBe(2);
  });

  it('shows symlink targets in long format', async () => {
    await writeFile({ path: 'target.txt', data: 'payload' });
    await wesh.vfs.symlink({
      path: '/target.link',
      targetPath: '/target.txt',
    });

    const { result, stdout, stderr } = await execute({
      script: 'ls -l target.link',
    });

    expect(stdout.text).toContain('target.link -> /target.txt');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -H for command-line symlink traversal', async () => {
    await writeFile({ path: 'dir/file.txt', data: 'payload' });
    await wesh.vfs.symlink({
      path: '/dir.link',
      targetPath: '/dir',
    });

    const physical = await execute({
      script: 'ls -1F dir.link',
    });
    const commandLine = await execute({
      script: 'ls -1FH dir.link',
    });

    expect(physical.stdout.text).toBe('dir.link@\n');
    expect(commandLine.stdout.text).toBe('file.txt\n');
    expect(physical.stderr.text).toBe('');
    expect(commandLine.stderr.text).toBe('');
    expect(physical.result.exitCode).toBe(0);
    expect(commandLine.result.exitCode).toBe(0);
  });

  it('keeps -P and -L distinct during recursive long listings', async () => {
    await writeFile({ path: 'target/nested/file.txt', data: 'payload' });
    await wesh.vfs.symlink({
      path: '/target.link',
      targetPath: '/target',
    });

    const physical = await execute({
      script: 'ls -lR target.link',
    });
    const logical = await execute({
      script: 'ls -lRL target.link',
    });

    expect(physical.stdout.text).toContain('target.link -> /target');
    expect(physical.stdout.text).not.toContain('file.txt');
    expect(logical.stdout.text).toContain('nested');
    expect(logical.stdout.text).toContain('target.link/nested:');
    expect(logical.stdout.text).toContain('file.txt');
    expect(physical.stderr.text).toBe('');
    expect(logical.stderr.text).toBe('');
    expect(physical.result.exitCode).toBe(0);
    expect(logical.result.exitCode).toBe(0);
  });

  it('supports -a to include dotfiles', async () => {
    await writeFile({ path: '.hidden.txt', data: 'hidden' });
    await writeFile({ path: 'visible.txt', data: 'visible' });

    const hidden = await execute({
      script: 'ls',
    });
    const all = await execute({
      script: 'ls -a',
    });

    expect(hidden.stdout.text).not.toContain('.hidden.txt');
    expect(all.stdout.text).toContain('.hidden.txt');
    expect(all.stdout.text).toContain('visible.txt');
    expect(hidden.stderr.text).toBe('');
    expect(all.stderr.text).toBe('');
    expect(hidden.result.exitCode).toBe(0);
    expect(all.result.exitCode).toBe(0);
  });

  it('accepts canonical GNU long names for common short options', async () => {
    await writeFile({ path: 'alias-dir/.hidden.txt', data: 'hidden' });
    await writeFile({ path: 'alias-dir/sub/file.txt', data: 'file' });
    await wesh.vfs.symlink({
      path: '/alias-link',
      targetPath: 'alias-dir',
    });

    const pairs = [
      ['ls -a alias-dir', 'ls --all alias-dir'],
      ['ls -R alias-dir', 'ls --recursive alias-dir'],
      ['ls -h alias-dir', 'ls --human-readable alias-dir'],
      ['ls -LF alias-link', 'ls --dereference -F alias-link'],
      ['ls -HF alias-link', 'ls --dereference-command-line -F alias-link'],
    ] as const;

    for (const [shortScript, longScript] of pairs) {
      const short = await execute({ script: shortScript });
      const long = await execute({ script: longScript });
      expect(long.stdout.text).toBe(short.stdout.text);
      expect(long.stderr.text).toBe(short.stderr.text);
      expect(long.result.exitCode).toBe(short.result.exitCode);
      expect(long.result.exitCode).toBe(0);
    }
  });

  it('matches GNU unique-prefix acceptance and real-option ambiguity', async () => {
    await writeFile({ path: 'tree/sub/file.txt', data: 'file' });

    const abbreviated = await execute({ script: 'ls --rec tree' });
    const canonical = await execute({ script: 'ls --recursive tree' });
    const recursiveAmbiguous = await execute({ script: 'ls --r tree' });
    const directoryAmbiguous = await execute({ script: 'ls --di tree' });
    const classifyAmbiguous = await execute({ script: 'ls --c tree' });
    const unsupportedOnlyAmbiguous = await execute({ script: 'ls --q tree' });
    const syntheticLong = await execute({ script: 'ls --1 tree' });

    expect(abbreviated.stdout.text).toBe(canonical.stdout.text);
    expect(abbreviated.stderr.text).toBe(canonical.stderr.text);
    expect(abbreviated.result.exitCode).toBe(canonical.result.exitCode);

    expect(recursiveAmbiguous.stderr.text).toContain("option '--r' is ambiguous");
    expect(recursiveAmbiguous.stderr.text).toContain("'--recursive'");
    expect(recursiveAmbiguous.stderr.text).toContain("'--reverse'");
    expect(recursiveAmbiguous.result.exitCode).toBe(2);

    expect(directoryAmbiguous.stderr.text).toContain("option '--di' is ambiguous");
    expect(directoryAmbiguous.stderr.text).toContain("'--directory'");
    expect(directoryAmbiguous.stderr.text).toContain("'--dired'");
    expect(directoryAmbiguous.result.exitCode).toBe(2);

    expect(classifyAmbiguous.stderr.text).toContain("option '--c' is ambiguous");
    expect(classifyAmbiguous.stderr.text).toContain("'--classify'");
    expect(classifyAmbiguous.stderr.text).toContain("'--color'");
    expect(classifyAmbiguous.stderr.text).toContain("'--context'");
    expect(classifyAmbiguous.result.exitCode).toBe(2);

    expect(unsupportedOnlyAmbiguous.stderr.text).toContain("option '--q' is ambiguous");
    expect(unsupportedOnlyAmbiguous.stderr.text).toContain("'--quote-name'");
    expect(unsupportedOnlyAmbiguous.stderr.text).toContain("'--quoting-style'");
    expect(unsupportedOnlyAmbiguous.result.exitCode).toBe(2);

    expect(syntheticLong.stderr.text).toContain("unrecognized option '--1'");
    expect(syntheticLong.result.exitCode).toBe(2);
  });

  it('lists root-relative paths correctly from /', async () => {
    await writeFile({ path: 'root.txt', data: 'root' });

    const { result, stdout, stderr } = await execute({
      script: 'cd /; ls',
    });

    expect(stdout.text).toContain('root.txt');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('continues listing after a broken symlink cannot be dereferenced', async () => {
    await writeFile({ path: 'dir/visible.txt', data: 'visible' });
    await wesh.vfs.symlink({
      path: '/dir/broken.link',
      targetPath: '/missing',
    });

    const { result, stdout, stderr } = await execute({
      script: 'ls -1FL dir',
    });

    expect(stdout.text).toBe(`\
broken.link@
visible.txt
`);
    expect(stderr.text).toContain("ls: cannot access 'dir/broken.link':");
    expect(result.exitCode).toBe(1);
  });

  it('supports -R to list subdirectories recursively', async () => {
    await writeFile({ path: 'tree/root.txt', data: 'root' });
    await writeFile({ path: 'tree/nested/deep.txt', data: 'deep' });

    const { result, stdout, stderr } = await execute({
      script: 'ls -R tree',
    });

    expect(stdout.text).toBe(`\
tree:
nested
root.txt

tree/nested:
deep.txt
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('stops recursive logical traversal at a symbolic-link ancestor cycle', async () => {
    await writeFile({ path: 'work/dir/file.txt', data: 'payload' });
    await wesh.vfs.symlink({
      path: '/work/dir/up',
      targetPath: '..',
    });

    const { result, stdout, stderr } = await execute({
      script: 'ls -1RL work/dir',
    });

    expect(stdout.text).toBe(`\
work/dir:
file.txt
up

work/dir/up:
dir
`);
    expect(stderr.text).toContain(
      'ls: work/dir/up/dir: not listing already-listed directory',
    );
    expect(result.exitCode).toBe(2);
  });

  it('rejects -P and other invalid options with exit code 2', async () => {
    const physical = await execute({ script: 'ls -P' });
    const unknown = await execute({ script: 'ls --definitely-invalid' });

    expect(physical.stdout.text).toBe('');
    expect(unknown.stdout.text).toBe('');
    expect(physical.stderr.text).toContain("ls: invalid option -- 'P'");
    expect(unknown.stderr.text).toContain("ls: unrecognized option '--definitely-invalid'");
    expect(physical.result.exitCode).toBe(2);
    expect(unknown.result.exitCode).toBe(2);
  });

  it('continues after missing operands but returns a non-zero exit code', async () => {
    await writeFile({ path: 'dir/file.txt', data: 'payload' });

    const { result, stdout, stderr } = await execute({
      script: 'ls dir missing',
    });

    expect(stdout.text).toContain(`\
dir:
file.txt`);
    expect(stderr.text).toContain('ls: missing:');
    expect(result.exitCode).toBe(2);
  });
});
