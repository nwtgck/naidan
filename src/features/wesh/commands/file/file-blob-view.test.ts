// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlobViewShellFixture } from '@/features/wesh/utils/blob-view.test-helpers';
import { fileCommandDefinition } from '@/features/wesh/commands/file/definition';

beforeAll(async () => {
  await fileCommandDefinition.load();
});
let fixture: Awaited<ReturnType<typeof createBlobViewShellFixture>>;
beforeEach(async () => {
  fixture = await createBlobViewShellFixture();
});
afterEach(() => {
  fixture?.dispose(); vi.restoreAllMocks();
});

describe('file with safe efficient BlobView samples', () => {
  it('samples only the fixed prefix, not the complete large file', async () => {
    await fixture.writeFile({ path: '/large.txt', data: 'a'.repeat(1024 * 1024) });
    fixture.blockNativeReads();
    const open = vi.spyOn(fixture.wesh.vfs, 'open');
    const result = await fixture.execute({ script: 'file -b /large.txt', stdinText: undefined });
    expect(result.result.exitCode).toBe(0); expect(result.stderr.text).toBe(''); expect(result.stdout.text).toContain('ASCII text');
    expect(fixture.read.mock.calls.slice(1).reduce((sum, [request]) => sum + request.length, 0)).toBe(64 * 1024);
    expect(open.mock.calls.filter(([request]) => request.path === '/large.txt')).toEqual([]);
  });

  it('classifies UTF-8 and arbitrary binary samples without native Blob reads', async () => {
    await fixture.writeFile({ path: '/text', data: '日本語😀' });
    await fixture.writeFile({ path: '/data', data: new Uint8Array([0, 255, 128, 1]) });
    fixture.blockNativeReads();
    const text = await fixture.execute({ script: 'file -bi /text', stdinText: undefined });
    const data = await fixture.execute({ script: 'file -bi /data', stdinText: undefined });
    expect(text.result.exitCode).toBe(0); expect(text.stdout.text).toContain('charset=utf-8');
    expect(data.result.exitCode).toBe(0); expect(data.stdout.text).toContain('application/octet-stream');
  });

  it('keeps symlink and follow-symlink behavior while using the context for registry reads', async () => {
    await fixture.writeFile({ path: '/text', data: 'plain' });
    await fixture.wesh.vfs.symlink({ targetPath: '/text', path: '/link' });
    fixture.blockNativeReads();
    const link = await fixture.execute({ script: 'file -b /link', stdinText: undefined });
    const followed = await fixture.execute({ script: 'file -bL /link', stdinText: undefined });
    expect(link.stdout.text).toContain('symbolic link'); expect(followed.stdout.text).toContain('ASCII text');
  });

  it('reports a read failure under -E instead of classifying missing bytes as data', async () => {
    await fixture.writeFile({ path: '/text', data: 'plain' });
    fixture.blockNativeReads(); fixture.read.mockRejectedValue(new Error('Unavailable host'));
    const result = await fixture.execute({ script: 'file -E /text', stdinText: undefined });
    expect(result.result.exitCode).not.toBe(0); expect(result.stderr.text + result.stdout.text).toContain('ERROR');
  });
});
