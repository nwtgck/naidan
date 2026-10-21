// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createTemporaryModelFiles } from './temporary-model-files';
import { modelFileLocation, modelFileSchema, readStoredModelFile, readTemporaryModelFile } from './model-file-system';

it.each(['opfs', 'host'] as const)('preserves the captured %s handle and snapshot without imposing another feature path policy', async storageKind => {
  const file = new File(['weights'], 'model.gguf');
  const getFile = vi.fn(async () => file);
  const handle = { kind: 'file', getFile } as unknown as FileSystemFileHandle;
  const relativePath = 'Q4/'.repeat(70) + 'model\x7f.gguf';
  const captured = await readStoredModelFile({ relativePath, handle, storageKind, signal: undefined });
  expect(captured).toEqual({ relativePath, file, handle, storageKind });
  expect(modelFileSchema.parse(captured)).toEqual(captured);
  expect(getFile).toHaveBeenCalledOnce();
});

it('honors cancellation before and after asynchronous snapshot acquisition', async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  const getFile = vi.fn(async () => new File(['weights'], 'model.gguf'));
  const handle = { kind: 'file', getFile } as unknown as FileSystemFileHandle;
  await expect(readStoredModelFile({ relativePath: 'model.gguf', handle, storageKind: 'opfs', signal: cancelled.signal })).rejects.toThrow();
  expect(getFile).not.toHaveBeenCalled();
  const controller = new AbortController();
  getFile.mockImplementation(async () => {
    controller.abort();
    return new File(['weights'], 'model.gguf');
  });
  await expect(readStoredModelFile({ relativePath: 'model.gguf', handle, storageKind: 'host', signal: controller.signal })).rejects.toThrow();
});

it('keeps a queued temporary file bound to its captured registration when the visible root is reused', () => {
  const registry = createTemporaryModelFiles();
  const original = new File(['original'], 'model.gguf');
  const root = registry.register({ directory: { rootName: 'MyModel', files: [{ relativePath: 'weights/model.gguf', file: original }] }, signal: undefined });
  expect(readTemporaryModelFile({ root, relativePath: 'weights/model.gguf' }).file).toBe(original);
  registry.remove({ rootPath: root.rootPath });
  const replacement = registry.register({ directory: { rootName: 'MyModel', files: [{ relativePath: 'weights/model.gguf', file: new File(['replacement'], 'model.gguf') }] }, signal: undefined });
  const captured = readTemporaryModelFile({ root, relativePath: 'weights/model.gguf' });
  expect(replacement.rootPath).toBe(root.rootPath);
  expect(readTemporaryModelFile({ root: replacement, relativePath: 'weights/model.gguf' }).file).not.toBe(original);
  expect(captured).toEqual({ relativePath: 'weights/model.gguf', file: original, storageKind: 'temp', registrationRevision: root.registrationRevision });
  expect(() => readTemporaryModelFile({ root, relativePath: 'absent.gguf' })).toThrow();
  expect(modelFileSchema.safeParse({ ...captured, handle: {} }).success).toBe(false);
  expect(modelFileSchema.safeParse({ ...captured, storageKind: 'opfs' }).success).toBe(false);
});

it('preserves image persistence locations for every mount', () => {
  expect(modelFileLocation({ repositoryKey: 'user/ImageSet', hostSource: undefined, relativePath: 'vae/model.safetensors' })).toEqual({ kind: 'opfs', path: 'models/user/ImageSet/vae/model.safetensors' });
  expect(modelFileLocation({ repositoryKey: 'temp/MyModel', hostSource: undefined, relativePath: 'model.gguf' })).toEqual({ kind: 'temp', path: 'temp/MyModel/model.gguf' });
  expect(modelFileLocation({ repositoryKey: 'host/internal-id/owner/ImageSet', hostSource: { directoryId: 'directory-id', directoryName: 'MyModels1', repository: 'owner/ImageSet' }, relativePath: 'vae.sft' })).toEqual({ kind: 'host', directoryId: 'directory-id', path: 'owner/ImageSet/vae.sft' });
});
