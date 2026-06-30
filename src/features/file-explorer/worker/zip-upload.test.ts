import JSZip from 'jszip';
import { Blob as NodeBlob } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  buildZipUploadPreview,
  executeParsedZipUpload,
  inspectZipUploadTarget,
  parseZipUpload,
} from './zip-upload';

async function createProjectZip(): Promise<Blob> {
  const zip = new JSZip();
  zip.file('workspace/src/main.ts', 'export const value = 1;');
  zip.file('workspace/package.json', '{"name":"demo"}');
  zip.file('workspace/README.md', 'new readme');
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return new NodeBlob([Uint8Array.from(bytes).buffer]) as unknown as Blob;
}

async function writeText({
  directory,
  name,
  text,
}: {
  directory: MockFileSystemDirectoryHandle,
  name: string,
  text: string,
}): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}


async function executeWithCurrentPreview({
  analysis,
  placement,
  targetDirectory,
  jobId,
  signal,
}: Omit<Parameters<typeof executeParsedZipUpload>[0], 'expectedFingerprint'>) {
  const inspection = await inspectZipUploadTarget({
    analysis,
    placement,
    targetDirectory,
  });
  return executeParsedZipUpload({
    analysis,
    placement,
    targetDirectory,
    jobId,
    expectedFingerprint: inspection.fingerprint,
    signal,
  });
}

describe('ZIP upload worker logic', () => {
  it('detects an implicit single root directory without reading the full Blob', async () => {
    const blob = await createProjectZip();
    Object.defineProperty(blob, 'arrayBuffer', {
      value: async () => {
        throw new Error('The complete ZIP Blob must not be materialized');
      },
    });

    const analysis = await parseZipUpload({
      blob,
      fileName: 'backup.zip',
    });

    expect(analysis.singleRootDirectoryName).toBe('workspace');
    expect(analysis.entries.map(entry => entry.path)).toEqual(expect.arrayContaining([
      'workspace/src/main.ts',
      'workspace/package.json',
      'workspace/README.md',
    ]));
  });


  it('rejects case-conflicting directory prefixes', async () => {
    const zip = new JSZip();
    zip.file('Foo/a.txt', 'a');
    zip.file('foo/b.txt', 'b');
    const blob = new Blob([
      Uint8Array.from(await zip.generateAsync({ type: 'uint8array' })).buffer,
    ]);

    await expect(parseZipUpload({
      blob,
      fileName: 'conflict.zip',
    })).rejects.toThrow('case-conflicting paths');
  });

  it('previews strip placement against existing target entries', async () => {
    const analysis = await parseZipUpload({
      blob: await createProjectZip(),
      fileName: 'backup.zip',
    });

    const preview = await buildZipUploadPreview({
      analysis,
      placement: { kind: 'extract', rootHandling: 'strip' },
      relativePath: '',
      existingEntries: [
        { name: 'src', path: 'src', kind: 'directory', size: undefined, lastModified: undefined },
        { name: 'README.md', path: 'README.md', kind: 'file', size: 3, lastModified: 1 },
      ],
      blockedPaths: new Set(),
    });

    expect(preview.entries.map(entry => [entry.name, entry.action])).toEqual([
      ['src', 'merge'],
      ['package.json', 'add'],
      ['README.md', 'replace'],
    ]);
    expect(preview.summary).toEqual({
      addedCount: 1,
      mergedCount: 1,
      replacedCount: 1,
      blockedCount: 0,
    });
  });

  it('marks an ancestor preview row blocked when a descendant has a type conflict', async () => {
    const zip = new JSZip();
    zip.file('workspace/src/nested/main.ts', 'export {};');
    const analysis = await parseZipUpload({
      blob: new Blob([
        Uint8Array.from(await zip.generateAsync({ type: 'uint8array' })).buffer,
      ]),
      fileName: 'backup.zip',
    });
    const target = new MockFileSystemDirectoryHandle({ name: 'uploads' });
    const src = await target.getDirectoryHandle('src', { create: true });
    await writeText({ directory: src, name: 'nested', text: 'not a directory' });

    const inspection = await inspectZipUploadTarget({
      analysis,
      placement: { kind: 'extract', rootHandling: 'strip' },
      targetDirectory: target as unknown as FileSystemDirectoryHandle,
    });
    const preview = await buildZipUploadPreview({
      analysis,
      placement: { kind: 'extract', rootHandling: 'strip' },
      relativePath: '',
      existingEntries: [
        { name: 'src', path: 'src', kind: 'directory', size: undefined, lastModified: undefined },
      ],
      blockedPaths: inspection.blockedPaths,
    });

    expect([...inspection.blockedPaths]).toEqual(['src/nested']);
    expect(preview.entries.map(entry => [entry.name, entry.action])).toEqual([
      ['src', 'blocked'],
    ]);
    expect(preview.summary.blockedCount).toBe(1);
  });

  it('changes the target fingerprint when a planned file appears after preview', async () => {
    const analysis = await parseZipUpload({
      blob: await createProjectZip(),
      fileName: 'backup.zip',
    });
    const target = new MockFileSystemDirectoryHandle({ name: 'uploads' });
    const before = await inspectZipUploadTarget({
      analysis,
      placement: { kind: 'extract', rootHandling: 'strip' },
      targetDirectory: target as unknown as FileSystemDirectoryHandle,
    });

    await writeText({ directory: target, name: 'package.json', text: 'external change' });

    const after = await inspectZipUploadTarget({
      analysis,
      placement: { kind: 'extract', rootHandling: 'strip' },
      targetDirectory: target as unknown as FileSystemDirectoryHandle,
    });

    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.blockedPaths.size).toBe(0);
  });

  it('extracts through streams, strips the single root, and removes staging data', async () => {
    const analysis = await parseZipUpload({
      blob: await createProjectZip(),
      fileName: 'backup.zip',
    });
    const target = new MockFileSystemDirectoryHandle({ name: 'uploads' });
    const src = await target.getDirectoryHandle('src', { create: true });
    await writeText({ directory: src, name: 'existing.ts', text: 'existing' });
    await writeText({ directory: target, name: 'README.md', text: 'old readme' });

    const result = await executeWithCurrentPreview({
      analysis,
      placement: { kind: 'extract', rootHandling: 'strip' },
      targetDirectory: target as unknown as FileSystemDirectoryHandle,
      jobId: 'test-job',
      signal: new AbortController().signal,
    });

    expect(result).toBe('completed');
    expect(await (await target.getFileHandle('README.md')).getFile().then(file => file.text())).toBe('new readme');
    expect(await (await target.getFileHandle('package.json')).getFile().then(file => file.text())).toBe('{"name":"demo"}');
    const targetSrc = await target.getDirectoryHandle('src');
    expect(await (await targetSrc.getFileHandle('existing.ts')).getFile().then(file => file.text())).toBe('existing');
    expect(await (await targetSrc.getFileHandle('main.ts')).getFile().then(file => file.text())).toBe('export const value = 1;');
    await expect(target.getDirectoryHandle('.__naidan_zip_upload_test-job')).rejects.toThrow('NotFoundError');
  });

  it('does not remove an existing entry that matches the preferred staging name', async () => {
    const analysis = await parseZipUpload({
      blob: await createProjectZip(),
      fileName: 'backup.zip',
    });
    const target = new MockFileSystemDirectoryHandle({ name: 'uploads' });
    const existingTemporaryDirectory = await target.getDirectoryHandle(
      '.__naidan_zip_upload_test-job',
      { create: true },
    );
    await writeText({
      directory: existingTemporaryDirectory,
      name: 'marker.txt',
      text: 'keep me',
    });

    const result = await executeWithCurrentPreview({
      analysis,
      placement: { kind: 'extract', rootHandling: 'strip' },
      targetDirectory: target as unknown as FileSystemDirectoryHandle,
      jobId: 'test-job',
      signal: new AbortController().signal,
    });

    expect(result).toBe('completed');
    expect(await (
      await existingTemporaryDirectory.getFileHandle('marker.txt')
    ).getFile().then(file => file.text())).toBe('keep me');
    await expect(target.getDirectoryHandle('.__naidan_zip_upload_test-job_1')).rejects.toThrow('NotFoundError');
  });

  it('does not overwrite target changes made while the ZIP is being staged', async () => {
    const originalBlob = await createProjectZip();
    const analysis = await parseZipUpload({
      blob: originalBlob,
      fileName: 'backup.zip',
    });
    const target = new MockFileSystemDirectoryHandle({ name: 'uploads' });
    await writeText({ directory: target, name: 'backup.zip', text: 'previewed version' });
    const previewInspection = await inspectZipUploadTarget({
      analysis,
      placement: { kind: 'keep_archive' },
      targetDirectory: target as unknown as FileSystemDirectoryHandle,
    });
    const bytes = new Uint8Array(await originalBlob.arrayBuffer());
    const changingBlob = {
      size: originalBlob.size,
      stream: () => new ReadableStream<Uint8Array>({
        async start(controller) {
          await writeText({
            directory: target,
            name: 'backup.zip',
            text: 'external change during staging',
          });
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    } as Blob;

    const result = await executeParsedZipUpload({
      analysis: { ...analysis, blob: changingBlob },
      placement: { kind: 'keep_archive' },
      targetDirectory: target as unknown as FileSystemDirectoryHandle,
      jobId: 'stale-preview-job',
      expectedFingerprint: previewInspection.fingerprint,
      signal: new AbortController().signal,
    });

    expect(result).toBe('preview-outdated');
    expect(await (
      await target.getFileHandle('backup.zip')
    ).getFile().then(file => file.text())).toBe('external change during staging');
    await expect(target.getDirectoryHandle(
      '.__naidan_zip_upload_stale-preview-job',
    )).rejects.toThrow('NotFoundError');
  });

  it('restores an existing archive when keep-as-is placement fails during commit', async () => {
    const blob = await createProjectZip();
    const analysis = await parseZipUpload({
      blob,
      fileName: 'backup.zip',
    });
    const target = new MockFileSystemDirectoryHandle({ name: 'uploads' });
    await writeText({ directory: target, name: 'backup.zip', text: 'original archive' });
    const targetFile = await target.getFileHandle('backup.zip');
    const originalCreateWritable = targetFile.createWritable.bind(targetFile);
    let writableCreationCount = 0;
    targetFile.createWritable = async options => {
      writableCreationCount += 1;
      const writable = await originalCreateWritable(options);
      if (writableCreationCount === 1) {
        writable.write = async () => {
          throw new Error('disk full');
        };
      }
      return writable;
    };

    await expect(executeWithCurrentPreview({
      analysis,
      placement: { kind: 'keep_archive' },
      targetDirectory: target as unknown as FileSystemDirectoryHandle,
      jobId: 'keep-archive-job',
      signal: new AbortController().signal,
    })).rejects.toThrow('disk full');

    expect(await targetFile.getFile().then(file => file.text())).toBe('original archive');
    await expect(target.getDirectoryHandle(
      '.__naidan_zip_upload_keep-archive-job',
    )).rejects.toThrow('NotFoundError');
  });

  it('preserves the single root directory when requested', async () => {
    const analysis = await parseZipUpload({
      blob: await createProjectZip(),
      fileName: 'backup.zip',
    });
    const target = new MockFileSystemDirectoryHandle({ name: 'uploads' });

    await executeWithCurrentPreview({
      analysis,
      placement: { kind: 'extract', rootHandling: 'preserve' },
      targetDirectory: target as unknown as FileSystemDirectoryHandle,
      jobId: 'preserve-job',
      signal: new AbortController().signal,
    });

    const workspace = await target.getDirectoryHandle('workspace');
    expect(await (await workspace.getFileHandle('package.json')).getFile().then(file => file.text())).toBe('{"name":"demo"}');
  });

  it('reports a target file-directory type conflict as preview outdated', async () => {
    const analysis = await parseZipUpload({
      blob: await createProjectZip(),
      fileName: 'backup.zip',
    });
    const target = new MockFileSystemDirectoryHandle({ name: 'uploads' });
    await writeText({ directory: target, name: 'src', text: 'not a directory' });

    const result = await executeWithCurrentPreview({
      analysis,
      placement: { kind: 'extract', rootHandling: 'strip' },
      targetDirectory: target as unknown as FileSystemDirectoryHandle,
      jobId: 'conflict-job',
      signal: new AbortController().signal,
    });

    expect(result).toBe('preview-outdated');
  });
});
