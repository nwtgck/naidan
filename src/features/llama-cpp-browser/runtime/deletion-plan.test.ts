import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDirectory } from '@/features/llama-cpp-browser/hugging-face/test-opfs';
import { MemoryDirectory } from '@/features/stable-diffusion-cpp-browser/test-utils/storage.test-support';
import { userModelDirectory } from './model-directory';
import { executeDeletionPlan, scanDeletionTree } from './deletion-plan';
import { prepareModelRemoval, prepareRepositoryRemoval, removeStoredModel } from './model-store';
import { createDownloadWriter } from '@/features/llama-cpp-browser/hugging-face/writer';
import { repositoryFolder, listPendingDownloads, listHuggingFaceModels } from '@/features/llama-cpp-browser/hugging-face/storage';
const selection = { repository: 'owner/repo', revision: 'a'.repeat(40), files: [{ path: 'nested/model.gguf', size: 128 }] };

beforeEach(() => {
  const root = memoryDirectory({ name: '' });
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => root },
    locks: {
      request: async (_name: string, optionsOrCallback: object | (() => Promise<unknown>), callback?: (lock: object) => Promise<unknown>) => callback ? callback({}) : typeof optionsOrCallback === 'function' ? optionsOrCallback() : undefined,
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

async function writeFile({ folder, name, value }: { folder: FileSystemDirectoryHandle, name: string, value: string }): Promise<void> {
  const writer = await (await folder.getFileHandle(name, { create: true })).createWritable();
  await writer.write(value);
  await writer.close();
}

describe('confirmed model deletion plans', () => {
  it('previews GGUF files, preserves later additions, rejects modifications, and preserves unrelated files', async () => {
    const root = await userModelDirectory();
    const folder = await root.getDirectoryHandle('model', { create: true });
    const nested = await folder.getDirectoryHandle('nested', { create: true });
    await writeFile({ folder: nested, name: 'model.gguf', value: 'model' });
    await writeFile({ folder, name: 'README.md', value: 'readme' });
    const plan = (await prepareModelRemoval({ modelId: 'user/model', signal: undefined })).plan;
    expect(plan.files.map(file => file.relativePath)).toEqual(['nested/model.gguf']);
    await writeFile({ folder, name: 'extra.gguf', value: 'external' });
    expect(await removeStoredModel({ plan })).toBe('deleted');
    expect((await scanDeletionTree({ folder })).files.map(file => file.relativePath)).toEqual(['README.md', 'extra.gguf']);
    await writeFile({ folder: await folder.getDirectoryHandle('nested', { create: true }), name: 'model.gguf', value: 'model' });
    const next = (await prepareModelRemoval({ modelId: 'user/model', signal: undefined })).plan;
    await writeFile({ folder: await folder.getDirectoryHandle('nested'), name: 'model.gguf', value: 'changed model' });
    expect(await removeStoredModel({ plan: next })).toBe('changed');
    expect(await removeStoredModel({ plan: (await prepareModelRemoval({ modelId: 'user/model', signal: undefined })).plan })).toBe('deleted');
    expect((await scanDeletionTree({ folder })).files.map(file => file.relativePath)).toEqual(['README.md']);
  });

  it('does not sweep up a file added while approved files are being removed', async () => {
    const folder = await (await userModelDirectory()).getDirectoryHandle('model', { create: true });
    const nested = await folder.getDirectoryHandle('nested', { create: true });
    await writeFile({ folder: nested, name: 'model.gguf', value: 'model' });
    const plan = (await prepareModelRemoval({ modelId: 'user/model', signal: undefined })).plan;
    const remove = nested.removeEntry.bind(nested);
    vi.spyOn(nested, 'removeEntry').mockImplementation(async (name, options) => {
      await remove(name, options);
      await writeFile({ folder: nested, name: 'new.txt', value: 'keep' });
    });
    expect(await removeStoredModel({ plan })).toBe('deleted');
    expect((await scanDeletionTree({ folder })).files.map(file => file.relativePath)).toEqual(['nested/new.txt']);
  });

  it('requires review again when a selected model gains a publication sidecar', async () => {
    const folder = await (await userModelDirectory()).getDirectoryHandle('model', { create: true });
    await writeFile({ folder, name: 'model.gguf', value: 'model' });
    const { plan } = await prepareModelRemoval({ modelId: 'user/model', signal: undefined });
    expect(plan.selectedRelativePaths).toContain('.model.gguf.pending');
    await writeFile({ folder, name: '.model.gguf.pending', value: 'external publisher' });

    expect(await removeStoredModel({ plan })).toBe('changed');
    expect((await scanDeletionTree({ folder })).files.map(file => file.relativePath)).toEqual(['.model.gguf.pending', 'model.gguf']);
  });

  it('deletes from the captured folder and preserves an empty replacement at its former path', async () => {
    const opfs = new MemoryDirectory('opfs');
    vi.stubGlobal('navigator', { ...navigator, storage: { getDirectory: async () => opfs } });
    const models = await opfs.getDirectoryHandle('models', { create: true });
    const parent = await models.getDirectoryHandle('user', { create: true });
    const original = await parent.getDirectoryHandle('model', { create: true });
    await writeFile({ folder: original as unknown as FileSystemDirectoryHandle, name: 'model.gguf', value: 'reviewed model' });
    const { plan } = await prepareModelRemoval({ modelId: 'user/model', signal: undefined });
    expect(plan.folder).toBe(original);

    const replacement = new MemoryDirectory('model');
    const sameEntry = vi.spyOn(replacement, 'isSameEntry');
    parent.children.set('model', replacement);

    expect(await removeStoredModel({ plan })).toBe('deleted');
    expect(original.children.size).toBe(0);
    expect(await parent.getDirectoryHandle('model')).toBe(replacement);
    expect(replacement.children.size).toBe(0);
    expect(sameEntry).toHaveBeenCalledWith(original);
  });

  it('preserves a file replacing an empty directory after the initial scan', async () => {
    const folder = await (await userModelDirectory()).getDirectoryHandle('model', { create: true });
    await folder.getDirectoryHandle('empty', { create: true });
    await writeFile({ folder, name: 'model.gguf', value: 'model' });
    const plan = (await prepareModelRemoval({ modelId: 'user/model', signal: undefined })).plan;
    const remove = folder.removeEntry.bind(folder);
    vi.spyOn(folder, 'removeEntry').mockImplementation(async (name, options) => {
      await remove(name, options);
      if (name === 'model.gguf') {
        await remove('empty');
        await writeFile({ folder, name: 'empty', value: 'unapproved replacement' });
      }
    });
    expect(await removeStoredModel({ plan })).toBe('deleted');
    expect((await (await folder.getFileHandle('empty')).getFile()).size).toBe(22);
  });

  it('keeps newly added sibling files and rejects forged paths', async () => {
    const root = await navigator.storage.getDirectory();
    const folder = await (await (await root.getDirectoryHandle('models', { create: true })).getDirectoryHandle('user', { create: true })).getDirectoryHandle('model-GGUF', { create: true });
    await folder.getDirectoryHandle('unrelated-empty', { create: true });
    for (const name of ['model.gguf']) {
      await writeFile({ folder, name, value: name });
    }
    const plan = (await prepareModelRemoval({ modelId: 'user/model-GGUF', signal: undefined })).plan;
    expect(plan.files.map(file => file.relativePath)).toEqual(['model.gguf']);
    await writeFile({ folder, name: 'extra.gguf', value: 'notes.txt' });
    await expect(removeStoredModel({ plan: { ...plan, files: [...plan.files, { relativePath: '../other', size: 0, lastModified: 0 }] } })).rejects.toThrow();
    expect(await removeStoredModel({ plan })).toBe('deleted');
    expect((await scanDeletionTree({ folder })).files.map(file => file.relativePath)).toEqual(['extra.gguf']);
    expect((await folder.getDirectoryHandle('unrelated-empty')).kind).toBe('directory');
  });

  it('removes an HF partial download and permits a fresh download despite remaining ancestors', async () => {
    await createDownloadWriter().begin({ selection });
    const { plan } = await prepareRepositoryRemoval({ location: { kind: 'hugging-face', repository: selection.repository }, signal: undefined });
    expect(plan.files.map(file => file.relativePath)).toEqual(['.llama-cpp-import-pending', 'nested/model.gguf']);
    expect(await removeStoredModel({ plan })).toBe('deleted');
    expect(await listPendingDownloads()).toEqual([]);
    expect(await listHuggingFaceModels()).toEqual([]);
    expect(await createDownloadWriter().begin({ selection })).toMatchObject({ status: 'ready' });
    expect((await listPendingDownloads())[0]?.selection).toEqual(selection);
  });

  it('stops on a late modification without deleting the modified file', async () => {
    const folder = await repositoryFolder({ repository: selection.repository, create: true });
    await writeFile({ folder, name: 'a', value: 'a' });
    await writeFile({ folder, name: 'b', value: 'b' });
    const { files } = await scanDeletionTree({ folder });
    const remove = folder.removeEntry.bind(folder);
    vi.spyOn(folder, 'removeEntry').mockImplementation(async (name, options) => {
      await remove(name, options);
      await writeFile({ folder, name: 'b', value: 'modified' });
    });
    expect(await executeDeletionPlan({ folder, files, selectedRelativePaths: undefined })).toBe('changed');
    expect((await (await folder.getFileHandle('b')).getFile()).size).toBe(8);
  });
});
