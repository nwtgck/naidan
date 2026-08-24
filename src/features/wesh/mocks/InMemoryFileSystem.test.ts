import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from './InMemoryFileSystem';

describe('InMemoryFileSystem OPFS contract', () => {
  it('matches Chrome DOMException shape for missing entries', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });

    const fileError = await root.getFileHandle('missing.txt').catch((error: unknown) => error);
    const directoryError = await root.getDirectoryHandle('missing').catch((error: unknown) => error);

    expect(fileError).toBeInstanceOf(DOMException);
    expect(fileError).toMatchObject({
      name: 'NotFoundError',
      message: 'A requested file or directory could not be found at the time an operation was processed.',
      code: 8,
    });
    expect(directoryError).toBeInstanceOf(DOMException);
    expect(directoryError).toMatchObject({
      name: 'NotFoundError',
      message: 'A requested file or directory could not be found at the time an operation was processed.',
      code: 8,
    });
  });

  it('matches Chrome TypeMismatchError for an existing entry of the wrong kind', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    await root.getFileHandle('file', { create: true });
    await root.getDirectoryHandle('directory', { create: true });

    const fileAsDirectory = await root.getDirectoryHandle('file').catch((error: unknown) => error);
    const directoryAsFile = await root.getFileHandle('directory').catch((error: unknown) => error);

    expect(fileAsDirectory).toBeInstanceOf(DOMException);
    expect(fileAsDirectory).toMatchObject({
      name: 'TypeMismatchError',
      message: 'The path supplied exists, but was not an entry of requested type.',
      code: 17,
    });
    expect(directoryAsFile).toBeInstanceOf(DOMException);
    expect(directoryAsFile).toMatchObject({
      name: 'TypeMismatchError',
      message: 'The path supplied exists, but was not an entry of requested type.',
      code: 17,
    });
  });

  it('keeps writable changes invisible through getFile until close', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const handle = await root.getFileHandle('visibility.txt', { create: true });
    let writable = await handle.createWritable();
    await writable.write('initial');
    await writable.close();

    writable = await handle.createWritable({ keepExistingData: true });
    await writable.seek(0);
    await writable.write('changed');

    expect(await (await handle.getFile()).text()).toBe('initial');
    await writable.close();
    expect(await (await handle.getFile()).text()).toBe('changed');
  });

  it('matches the observed Chrome MIME type for OPFS text files', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const handle = await root.getFileHandle('observed.txt', { create: true });

    expect((await handle.getFile()).type).toBe('text/plain');
  });

  it('matches observed object-form write, seek, and truncate behavior', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const handle = await root.getFileHandle('commands.txt', { create: true });
    const writable = await handle.createWritable();

    await writable.write({ type: 'write', position: 1, data: 'AB' });
    await writable.write({ type: 'seek', position: 0 });
    await writable.write({ type: 'truncate', size: 4 });
    await writable.close();

    expect(Array.from(await (await handle.getFile()).bytes())).toEqual([0, 65, 66, 0]);
  });

  it('matches observed seek, overwrite, and truncate behavior', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const handle = await root.getFileHandle('seek-truncate.txt', { create: true });
    const writable = await handle.createWritable();

    await writable.write('abcdef');
    await writable.seek(2);
    await writable.write('XY');
    await writable.truncate(5);
    await writable.close();

    expect(await (await handle.getFile()).text()).toBe('abXYe');
  });

  it('returns File snapshots that are not mutated by later writes', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const handle = await root.getFileHandle('snapshot.txt', { create: true });
    let writable = await handle.createWritable();
    await writable.write('before');
    await writable.close();
    const snapshot = await handle.getFile();

    writable = await handle.createWritable();
    await writable.write('after');
    await writable.close();

    expect(await snapshot.text()).toBe('before');
    expect(await (await handle.getFile()).text()).toBe('after');
  });

  it('matches Chrome entry-name validation, including backslash rejection', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });

    for (const name of ['', '.', '..', 'a/b', '/', 'a\\b']) {
      const error = await root.getDirectoryHandle(name, { create: true }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TypeError);
    }
  });

  it('matches Chrome behavior for removed file handles', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const handle = await root.getFileHandle('removed.txt', { create: true });

    await root.removeEntry('removed.txt');

    const getFileError = await handle.getFile().catch((error: unknown) => error);
    expect(getFileError).toBeInstanceOf(DOMException);
    expect(getFileError).toMatchObject({ name: 'NotFoundError' });

    // Chrome allows this call after unlinking the entry. Firefox and Safari
    // were observed to reject it, so this assertion intentionally pins the
    // emulator to Chrome rather than a portable OPFS contract.
    const writable = await handle.createWritable();
    await writable.close();
    const getFileAfterCloseError = await handle.getFile().catch((error: unknown) => error);
    expect(getFileAfterCloseError).toMatchObject({ name: 'NotFoundError' });
  });

  it('matches Chrome behavior for removed directory handles', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const directory = await root.getDirectoryHandle('removed', { create: true });

    await root.removeEntry('removed');

    const getFileError = await directory.getFileHandle('child').catch((error: unknown) => error);
    expect(getFileError).toBeInstanceOf(DOMException);
    expect(getFileError).toMatchObject({ name: 'NotFoundError' });

    const iterate = async (): Promise<string[]> => {
      const names: string[] = [];
      for await (const [name] of directory.entries()) names.push(name);
      return names;
    };
    const iterationError = await iterate().catch((error: unknown) => error);
    expect(iterationError).toBeInstanceOf(DOMException);
    expect(iterationError).toMatchObject({ name: 'NotFoundError' });
  });

  it('matches Chrome resolution behavior for descendants and unrelated handles', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const sandbox = await root.getDirectoryHandle('sandbox', { create: true });
    const nested = await sandbox.getDirectoryHandle('nested', { create: true });
    const child = await nested.getFileHandle('日本語-🙂.txt', { create: true });
    const unrelated = await root.getDirectoryHandle('unrelated', { create: true });

    expect(await sandbox.resolve(child)).toEqual(['nested', '日本語-🙂.txt']);
    expect(await sandbox.resolve(unrelated)).toBeNull();
  });

  it('treats separately acquired handles to the same entry as the same entry', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const first = await root.getFileHandle('same.txt', { create: true });
    const second = await root.getFileHandle('same.txt');

    expect(await first.isSameEntry(second)).toBe(true);
  });

  it('removes non-empty directories recursively and reports the entry as missing afterwards', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const directory = await root.getDirectoryHandle('recursive', { create: true });
    await directory.getFileHandle('child.txt', { create: true });

    await root.removeEntry('recursive', { recursive: true });
    const error = await root.getDirectoryHandle('recursive').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({ name: 'NotFoundError', code: 8 });
  });

  it('returns NotFoundError when removing an entry that does not exist', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });

    const error = await root.removeEntry('missing').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({ name: 'NotFoundError', code: 8 });
  });

  it('matches Chrome InvalidModificationError for non-recursive removal of a non-empty directory', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const directory = await root.getDirectoryHandle('nonempty', { create: true });
    await directory.getFileHandle('child', { create: true });

    const error = await root.removeEntry('nonempty').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({
      name: 'InvalidModificationError',
      message: 'The object can not be modified in this way.',
      code: 13,
    });
  });
});
