import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh ln', () => {
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
    data: string | Uint8Array,
  }): Promise<void> {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) {
      throw new Error('path must contain a file name');
    }

    let directory = rootHandle;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }

    const file = await directory.getFileHandle(fileName, { create: true });
    const writable = await file.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function readFile({
    path,
  }: {
    path: string,
  }): Promise<string> {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) {
      throw new Error('path must contain a file name');
    }

    let directory = rootHandle;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment);
    }

    const file = await directory.getFileHandle(fileName);
    return await (await file.getFile()).text();
  }

  async function execute({
    script,
    stdin = '',
  }: {
    script: string,
    stdin?: string,
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

  it('prints help and reports missing operands with usage', async () => {
    const help = await execute({ script: 'ln --help' });
    const missing = await execute({ script: 'ln -s' });

    expect(help.stdout.text).toContain('Make links between files');
    expect(help.stdout.text).toContain('usage:');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('ln: missing file operand');
    expect(missing.stderr.text).toContain('usage:');
    expect(missing.result.exitCode).toBe(1);
  });

  it('uses the target basename when LINK_NAME is omitted', async () => {
    const linked = await execute({
      script: `\
ln -s /target.txt
readlink target.txt`,
    });

    expect(linked.stdout.text).toBe('/target.txt\n');
    expect(linked.stderr.text).toBe('');
    expect(linked.result.exitCode).toBe(0);
  });

  it('treats -T as no-target-directory for symbolic links', async () => {
    await wesh.vfs.mkdir({ path: '/dest', recursive: true });
    await wesh.vfs.symlink({
      path: '/dir.link',
      targetPath: '/dest',
    });

    const linked = await execute({
      script: `\
ln -sfT /target.txt dir.link
readlink dir.link`,
    });

    expect(linked.stdout.text).toBe('/target.txt\n');
    expect(linked.stderr.text).toBe('');
    expect(linked.result.exitCode).toBe(0);
  });

  it('creates multiple symbolic links in a destination directory', async () => {
    await wesh.vfs.mkdir({ path: '/dest', recursive: true });

    const linked = await execute({
      script: `\
ln -s one two dest
readlink dest/one
readlink dest/two`,
    });

    expect(linked.stdout.text).toBe(`\
one
two
`);
    expect(linked.stderr.text).toBe('');
    expect(linked.result.exitCode).toBe(0);
  });
  it('refuses to replace a directory even with force and no-target-directory', async () => {
    const execution = await execute({
      script: `\
mkdir destination
ln -sfT target destination
printf 'status=%s directory=%s\n' "$?" "$(test -d destination; echo $?)"
`,
    });

    expect(execution.stdout.text).toBe('status=1 directory=0\n');
    expect(execution.stderr.text).not.toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('does not replace an existing source with a self-referential link under -f', async () => {
    await writeFile({ path: 'source', data: 'payload' });
    await wesh.vfs.symlink({ path: '/alias', targetPath: 'source' });

    const direct = await execute({ script: 'ln -sf source source' });
    const aliased = await execute({ script: 'ln -sf alias source' });

    expect(direct.result.exitCode).toBe(1);
    expect(direct.stderr.text).toContain('are the same file');
    expect(aliased.result.exitCode).toBe(1);
    expect(aliased.stderr.text).toContain('are the same file');
    expect(await readFile({ path: 'source' })).toBe('payload');
  });

  it('rejects repeated target-directory selections before linking', async () => {
    const execution = await execute({
      script: 'mkdir first second; ln -s -t first --target-directory=second target',
    });

    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toContain('ln: multiple target directories specified');
    expect(execution.result.exitCode).toBe(1);
  });

  it('rejects a repeated valid target directory before a later --help', async () => {
    await execute({ script: 'mkdir a b' });

    const repeated = await execute({ script: 'ln -s -t a -t b --help' });
    const helpFirst = await execute({ script: 'ln --help -s -t a -t b' });

    expect(repeated.result.exitCode).toBe(1);
    expect(repeated.stdout.text).toBe('');
    expect(repeated.stderr.text).toContain('multiple target directories specified');
    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stderr.text).toBe('');
  });

  it('validates the first explicit target directory before a repeated -t', async () => {
    await execute({ script: 'mkdir valid' });
    await writeFile({ path: 'not-dir', data: 'file' });

    const missingFirst = await execute({ script: 'ln -s -t missing -t valid target' });
    expect(missingFirst.result.exitCode).toBe(1);
    expect(missingFirst.stderr.text).toContain("ln: failed to access 'missing': No such file or directory");

    const fileFirst = await execute({ script: 'ln -s -t not-dir -t valid target' });
    expect(fileFirst.result.exitCode).toBe(1);
    expect(fileFirst.stderr.text).toContain("ln: target 'not-dir' is not a directory");

    const validFirst = await execute({ script: 'ln -s -t valid -t missing target' });
    expect(validFirst.result.exitCode).toBe(1);
    expect(validFirst.stderr.text).toContain('ln: multiple target directories specified');
  });

  it('rejects an explicit empty target directory before link operands', async () => {
    for (const script of ["ln -s -t ''", "ln -s -t '' missing", "ln -s -t '' --help", "ln -s -T -t '' missing"]) {
      const result = await execute({ script });
      expect(result.stdout.text).toBe('');
      expect(result.stderr.text).toContain("ln: failed to access '': No such file or directory");
      expect(result.result.exitCode).toBe(1);
    }
  });

  it('supports relative links and an explicit target directory', async () => {
    const execution = await execute({
      script: `\
mkdir -p source destination/nested
printf x > source/file
ln -sr source/file destination/nested/link
ln -s -t destination first second
printf '%s:%s:%s\n' "$(readlink destination/nested/link)" "$(readlink destination/first)" "$(readlink destination/second)"
`,
    });

    expect(execution.stdout.text).toBe('../../source/file:first:second\n');
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('continues creating later links after one destination already exists', async () => {
    const execution = await execute({
      script: `\
mkdir destination
ln -s old destination/first
ln -s first second destination
printf 'status=%s second=%s\n' "$?" "$(readlink destination/second)"
`,
    });

    expect(execution.stdout.text).toBe('status=1 second=second\n');
    expect(execution.stderr.text).not.toBe('');
    expect(execution.result.exitCode).toBe(0);
  });


  it('supports verbose symbolic links, backups, and custom backup suffixes', async () => {
    await writeFile({ path: 'target', data: 'new' });
    await writeFile({ path: 'link', data: 'old' });

    const backedUp = await execute({
      script: "ln -svb -S.bak target link",
    });

    expect(backedUp.stdout.text).toBe("'link' -> 'target'\n");
    expect(backedUp.stderr.text).toBe('');
    expect(backedUp.result.exitCode).toBe(0);
    expect(await wesh.vfs.readlink({ path: '/link' })).toBe('target');
    expect(await readFile({ path: 'link.bak' })).toBe('old');
  });

  it('supports GNU backup controls when replacing symbolic-link destinations', async () => {
    await writeFile({ path: 'target', data: 'new' });
    await writeFile({ path: 'numbered', data: 'old' });
    await writeFile({ path: 'numbered.~3~', data: 'older' });

    const numbered = await execute({
      script: 'ln -s --backup=numbered target numbered',
    });

    expect(numbered.stdout.text).toBe('');
    expect(numbered.stderr.text).toBe('');
    expect(numbered.result.exitCode).toBe(0);
    expect(await wesh.vfs.readlink({ path: '/numbered' })).toBe('target');
    expect(await readFile({ path: 'numbered.~4~' })).toBe('old');

    await writeFile({ path: 'disabled', data: 'keep' });
    const disabled = await execute({
      script: 'ln -s --backup=none target disabled',
    });

    expect(disabled.result.exitCode).toBe(1);
    expect(await readFile({ path: 'disabled' })).toBe('keep');

    await writeFile({ path: 'invalid', data: 'keep' });
    const invalid = await execute({
      script: 'ln -s --backup=bogus target invalid',
    });

    expect(invalid.result.exitCode).toBe(1);
    expect(invalid.stderr.text).toContain("invalid argument 'bogus' for '--backup'");
    expect(await readFile({ path: 'invalid' })).toBe('keep');
  });

  it('supports interactive replacement with GNU option precedence', async () => {
    await writeFile({ path: 'target', data: 'new' });
    await writeFile({ path: 'declined', data: 'old' });
    const declined = await execute({
      script: 'ln -si target declined',
      stdin: 'n\n',
    });

    expect(declined.stderr.text).toContain("replace 'declined'?");
    expect(declined.result.exitCode).toBe(1);
    expect(await readFile({ path: 'declined' })).toBe('old');

    await writeFile({ path: 'accepted', data: 'old' });
    const accepted = await execute({
      script: 'ln -si target accepted',
      stdin: 'y\n',
    });
    expect(accepted.result.exitCode).toBe(0);
    expect(await wesh.vfs.readlink({ path: '/accepted' })).toBe('target');

    await writeFile({ path: 'force-wins', data: 'old' });
    const forceWins = await execute({
      script: 'ln -si -f target force-wins',
      stdin: 'n\n',
    });
    expect(forceWins.stderr.text).toBe('');
    expect(forceWins.result.exitCode).toBe(0);
    expect(await wesh.vfs.readlink({ path: '/force-wins' })).toBe('target');
  });


  it('rejects empty symbolic-link targets and continues later directory operands', async () => {
    const direct = await execute({ script: "ln -s '' direct-link" });

    expect(direct.stdout.text).toBe('');
    expect(direct.stderr.text).toContain("-> '': No such file or directory");
    expect(direct.result.exitCode).toBe(1);
    await expect(wesh.vfs.lstat({ path: '/direct-link' })).rejects.toThrow();

    await wesh.vfs.mkdir({ path: '/destination', recursive: true });
    const multiple = await execute({
      script: "ln -s -t destination '' valid",
    });

    expect(multiple.stdout.text).toBe('');
    expect(multiple.stderr.text).toContain("-> '': No such file or directory");
    expect(multiple.result.exitCode).toBe(1);
    await expect(wesh.vfs.lstat({ path: '/destination/' })).resolves.toMatchObject({
      type: 'directory',
    });
    expect(await wesh.vfs.readlink({ path: '/destination/valid' })).toBe('valid');
  });

  it('keeps hard links explicitly unsupported without copying file contents', async () => {
    await writeFile({ path: 'target', data: 'payload' });

    const hardLink = await execute({ script: 'ln target link' });

    expect(hardLink.stdout.text).toBe('');
    expect(hardLink.stderr.text).toContain('hard links are not supported');
    expect(hardLink.result.exitCode).toBe(1);
    await expect(wesh.vfs.lstat({ path: '/link' })).rejects.toThrow();
    expect(await readFile({ path: 'target' })).toBe('payload');
  });

});
