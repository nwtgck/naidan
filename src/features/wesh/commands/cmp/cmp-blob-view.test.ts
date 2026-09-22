// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlobViewShellFixture } from '@/features/wesh/utils/blob-view.test-helpers';
import { cmpCommandDefinition } from '@/features/wesh/commands/cmp/definition';

beforeAll(async () => {
  await cmpCommandDefinition.load();
});
let fixture: Awaited<ReturnType<typeof createBlobViewShellFixture>>;
beforeEach(async () => {
  fixture = await createBlobViewShellFixture();
});
afterEach(() => {
  fixture?.dispose(); vi.restoreAllMocks();
});

describe('cmp with safe efficient BlobView inputs', () => {
  it.each(['-i 2:3 -n 4', '-i 9007199254740993'])('compares sliced inputs without reading skipped prefixes: %s', async args => {
    await fixture.writeFile({ path: '/a', data: new Uint8Array([1, 2, 0, 255, 128, 195]) });
    await fixture.writeFile({ path: '/b', data: new Uint8Array([9, 8, 7, 0, 255, 128, 195]) });
    fixture.blockNativeReads();
    const open = vi.spyOn(fixture.wesh.vfs, 'open');
    const result = await fixture.execute({ script: `cmp ${args} /a /b`, stdinText: undefined });
    expect(result.result.exitCode).toBe(0); expect(result.stderr.text).toBe(''); expect(result.stdout.text).toBe('');
    expect(open.mock.calls.filter(([request]) => request.path === '/a' || request.path === '/b')).toEqual([]);
  });

  it('reports differences and EOF after independent skips using known snapshot sizes', async () => {
    await fixture.writeFile({ path: '/a', data: new Uint8Array([9, 0, 255, 128]) });
    await fixture.writeFile({ path: '/b', data: new Uint8Array([7, 7, 0, 254]) });
    fixture.blockNativeReads();
    const difference = await fixture.execute({ script: 'cmp -i 1:2 /a /b', stdinText: undefined });
    expect(difference.result.exitCode).toBe(1); expect(difference.stdout.text).toContain('char 2');
    const eof = await fixture.execute({ script: 'cmp -i 4:3 /a /b', stdinText: undefined });
    expect(eof.result.exitCode).toBe(1); expect(eof.stderr.text).toContain('EOF');
  });

  it('keeps stdin sequential rather than treating it as a whole Blob snapshot', async () => {
    await fixture.writeFile({ path: '/a', data: 'same' });
    fixture.blockNativeReads();
    const result = await fixture.execute({ script: 'cmp - /a', stdinText: 'same' });
    expect(result.result.exitCode).toBe(0); expect(result.stderr.text).toBe('');
  });

  it('reports host byte errors instead of equal or empty files', async () => {
    await fixture.writeFile({ path: '/a', data: 'same' });
    await fixture.writeFile({ path: '/b', data: 'same' });
    fixture.blockNativeReads(); fixture.read.mockRejectedValue(new Error('Unavailable host'));
    const result = await fixture.execute({ script: 'cmp /a /b', stdinText: undefined });
    expect(result.result.exitCode).toBe(2); expect(result.stderr.text).not.toBe('');
  });
});
