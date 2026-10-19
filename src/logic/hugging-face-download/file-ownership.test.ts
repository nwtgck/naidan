// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryDirectory, MemoryFile } from '@/features/stable-diffusion-cpp-browser/test-utils/storage.test-support';
import { saveHuggingFaceFile } from './file';
import type { DownloadDestination } from '@/01-models/download';
const host = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: host }));
let root: MemoryDirectory;
const bytes = new Uint8Array(128).fill(7);
const file = { repository: 'org/repo', revision: 'a'.repeat(40), path: 'large.dat', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };

beforeEach(() => {
  root = new MemoryDirectory('root');
  host.get.mockResolvedValue(root);
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks: { request: async (_name: string, _options: object, run: () => Promise<unknown>) => run() } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(['opfs', 'host'] as const)('download ownership on %s', kind => {
  it.each(['same-handle', 'replacement-handle'] as const)('preserves a foreign %s marker without publishing or committing host staging', async replacement => {
    let folder = root;
    for (const part of kind === 'opfs' ? ['models', 'huggingface.co', 'org', 'repo', 'resolve', 'main'] : ['org', 'repo']) {
      folder = await folder.getDirectoryHandle(part, { create: true });
    }
    const destination: DownloadDestination = kind === 'opfs' ? { kind } : { kind, directoryId: 'linked' };
    const other = new TextEncoder().encode(JSON.stringify({ owner: 'another-download' }));
    let replaced = false;
    const running = saveHuggingFaceFile({
      file,
      signal: new AbortController().signal,
      destination,
      expectedRoot: kind === 'host' ? root as unknown as FileSystemDirectoryHandle : undefined,
      validation: 'none',
      report: ({ progress }) => {
        if (progress.phase !== 'transferring' || replaced) {
          return;
        }
        replaced = true;
        const existing = folder.children.get('.large.dat.pending');
        expect(existing?.kind).toBe('file');
        const marker = replacement === 'replacement-handle' ? new MemoryFile('.large.dat.pending') : existing as MemoryFile;
        marker.data = other;
        folder.children.set(marker.name, marker);
      },
      fetch: async () => ({
        status: 200,
        statusText: '',
        ok: true,
        url: '',
        headers: new Headers({ 'content-length': String(bytes.length) }),
        redirected: false,
        responseType: 'basic',
        policyName: 'test',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      }),
    });
    await expect(running).rejects.toThrow('ownership changed');
    expect(replaced).toBe(true);
    expect((await folder.getFileHandle('.large.dat.pending')).data).toEqual(other);
    expect(folder.children.has('.large.dat.complete')).toBe(false);
    if (kind === 'host') {
      expect((await folder.getFileHandle('large.dat')).data.length).toBe(0);
    }
  });
});

export const TEST_ONLY = {
};
