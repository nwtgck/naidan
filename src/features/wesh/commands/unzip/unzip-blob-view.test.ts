// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlobViewShellFixture } from '@/features/wesh/utils/blob-view.test-helpers';
import { unzipCommandDefinition } from '@/features/wesh/commands/unzip/definition';

beforeAll(async () => {
  await unzipCommandDefinition.load();
});
let fixture: Awaited<ReturnType<typeof createBlobViewShellFixture>>;
beforeEach(async () => {
  fixture = await createBlobViewShellFixture();
});
afterEach(() => {
  fixture?.dispose(); vi.restoreAllMocks();
});
import JSZip from 'jszip';

describe('unzip with safe efficient BlobView random access', () => {
  async function writeArchive() {
    const archive = new JSZip();
    const bytes = new Uint8Array(300_019).map((_, i) => i % 256);
    archive.file('dir/data.bin', bytes); archive.file('note.txt', '日本語');
    await fixture.writeFile({ path: '/input.zip', data: await archive.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }) });
    return bytes;
  }

  it('extracts real archive bytes without reopening the archive through a file handle', async () => {
    const bytes = await writeArchive();
    fixture.blockNativeReads();
    const open = vi.spyOn(fixture.wesh.vfs, 'open');
    const result = await fixture.execute({ script: 'unzip -oq /input.zip -d /out', stdinText: undefined });
    expect(result.result.exitCode).toBe(0); expect(result.stderr.text).toBe('');
    const out = await fixture.root.getDirectoryHandle('out');
    const dir = await out.getDirectoryHandle('dir');
    expect((await dir.getFileHandle('data.bin')).content).toEqual(bytes);
    expect(new TextDecoder().decode((await out.getFileHandle('note.txt')).content)).toBe('日本語');
    expect(open.mock.calls.filter(([request]) => request.path === '/input.zip')).toEqual([]);
  });

  it('lists, verifies, and pipes entries without closing the shared context', async () => {
    await writeArchive(); fixture.blockNativeReads();
    const listing = await fixture.execute({ script: 'unzip -l /input.zip', stdinText: undefined });
    expect(listing.result.exitCode).toBe(0); expect(listing.stdout.text).toContain('dir/data.bin');
    expect((await fixture.execute({ script: 'unzip -tq /input.zip', stdinText: undefined })).result.exitCode).toBe(0);
    const piped = await fixture.execute({ script: 'unzip -p /input.zip note.txt', stdinText: undefined });
    expect(piped.result.exitCode).toBe(0); expect(piped.stdout.text).toBe('日本語');
    expect(await fixture.blobs.fromNative({ blob: new Blob(['still open']) }).text()).toBe('still open');
  });

  it('does not create extracted files on archive byte failure', async () => {
    await writeArchive(); fixture.blockNativeReads(); fixture.read.mockRejectedValue(new Error('Unavailable host'));
    const result = await fixture.execute({ script: 'unzip -oq /input.zip -d /out', stdinText: undefined });
    expect(result.result.exitCode).not.toBe(0); expect(result.stderr.text).not.toBe('');
    await expect(fixture.root.getDirectoryHandle('out')).rejects.toThrow();
  });
});
