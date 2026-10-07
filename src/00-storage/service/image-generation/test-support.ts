import { File as NodeFile } from 'node:buffer';
import { vi } from 'vitest';
import type { ImageGenerationAsset, ImageGenerationRun, ImageGenerationSession } from '@/01-models/image-generation';
import { planImageGenerationSeeds } from '@/01-models/image-generation';
import { toBinaryObjectId, toHostModelDirectoryId, toImageGenerationAssetId, toImageGenerationRunId, toImageGenerationSessionId, type ImageGenerationSessionId } from '@/01-models/ids';

export function createImageGenerationStorageHarness() {
  const faults = new Set<string>();
  const writes: string[] = [], reads: string[] = [], acquired: string[] = [];
  function fault({ operation, path }: { operation: string, path: string }): void {
    if (faults.delete(`${operation}:${path}`)) throw new Error(`Injected ${operation} failure: ${path}`);
  }
  class MockFile {
    readonly kind = 'file';
    text = '';
    readonly name: string;
    readonly path: string;
    constructor({ name, path }: { name: string, path: string }) {
      this.name = name; this.path = path;
    }
    async getFile() {
      reads.push(this.path); fault({ operation: 'read', path: this.path });
      const text = this.text;
      return new NodeFile([text], this.name, { type: 'application/json' });
    }
    async createWritable() {
      let pending = '';
      fault({ operation: 'open', path: this.path });
      return {
        // eslint-disable-next-line local-rules-named-args/require-named-args -- FileSystemWritableFileStream.write is a browser positional contract.
        write: async (text: string) => {
          fault({ operation: 'write', path: this.path }); pending = text;
        },
        close: async () => {
          fault({ operation: 'close', path: this.path }); this.text = pending; writes.push(this.path);
        },
        abort: async () => {
          fault({ operation: 'abort', path: this.path });
        },
      };
    }
  }
  class MockDirectory {
    readonly kind = 'directory';
    readonly children = new Map<string, MockDirectory | MockFile>();
    readonly name: string;
    readonly path: string;
    constructor({ name, path }: { name: string, path: string }) {
      this.name = name; this.path = path;
    }
    // eslint-disable-next-line local-rules-named-args/require-named-args -- FileSystemDirectoryHandle.getDirectoryHandle is a browser positional contract.
    async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MockDirectory> {
      if (name.includes('/') || name === '.' || name === '..') throw new Error('Invalid directory component.');
      let child = this.children.get(name);
      if (!child && options?.create) {
        child = new MockDirectory({ name, path: `${this.path}/${name}` }); this.children.set(name, child);
      }
      if (!child) throw new DOMException('Missing directory', 'NotFoundError');
      if (!(child instanceof MockDirectory)) throw new DOMException('Not a directory', 'TypeMismatchError');
      return child;
    }
    // eslint-disable-next-line local-rules-named-args/require-named-args -- FileSystemDirectoryHandle.getFileHandle is a browser positional contract.
    async getFileHandle(name: string, options?: { create?: boolean }): Promise<MockFile> {
      if (name.includes('/') || name === '.' || name === '..') throw new Error('Invalid file component.');
      let child = this.children.get(name);
      if (!child && options?.create) {
        child = new MockFile({ name, path: `${this.path}/${name}` }); this.children.set(name, child);
      }
      if (!child) throw new DOMException('Missing file', 'NotFoundError');
      if (!(child instanceof MockFile)) throw new DOMException('Not a file', 'TypeMismatchError');
      return child;
    }
    async *entries() {
      fault({ operation: 'enumerate', path: this.path });
      yield* this.children.entries();
    }
    // eslint-disable-next-line local-rules-named-args/require-named-args -- FileSystemDirectoryHandle.removeEntry is a browser positional contract.
    async removeEntry(name: string, options?: { recursive?: boolean }) {
      fault({ operation: 'remove', path: `${this.path}/${name}` });
      const child = this.children.get(name);
      if (!child) throw new DOMException('Missing entry', 'NotFoundError');
      if (child instanceof MockDirectory && child.children.size && !options?.recursive) throw new DOMException('Directory is not empty', 'InvalidModificationError');
      this.children.delete(name);
    }
  }
  const root = new MockDirectory({ name: '', path: '' });
  const tails = new Map<string, Promise<unknown>>();
  const getDirectory = vi.fn(async () => root);
  vi.stubGlobal('navigator', {
    storage: { getDirectory },
    locks: {
      // eslint-disable-next-line local-rules-named-args/require-named-args -- LockManager.request is a browser positional contract.
      request<T>(name: string, operation: () => Promise<T>): Promise<T> {
        const pending = (tails.get(name) ?? Promise.resolve()).then(async () => {
          acquired.push(name); return operation();
        });
        tails.set(name, pending.catch(() => {})); return pending;
      },
    },
  });
  async function directory({ path }: { path: string }): Promise<MockDirectory> {
    let value = root;
    for (const name of path.split('/').filter(Boolean)) value = await value.getDirectoryHandle(name);
    return value;
  }
  async function file({ path }: { path: string }): Promise<MockFile> {
    const index = path.lastIndexOf('/');
    return (await directory({ path: path.slice(0, index) })).getFileHandle(path.slice(index + 1));
  }
  return { root, writes, reads, acquired, faults, getDirectory, directory, file };
}

export function generationSessionFixture({ id }: { id: string }): ImageGenerationSession {
  return { activityOrder: undefined, translation: undefined, assistantChatId: undefined, id: toImageGenerationSessionId({ raw: id }), revision: 0, title: '雨の夜景', createdAt: 1, updatedAt: 1, state: 'active' };
}
export function generationRunFixture({ id, sessionId, count, seed }: { id: string, sessionId: ImageGenerationSessionId, count: number, seed: string }): ImageGenerationRun {
  return {
    acceptedOrder: undefined,
    id: toImageGenerationRunId({ raw: id }),
    sessionId,
    revision: 0,
    createdAt: 2,
    seeds: planImageGenerationSeeds({ baseSeed: seed, count }),
    sources: [],
    execution: { type: 'queued' },
    request: {
      parameters: {
        prompt: '雨夜景 / cinematic night',
        negativePrompt: 'blur',
        width: 256,
        height: 256,
        steps: 9,
        guidance: 1,
        seed,
        sampler: 'euler',
        scheduler: 'simple',
        distilledGuidance: 3.5,
        vaeTiling: true,
        vaeTileSize: 32,
        flashAttention: false,
        bf16WeightType: 'f32',
        qwenVaePolicy: 'bounded',
        conditioningCacheSize: 4,
        modelArguments: '--example',
      },
      models: [{
        slot: 'diffusion',
        path: 'weights/main.gguf',
        file: { type: 'opfs', path: 'models/custom/main.gguf', name: 'main.gguf', size: 1000, lastModified: 1 },
        companions: [
        { path: 'weights/tokenizer.json', file: { type: 'host', directoryId: toHostModelDirectoryId({ raw: 'host-models' }), path: 'custom/tokenizer.json', name: 'tokenizer.json', size: 100, lastModified: 1 } },
      ],
      }],
      loras: [{ path: 'inactive.gguf', file: { type: 'file', name: 'inactive.gguf', size: 80, lastModified: 2 }, strength: 0 }],
      imageInputs: { initImage: { binaryObjectId: toBinaryObjectId({ raw: 'input-aa' }), name: 'initial.png' }, strength: 0.75, referenceImages: [{ binaryObjectId: toBinaryObjectId({ raw: 'reference-aa' }), name: 'reference.png' }] },
      preview: { enabled: true, interval: 2, startStep: 1, mode: 'projection', maxEdge: 256 },
      runtime: { sourceCommit: 'test-source', profile: 'webgpu-wasm64-jspi', weightResidency: 'auto', gpuBudgetMiB: undefined },
    },
  };
}
export function generationAssetFixture({ id, run, index }: { id: string, run: ImageGenerationRun, index: number }): ImageGenerationAsset {
  const seed = run.seeds[index];
  if (seed === undefined) throw new Error('Fixture has no planned output at this index.');
  return {
    id: toImageGenerationAssetId({ raw: id }),
    sessionId: run.sessionId,
    runId: run.id,
    index,
    createdAt: 10 + index,
    seed,
    result: { binaryObjectId: toBinaryObjectId({ raw: `binary-${id}` }), width: 256, height: 256, modelVersion: 'test-model', uniformOutput: false, elapsedMs: 50 },
    previews: [{ binaryObjectId: toBinaryObjectId({ raw: `preview-${id}` }), width: 128, height: 128, step: 2, steps: 9, mode: 'projection' }],
  };
}


export function generationDraftFixture({ sessionId }: { sessionId: ImageGenerationSessionId }): import('@/01-models/image-generation').ImageGenerationSessionDraft {
  const run = generationRunFixture({ id: 'draft-run-aa', sessionId, count: 2, seed: '42' });
  return {
    sessionId,
    revision: 0,
    updatedAt: 3,
    request: { ...run.request, parameters: { ...run.request.parameters, prompt: '', seed: '' } },
    inferenceLocation: undefined,
    seedMode: 'random',
    layout: 'components',
    modelSelection: undefined,
    remoteModelEditor: undefined,
    loraStates: [{ enabled: false, strength: 0.75 }],
    count: 2,
    debug: 'off',
    retainModel: true,
    keepPreviews: true,
    maxPreviews: 8,
    maxResults: 12,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
