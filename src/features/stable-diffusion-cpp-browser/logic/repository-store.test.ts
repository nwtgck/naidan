// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { importImageRepository, listImageRepositories } from './repository-store';
import { MemoryDirectory } from '@/features/stable-diffusion-cpp-browser/test-utils/storage';
let root: MemoryDirectory;
const lock = vi.fn();
beforeEach(() => {
  root = new MemoryDirectory('root'); lock.mockReset();
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks: { request: async (name: string, options: { signal?: AbortSignal }, run: () => Promise<unknown>) => {
    options.signal?.throwIfAborted(); lock(name); return run();
  } } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const input = (): { name: string, files: { path: string, file: File }[] } => ({ name: 'モデル repo', files: [
  { path: 'README.md', file: new File(['model description'], 'README.md') },
  { path: 'vae/config.json', file: new File(['{}'], 'config.json') },
  { path: 'diffusion/weights.gguf', file: new File(['unverified bytes'], 'weights.gguf') },
] });
it('streams the working tree into models/user without filtering metadata or altering paths', async () => {
  const source = input(); for (const { file } of source.files) vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('Whole-file copy forbidden'));
  const progress = vi.fn();
  expect(await importImageRepository({ input: source, signal: undefined, onProgress: progress })).toBe('user/モデル repo');
  expect(lock).toHaveBeenCalledWith('naidan-llama-cpp-browser-model-mutation');
  const repositories = await listImageRepositories({ signal: undefined });
  expect(repositories).toHaveLength(1);
  expect(repositories[0]!.files.map(file => file.path)).toEqual(['diffusion/weights.gguf', 'README.md', 'vae/config.json'].sort((a, b) => a.localeCompare(b)));
  expect(await repositories[0]!.files.find(entry => entry.path === 'README.md')!.file.text()).toBe('model description');
  expect(progress).toHaveBeenCalled();
});
it('never overwrites an existing repository', async () => {
  await importImageRepository({ input: input(), signal: undefined, onProgress() {} });
  await expect(importImageRepository({ input: input(), signal: undefined, onProgress() {} })).rejects.toThrow('already exists');
  expect((await listImageRepositories({ signal: undefined }))).toHaveLength(1);
});
it.each(['../escape.gguf', '/absolute.gguf', 'a/../b', 'x\\y', '.llama-cpp-import-pending', '.git/config'])('rejects unsafe paths before writing %s', async path => {
  await expect(importImageRepository({ input: { name: 'repo', files: [{ path, file: new File(['bytes'], 'f') }] }, signal: undefined, onProgress() {} })).rejects.toThrow();
  expect(root.children.size).toBe(0);
});
it('rejects file/directory collisions before writing', async () => {
  await expect(importImageRepository({ input: { name: 'repo', files: ['a', 'a/b'].map(path => ({ path, file: new File(['x'], 'f') })) }, signal: undefined, onProgress() {} })).rejects.toThrow('collision');
  expect(root.children.size).toBe(0);
});
it('cancels an in-flight stream, rolls back owned files, and never publishes a partial repository', async () => {
  const controller = new AbortController();
  await expect(importImageRepository({ input: input(), signal: controller.signal, onProgress() {
    controller.abort();
  } })).rejects.toThrow();
  expect(await listImageRepositories({ signal: undefined })).toEqual([]);
  const user = await (await root.getDirectoryHandle('models')).getDirectoryHandle('user'); expect(user.children.size).toBe(0);
});
it('retains foreign files and keeps the pending marker after an interrupted import', async () => {
  const controller = new AbortController();
  await expect(importImageRepository({ input: input(), signal: controller.signal, onProgress() {
    const models = root.children.get('models'); if (models?.kind !== 'directory') throw new Error('models');
    const user = models.children.get('user'); if (user?.kind !== 'directory') throw new Error('user');
    const repo = user.children.get('モデル repo'); if (repo?.kind !== 'directory') throw new Error('repo');
    repo.children.set('foreign', new MemoryDirectory('foreign')); controller.abort();
  } })).rejects.toThrow();
  const repo = await (await (await root.getDirectoryHandle('models')).getDirectoryHandle('user')).getDirectoryHandle('モデル repo');
  expect(repo.children.has('foreign')).toBe(true); expect(repo.children.has('.llama-cpp-import-pending')).toBe(true);
  expect(await listImageRepositories({ signal: undefined })).toEqual([]);
});
it('does not read from the network when enumerating existing cached HF repositories', async () => {
  const network = vi.fn(); vi.stubGlobal('fetch', network);
  let folder = root;
  for (const name of ['models', 'huggingface.co', 'owner', 'repo', 'resolve', 'main']) folder = await folder.getDirectoryHandle(name, { create: true });
  const file = await folder.getFileHandle('weights.gguf', { create: true }); const writer = await file.createWritable(); await writer.write(new Uint8Array([1, 2])); await writer.close();
  const models = await listImageRepositories({ signal: undefined });
  expect(models[0]!.id).toContain('owner/repo'); expect(network).not.toHaveBeenCalled();
});
