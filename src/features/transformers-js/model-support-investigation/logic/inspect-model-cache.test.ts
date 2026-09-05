import { describe, expect, it } from 'vitest';
import { inspectModelCache } from './inspect-model-cache';

type FakeHandle = FakeDirectory | FakeFile;
interface FakeDirectory {
  kind: 'directory',
  children: Record<string, FakeHandle>,
}
interface FakeFile {
  kind: 'file',
  size: number,
  lastModified: number,
}

function file({ size, lastModified = 1 }: { size: number, lastModified?: number }): FakeFile {
  return { kind: 'file', size, lastModified };
}

function directory({ children }: { children: Record<string, FakeHandle> }): FakeDirectory {
  return { kind: 'directory', children };
}

function toDirectoryHandle({ value }: { value: FakeDirectory }): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name: 'fake',
    async getDirectoryHandle(name: string) {
      const child = value.children[name];
      if (child?.kind !== 'directory') throw new DOMException('Not found', 'NotFoundError');
      return toDirectoryHandle({ value: child });
    },
    async *entries() {
      for (const [name, child] of Object.entries(value.children)) {
        if (child.kind === 'directory') {
          yield [name, toDirectoryHandle({ value: child })] as [string, FileSystemDirectoryHandle];
        } else {
          yield [name, {
            kind: 'file',
            name,
            getFile: async () => new File([new Uint8Array(child.size)], name, { lastModified: child.lastModified }),
          } as FileSystemFileHandle] as [string, FileSystemHandle];
        }
      }
    },
  } as FileSystemDirectoryHandle;
}

function storageRoot({ modelChildren }: { modelChildren: Record<string, FakeHandle> }): FileSystemDirectoryHandle {
  return toDirectoryHandle({ value: directory({ children: {
    models: directory({ children: {
      'huggingface.co': directory({ children: {
        org: directory({ children: {
          model: directory({ children: modelChildren }),
        } }),
      } }),
    } }),
  } }) });
}

describe('inspectModelCache', () => {
  it('records nested files, completion markers, sizes, and weight identity', async () => {
    const root = storageRoot({ modelChildren: {
      resolve: directory({ children: {
        main: directory({ children: {
          'config.json': file({ size: 10 }),
          '.config.json.complete': file({ size: 0 }),
          'tokenizer.model': file({ size: 20 }),
          '.tokenizer.model.complete': file({ size: 0 }),
          'model_q4.onnx': file({ size: 30 }),
          '.model_q4.onnx.complete': file({ size: 0 }),
          '.missing.onnx.complete': file({ size: 0 }),
        } }),
      } }),
    } });

    const result = await inspectModelCache({ modelId: 'hf.co/org/model', storageRoot: root });

    expect(result).toMatchObject({
      exists: true,
      totalBytes: 60,
      fileCount: 3,
      revisionProvenance: 'unknown',
      completionMarkerCount: 4,
      incompleteFileCount: 0,
      orphanCompletionMarkerCount: 1,
      orphanCompletionMarkerPaths: ['resolve/main/.missing.onnx.complete'],
      zeroByteFileCount: 0,
      weightFileCount: 1,
      allFilesHaveCompletionMarkers: true,
    });
    expect(result.files.find(entry => entry.path.endsWith('tokenizer.model'))?.isWeightFile).toBe(false);
    expect(result.files.find(entry => entry.path.endsWith('model_q4.onnx'))).toMatchObject({
      repositoryPath: 'model_q4.onnx',
      cacheRevision: 'main',
      hasCompletionMarker: true,
    });
  });

  it('returns an empty inventory when the model directory does not exist', async () => {
    const root = toDirectoryHandle({ value: directory({ children: {} }) });
    const result = await inspectModelCache({ modelId: 'org/model', storageRoot: root });
    expect(result).toMatchObject({ exists: false, fileCount: 0, allFilesHaveCompletionMarkers: false });
  });

  it('keeps root-level legacy metadata in evidence without counting it as an incomplete cached artifact', async () => {
    const root = storageRoot({ modelChildren: {
      '.naidan-download-manifest.json': file({ size: 478 }),
      resolve: directory({ children: {
        main: directory({ children: {
          'model_q4.onnx': file({ size: 30 }),
          '.model_q4.onnx.complete': file({ size: 0 }),
        } }),
      } }),
    } });

    const result = await inspectModelCache({ modelId: 'hf.co/org/model', storageRoot: root });

    expect(result).toMatchObject({
      fileCount: 2,
      incompleteFileCount: 0,
      allFilesHaveCompletionMarkers: true,
    });
    expect(result.files).toContainEqual(expect.objectContaining({
      path: '.naidan-download-manifest.json',
      repositoryPath: undefined,
      hasCompletionMarker: false,
    }));
  });
});
