// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryDirectory, MemoryFile, type MemoryMoves } from '@/utils/file-system-publication/memory.test-support';
import { importImageRepository, listImageRepositories } from './repository-store';
import { importModelDirectory } from '@/features/llama-cpp-browser/runtime/model-directory';
import { localRepositoryInput } from '@/features/llama-cpp-browser/runtime/model-directory-input';

let root: MemoryDirectory, moves: MemoryMoves;

beforeEach(() => {
  moves = { calls: [] };
  root = new MemoryDirectory('root', moves);
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks: { request: async (_name: string, _options: object, run: () => Promise<unknown>) => run() } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function user(): Promise<MemoryDirectory> {
  return (await root.getDirectoryHandle('models')).getDirectoryHandle('user');
}

const input = {
  rootName: 'local',
  files: [
    { relativePath: 'model.gguf', file: new File(['weights'], 'model.gguf') },
    { relativePath: 'config.json', file: new File(['{}'], 'config.json') },
  ],
};

describe('local import staging', () => {
  it('moves each image file and removes the repository guard only after all files finish', async () => {
    moves.beforeMove = async ({ to }) => {
      if (to === 'model.gguf' || to === 'config.json') {
        expect((await (await user()).getDirectoryHandle('local')).children.has('.llama-cpp-import-pending')).toBe(true);
        expect(await listImageRepositories({ signal: undefined })).toEqual([]);
      }
    };
    expect(await importImageRepository({ input, signal: undefined, onProgress: () => undefined })).toBe('user/local');
    expect([...((await (await user()).getDirectoryHandle('local')).children.keys())].sort()).toEqual(['config.json', 'model.gguf']);
    expect((await listImageRepositories({ signal: undefined }))[0]?.files.map(file => file.relativePath)).toEqual(['config.json', 'model.gguf']);
    expect(moves.calls.filter(call => !['model.gguf', 'config.json'].includes(call.to))).toHaveLength(1);
  });

  it('rolls back already moved files and closed staging on a later file failure', async () => {
    moves.beforeMove = ({ to }) => {
      if (to === 'config.json') {
        throw new Error('Move blocked');
      }
    };
    await expect(importImageRepository({ input, signal: undefined, onProgress: () => undefined })).rejects.toThrow('Move blocked');
    expect((await user()).children.size).toBe(0);
  });

  it('cleans its image file even when the move reports a failure after renaming it', async () => {
    moves.afterMove = ({ to }) => {
      if (to === 'model.gguf') {
        throw new Error('Failed after rename');
      }
    };
    await expect(importImageRepository({ input, signal: undefined, onProgress: () => undefined })).rejects.toThrow('Failed after rename');
    expect((await user()).children.size).toBe(0);
  });

  it('cleans its llama.cpp file even when the move reports a failure after renaming it', async () => {
    const bytes = new Uint8Array(256);
    bytes.set([71, 71, 85, 70, 3, 0, 0, 0]);
    const directory = { rootName: 'late-failure', files: [{ relativePath: 'model.gguf', file: new File([bytes], 'model.gguf') }] };
    moves.afterMove = ({ to }) => {
      if (to === 'model.gguf') {
        throw new Error('Failed after rename');
      }
    };
    await expect(importModelDirectory({ directory, signal: undefined, onProgress: () => undefined })).rejects.toThrow('Failed after rename');
    expect((await user()).children.size).toBe(0);
  });

  it('preserves an unrelated final and keeps the partial repository hidden', async () => {
    let foreign: MemoryFile | undefined;
    await expect(importImageRepository({
      input,
      signal: undefined,
      onProgress: ({ progress }) => {
        if (progress.path === 'model.gguf') {
          const models = root.children.get('models') as MemoryDirectory;
          const directory = ((models.children.get('user') as MemoryDirectory).children.get('local') as MemoryDirectory);
          foreign = new MemoryFile('model.gguf');
          foreign.data = new TextEncoder().encode('foreign');
          directory.children.set('model.gguf', foreign);
        }
      },
    })).rejects.toThrow('already exists');
    const directory = await (await user()).getDirectoryHandle('local');
    expect(directory.children.get('model.gguf')).toBe(foreign);
    expect(directory.children.has('.llama-cpp-import-pending')).toBe(true);
    expect(directory.children.has('model.gguf.tmp')).toBe(false);
    expect(await listImageRepositories({ signal: undefined })).toEqual([]);
  });

  it('keeps the historical image import protocol on unsupported directories', async () => {
    root = new MemoryDirectory('root');
    await importImageRepository({ input, signal: undefined, onProgress: () => undefined });
    const directory = await (await user()).getDirectoryHandle('local');
    expect(directory.children.has('.model.gguf.complete')).toBe(true);
    expect(directory.children.has('.config.json.complete')).toBe(true);
  });

  it('uses the same .tmp primitive for a llama.cpp import with no new markers', async () => {
    const bytes = new Uint8Array(256);
    bytes.set([71, 71, 85, 70, 3, 0, 0, 0]);
    const directory = { rootName: 'lm', files: [{ relativePath: 'model.gguf', file: new File([bytes], 'model.gguf') }] };
    let guarded = false;
    moves.beforeMove = async ({ to }) => {
      if (to === 'model.gguf') {
        guarded = (await (await user()).getDirectoryHandle('lm')).children.has('.llama-cpp-import-pending');
      }
    };
    const model = await importModelDirectory({ directory, signal: undefined, onProgress: () => undefined });
    expect(model.size).toBe(256);
    expect(guarded).toBe(true);
    expect([...((await (await user()).getDirectoryHandle('lm')).children.keys())]).toEqual(['model.gguf']);
  });

  it('preserves a conflicting llama.cpp destination instead of recursively deleting the new root', async () => {
    const bytes = new Uint8Array(256);
    bytes.set([71, 71, 85, 70, 3, 0, 0, 0]);
    const directory = { rootName: 'collision', files: [{ relativePath: 'model.gguf', file: new File([bytes], 'model.gguf') }] };
    const foreign = new MemoryFile('model.gguf');
    foreign.data = new TextEncoder().encode('foreign');
    await expect(importModelDirectory({
      directory,
      signal: undefined,
      onProgress: () => {
        const models = root.children.get('models') as MemoryDirectory;
        const folder = (models.children.get('user') as MemoryDirectory).children.get('collision') as MemoryDirectory;
        folder.children.set('model.gguf', foreign);
      },
    })).rejects.toThrow('already exists');
    const folder = await (await user()).getDirectoryHandle('collision');
    expect(folder.children.get('model.gguf')).toBe(foreign);
    expect(folder.children.has('model.gguf.tmp')).toBe(false);
    expect(folder.children.has('.llama-cpp-import-pending')).toBe(true);
  });

  it('removes its already moved llama.cpp files on cancellation without recursive removal', async () => {
    const bytes = new Uint8Array(256);
    bytes.set([71, 71, 85, 70, 3, 0, 0, 0]);
    const directory = {
      rootName: 'cancel',
      files: [
        { relativePath: 'weights/model.gguf', file: new File([bytes], 'model.gguf') },
        { relativePath: 'vision/mmproj.gguf', file: new File([bytes], 'mmproj.gguf') },
      ],
    };
    const abort = new AbortController();
    await expect(importModelDirectory({
      directory,
      signal: abort.signal,
      onProgress: ({ progress }) => {
        if (progress.completed > 256) {
          abort.abort();
        }
      },
    })).rejects.toThrow('aborted');
    expect(moves.calls.some(call => call.to === 'model.gguf')).toBe(true);
    expect((await user()).children.size).toBe(0);
  });

  it('filters only existing import markers from llama.cpp input', () => {
    const directory = { rootName: 'lm', files: ['model.gguf', '.model.gguf.complete', '.llama-cpp-import-pending'].map(relativePath => ({ relativePath, file: new File([''], relativePath) })) };
    expect(localRepositoryInput({ directory }).files.map(file => file.relativePath)).toEqual(['model.gguf']);
  });

  it.each(['config.tmp', 'config.tmp/nested.json'])('keeps a legitimate %s input instead of reserving the suffix globally', async relativePath => {
    const files = [...input.files, { relativePath, file: new File(['auxiliary'], 'config.tmp') }];
    await importImageRepository({ input: { ...input, files }, signal: undefined, onProgress: () => undefined });
    const listed = await listImageRepositories({ signal: undefined });
    expect(listed[0]?.files.map(file => file.relativePath)).toContain(relativePath);
  });

  it.each(['config.json.tmp', 'config.json.tmp/nested.json'])('uses the base path only for a real staging collision with %s', async relativePath => {
    const files = [...input.files, { relativePath, file: new File(['auxiliary'], 'config.json.tmp') }];
    await importImageRepository({ input: { ...input, files }, signal: undefined, onProgress: () => undefined });
    const directory = await (await user()).getDirectoryHandle('local');
    expect(await (await (await directory.getFileHandle('config.json')).getFile()).text()).toBe('{}');
    expect((await listImageRepositories({ signal: undefined }))[0]?.files.map(file => file.relativePath)).toContain(relativePath);
    expect(moves.calls.some(call => call.to === 'config.json')).toBe(false);
    expect(moves.calls.some(call => call.to === 'model.gguf')).toBe(true);
  });
});
