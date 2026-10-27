// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTemporaryModelFiles } from '@/logic/temporary-model-files';
import { idToRaw } from '@/01-models/ids';
import { promiseAllKeyed } from '@/utils/promise';
import { TEST_ONLY, type LocalRepositorySource } from './local-repository-store';
import { localRepositoryInputs } from './local-repository-layout';
import { resolvedModelSchema } from './resolved-model-schema';
import type { ModelDirectoryInput } from '@/features/llama-cpp-browser/types';

function fixtureFile({ name, marker }: { name: string, marker: number }): File {
  const bytes = new Uint8Array(32);
  bytes.set([71, 71, 85, 70, 3, 0, 0, 0]);
  bytes[24] = marker;
  return new File([bytes], name, { lastModified: 123 });
}

function directory({ rootName, paths }: { rootName: string, paths: string[] }): ModelDirectoryInput {
  return { rootName, files: paths.map((relativePath, index) => ({ relativePath, file: fixtureFile({ name: relativePath.split('/').at(-1)!, marker: index }) })) };
}

function harness() {
  const held = new Set<string>();
  const request = vi.fn(async (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => {
    await Promise.resolve();
    if (options.signal || options.steal || !options.ifAvailable) {
      throw new Error('Unexpected name reservation options');
    }
    if (held.has(name)) {
      return callback(null);
    }
    held.add(name);
    try {
      return await callback({ name, mode: 'exclusive' });
    } finally {
      held.delete(name);
    }
  });
  vi.stubGlobal('navigator', { locks: { request } });
  const sources: { store: ReturnType<typeof TEST_ONLY.createLocalRepositoryStore>, source: LocalRepositorySource }[] = [];
  function context() {
    const registry = createTemporaryModelFiles();
    const store = TEST_ONLY.createLocalRepositoryStore({ registry });
    return {
      registry,
      store,
      register: async ({ input }: { input: ModelDirectoryInput }) => {
        const source = await store.register({ directory: input, signal: undefined });
        sources.push({ store, source });
        return source;
      },
    };
  }
  return {
    context,
    held,
    request,
    async [Symbol.asyncDispose]() {
      for (const { store, source } of sources) {
        await store.retire({ source });
      }
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('local repository File identity', () => {
  it('publishes File references without copying bytes or exposing the internal ID', async () => {
    await using resources = harness();
    const { store, register } = resources.context();
    const input = directory({ rootName: 'Repo', paths: ['Repo-Q4_K_M.gguf', 'Repo-Q8_0.gguf', 'mmproj.gguf'] });
    const file = input.files[0]!.file;
    const buffer = vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('Whole-file buffering is forbidden'));
    const stream = vi.spyOn(file, 'stream').mockImplementation(() => {
      throw new Error('Copying is forbidden');
    });
    const source = await register({ input });
    expect(store.list().map(model => model.modelId)).toEqual(['~user/Repo/Repo-Q4_K_M', '~user/Repo/Repo-Q8_0']);
    expect(store.list().every(model => !model.modelId.includes(idToRaw({ id: source.sourceId })))).toBe(true);
    const resolved = await store.resolve({ modelId: store.list()[0]!.modelId, signal: undefined });
    expect(resolved?.directory.primaryFile.file).toBe(file);
    expect(resolvedModelSchema.safeParse(resolved).success).toBe(true);
    expect(buffer).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it('reserves readable names across independent page registries and keeps selectors stable', async () => {
    await using resources = harness();
    const first = resources.context(), second = resources.context();
    const input = directory({ rootName: 'Repo', paths: ['Repo-Q4.gguf', 'Repo-Q8.gguf'] });
    const { a, b } = await promiseAllKeyed({ a: first.register({ input }), b: second.register({ input }) });
    expect([a.rootName, b.rootName].sort()).toEqual(['Repo', 'Repo-2']);
    expect(a.sourceId).not.toBe(b.sourceId);
    expect(a.configurations.map(configuration => configuration.selector)).toEqual(b.configurations.map(configuration => configuration.selector));
    expect(resources.held.size).toBe(2);
    expect(first.store.list()).toHaveLength(2);
    expect(second.store.list()).toHaveLength(2);
  });

  it('resolves the captured Files when an image folder occupies a different registry namespace name', async () => {
    await using resources = harness();
    const { store, registry, register } = resources.context();
    const image = registry.register({ directory: { rootName: 'Repo', files: [{ relativePath: 'image.safetensors', file: new File(['image'], 'image.safetensors') }] }, signal: undefined });
    const input = directory({ rootName: 'Repo', paths: ['model.gguf'] });
    const source = await register({ input });
    expect(image.rootPath).toBe('temp/Repo');
    expect(source.root.rootPath).toBe('temp/Repo-2');
    expect(source.rootName).toBe('Repo');
    expect(store.list().map(model => model.modelId)).toEqual(['~user/Repo/model']);
    const resolved = await store.resolve({ modelId: '~user/Repo/model', signal: undefined });
    expect(resolved?.directory.primaryFile.file).toBe(input.files[0]!.file);
    expect(resolvedModelSchema.safeParse(resolved).success).toBe(true);
    expect(await store.resolve({ modelId: '~user/Repo-2/model', signal: undefined })).toBeUndefined();
  });

  it('removes only the selected temporary projection while retaining sibling Files and the explicit folder lifetime', async () => {
    await using resources = harness();
    const { store, registry, register } = resources.context();
    const source = await register({ input: directory({ rootName: 'Repo', paths: ['Model-Q4.gguf', 'Model-Q8.gguf', 'mmproj.gguf'] }) });
    store.removeModel({ modelId: '~user/Repo/Model-Q4' });
    expect(store.list().map(model => model.modelId)).toEqual(['~user/Repo/Model-Q8']);
    expect(await store.resolve({ modelId: '~user/Repo/Model-Q4', signal: undefined })).toBeUndefined();
    const sibling = await store.resolve({ modelId: '~user/Repo/Model-Q8', signal: undefined });
    expect(sibling?.directory.projectorFile?.file).toBe(source.root.files[2]!.file);
    expect(registry.get({ rootPath: source.root.rootPath })).toBe(source.root);
  });

  it('does not reuse a retired name until the accepted operation has finished its writes', async () => {
    await using resources = harness();
    const first = resources.context(), second = resources.context();
    const input = directory({ rootName: 'Repo', paths: ['model.gguf'] });
    const source = await first.register({ input });
    const original = await first.store.resolve({ modelId: '~user/Repo/model', signal: undefined });
    let retired: Promise<void>;
    {
      const pin = first.store.pin({ source });
      using _operation = { [Symbol.dispose]: () => pin.release() };
      retired = first.store.retire({ source });
      const other = await second.register({ input });
      expect(other.rootName).toBe('Repo-2');
      expect(first.store.isCurrent({ source })).toBe(false);
      expect(resources.held.has('naidan-llama-cpp-local-repository:Repo')).toBe(true);
    }
    await retired;
    const replacement = await second.register({ input: directory({ rootName: 'Repo', paths: ['model.gguf'] }) });
    expect(replacement.rootName).toBe('Repo');
    const next = await second.store.resolve({ modelId: '~user/Repo/model', signal: undefined });
    expect(next?.directory.primaryFile.file).not.toBe(original?.directory.primaryFile.file);
    expect(next?.location).not.toEqual(original?.location);
    expect(original?.directory.primaryFile.file).toBe(input.files[0]!.file);
  });

  it('keeps companion files inside the explicitly selected repository boundary', async () => {
    await using resources = harness();
    const { store, register } = resources.context();
    const input = directory({ rootName: 'Models', paths: ['Vision/model.gguf', 'Vision/mmproj.gguf', 'Text/model.gguf', 'CompanionOnly/mmproj.gguf'] });
    const repositories = localRepositoryInputs({ directory: input, layout: 'repositories' });
    expect(repositories.map(repository => repository.rootName)).toEqual(['Vision', 'Text']);
    for (const input of repositories) {
      await register({ input });
    }
    const vision = await store.resolve({ modelId: '~user/Vision/model', signal: undefined });
    const text = await store.resolve({ modelId: '~user/Text/model', signal: undefined });
    expect(vision?.directory.projectorFile?.relativePath).toBe('mmproj.gguf');
    expect(text?.directory.projectorFile).toBeUndefined();
    expect(text?.directory.files.map(file => file.relativePath)).toEqual(['model.gguf']);
  });

  it('does not bypass cross-tab reservation when Web Locks are unavailable', async () => {
    await using resources = harness();
    const { store, registry } = resources.context();
    vi.stubGlobal('navigator', {});
    await expect(store.register({ directory: directory({ rootName: 'Repo', paths: ['model.gguf'] }), signal: undefined })).rejects.toThrow('unavailable');
    expect(store.list()).toEqual([]);
    expect(registry.list()).toEqual([]);
  });
});
