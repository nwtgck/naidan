// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryDirectory, MemoryFile } from '@/features/stable-diffusion-cpp-browser/test-utils/storage.test-support';
import { migrateLegacyDownloads } from './legacy';
import type { HuggingFaceFile } from './source';
import type { DownloadDestination } from '@/01-models/download';
const host = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: host }));
let root: MemoryDirectory;
const files: HuggingFaceFile[] = ['first.gguf', 'parts/second.gguf'].map(path => ({ repository: 'org/repo', revision: 'a'.repeat(40), path, size: 128, sha256: 'b'.repeat(64) }));
const legacyName = '.llama-cpp-import-pending';

beforeEach(() => {
  root = new MemoryDirectory('root');
  host.get.mockResolvedValue(root);
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks: { request: async (_name: string, _options: object, run: () => Promise<unknown>) => run() } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture({ kind }: { kind: 'opfs' | 'host' }) {
  const destination: DownloadDestination = kind === 'opfs' ? { kind } : { kind, directoryId: 'linked' };
  let folder = root;
  for (const part of kind === 'opfs' ? ['models', 'huggingface.co', 'org', 'repo', 'resolve', 'main'] : ['org', 'repo']) {
    folder = await folder.getDirectoryHandle(part, { create: true });
  }
  const directories = [folder, await folder.getDirectoryHandle('parts', { create: true })];
  const journal = { version: 1, selection: { repository: files[0]!.repository, revision: files[0]!.revision, files: files.map(({ path, size }) => ({ path, size })) }, bytes: [64, 32], complete: [false, false], reused: [false, false] };
  const legacy = await folder.getFileHandle(legacyName, { create: true });
  legacy.data = new TextEncoder().encode(JSON.stringify(journal));
  for (const [index, file] of files.entries()) {
    const payload = await directories[index]!.getFileHandle(file.path.split('/').at(-1)!, { create: true });
    payload.data = new Uint8Array(journal.bytes[index]!);
  }
  const run = ({ selection }: { selection: readonly HuggingFaceFile[] }) => migrateLegacyDownloads({ files: selection, destination, expectedRoot: kind === 'host' ? root as unknown as FileSystemDirectoryHandle : undefined, signal: new AbortController().signal });
  return { folder, directories, journal, legacy, run };
}

function json({ file }: { file: MemoryFile }): unknown {
  return JSON.parse(new TextDecoder().decode(file.data));
}

describe.each(['opfs', 'host'] as const)('legacy protection on %s', kind => {
  it('protects every file with generic markers before removing the repository journal', async () => {
    const { folder, directories, run } = await fixture({ kind });
    await run({ selection: files });
    expect(folder.children.has(legacyName)).toBe(false);
    for (const [index, file] of files.entries()) {
      const marker = await directories[index]!.getFileHandle(`.${file.path.split('/').at(-1)!}.pending`);
      expect(json({ file: marker })).toEqual({ version: 2, kind: 'naidan-file-download', source: file, bytes: [64, 32][index], state: 'partial' });
    }
  });

  it('does not remove protection for a partial selection or an unknown local import', async () => {
    const { folder, legacy, run } = await fixture({ kind });
    await expect(run({ selection: files.slice(0, 1) })).rejects.toThrow('complete unfinished selection');
    expect(folder.children.has('.first.gguf.pending')).toBe(false);
    legacy.data = new TextEncoder().encode(JSON.stringify({ kind: 'local-import', version: 1 }));
    await expect(run({ selection: files })).rejects.toThrow('unfinished operation');
    expect(json({ file: legacy })).toEqual({ kind: 'local-import', version: 1 });
  });

  it('retains the repository journal after an interrupted conversion and safely retries', async () => {
    const { folder, directories, run } = await fixture({ kind });
    const marker = await directories[1]!.getFileHandle('.second.gguf.pending', { create: true });
    marker.data = new TextEncoder().encode(JSON.stringify({ version: 1, kind: 'naidan-llama-download', repository: files[1]!.repository, revision: files[1]!.revision, file: { path: files[1]!.path, size: 128 } }));
    marker.failWrite = true;
    await expect(run({ selection: files })).rejects.toThrow('Quota');
    expect(folder.children.has(legacyName)).toBe(true);
    expect(json({ file: await folder.getFileHandle('.first.gguf.pending') })).toMatchObject({ version: 2, bytes: 64 });
    marker.failWrite = false;
    await run({ selection: files });
    expect(folder.children.has(legacyName)).toBe(false);
  });

  it('does not overwrite a foreign marker or trust a shortened payload', async () => {
    const { folder, run } = await fixture({ kind });
    const marker = await folder.getFileHandle('.first.gguf.pending', { create: true });
    marker.data = new TextEncoder().encode(JSON.stringify({ owner: 'other' }));
    await expect(run({ selection: files })).rejects.toThrow();
    expect(json({ file: marker })).toEqual({ owner: 'other' });
    await folder.removeEntry('.first.gguf.pending');
    (await folder.getFileHandle('first.gguf')).data = new Uint8Array(16);
    await expect(run({ selection: files })).rejects.toThrow('shorter');
    expect(folder.children.has(legacyName)).toBe(true);
  });
});

export const TEST_ONLY = {
};
