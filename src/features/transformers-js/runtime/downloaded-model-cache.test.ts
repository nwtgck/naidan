import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDownloadedModelReadOnlyCache } from './downloaded-model-cache';
import { getProductionTransformersArtifact, importProductionTransformersArtifact } from './fixtures/production-transformers-artifact';

type FileNode = { bytes: string };
interface DirectoryNode {
  [name: string]: DirectoryNode | FileNode;
}

function isFileNode(node: DirectoryNode | FileNode): node is FileNode {
  return 'bytes' in node && typeof node.bytes === 'string';
}

function opfsDirectory({ node }: { node: DirectoryNode }): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name: '',
    getDirectoryHandle: vi.fn(async (name: string) => {
      const child = node[name];
      if (child === undefined || isFileNode(child)) throw new DOMException('Missing', 'NotFoundError');
      return opfsDirectory({ node: child });
    }),
    getFileHandle: vi.fn(async (name: string) => {
      const child = node[name];
      if (child === undefined || !isFileNode(child)) throw new DOMException('Missing', 'NotFoundError');
      const encoded = new TextEncoder().encode(child.bytes);
      return {
        kind: 'file',
        name,
        getFile: vi.fn(async () => ({
          size: encoded.byteLength,
          stream: () => new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoded);
              controller.close();
            },
          }),
        })),
      } as unknown as FileSystemFileHandle;
    }),
  } as unknown as FileSystemDirectoryHandle;
}

function file({ bytes }: { bytes: string }): FileNode {
  return { bytes };
}

function cacheTree({ revision }: { revision: string }): DirectoryNode {
  return {
    models: {
      'huggingface.co': {
        LiquidAI: {
          'LFM2.5-230M-ONNX': {
            resolve: {
              [revision]: {
                'tokenizer_config.json': file({ bytes: '{"tokenizer_class":"TokenizersBackend"}' }),
                '.tokenizer_config.json.complete': file({ bytes: '' }),
                'preprocessor_config.json': file({ bytes: '{}' }),
                '.preprocessor_config.json.complete': file({ bytes: '' }),
                'config.json': file({ bytes: '{}' }),
                '.config.json.complete': file({ bytes: '' }),
              },
            },
          },
        },
      },
    },
  };
}

describe('createDownloadedModelReadOnlyCache', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects HF local probes, other repositories, and other revisions before touching OPFS', async () => {
    const getDirectory = vi.fn();
    vi.stubGlobal('navigator', { storage: { getDirectory } });
    const onMatchObservation = vi.fn();
    const cache = createDownloadedModelReadOnlyCache({
      modelId: 'LiquidAI/LFM2.5-230M-ONNX', revision: 'exact', onMatchObservation,
    });
    const deniedUrls = [
      '/models/LiquidAI/LFM2.5-230M-ONNX/tokenizer_config.json',
      'http://localhost/models/LiquidAI/LFM2.5-230M-ONNX/tokenizer_config.json',
      'https://huggingface.co/other/model/resolve/exact/config.json',
      'https://huggingface.co/LiquidAI/LFM2.5-230M-ONNX/resolve/other/config.json',
      'https://huggingface.co/LiquidAI/LFM2.5-230M-ONNX/resolve/main/config.json',
      'https://huggingface.co/LiquidAI/LFM2.5-230M-ONNX/resolve/exact-suffix/config.json',
    ];
    for (const url of deniedUrls) await expect(cache.match(url)).resolves.toBeUndefined();
    expect(getDirectory).not.toHaveBeenCalled();
    expect(onMatchObservation).toHaveBeenCalledTimes(deniedUrls.length);
    expect(onMatchObservation.mock.calls.every(([call]) => call.observation.result === 'miss')).toBe(true);
  });

  it('preserves an explicitly selected user model while excluding another local model', async () => {
    const root = opfsDirectory({ node: { models: { user: { uploaded: {
      'config.json': file({ bytes: '{"source":"uploaded-user"}' }),
      '.config.json.complete': file({ bytes: '' }),
    } } } } });
    vi.stubGlobal('self', { location: new URL('https://app.example.test/assets/worker.js') });
    vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn().mockResolvedValue(root) } });
    const cache = createDownloadedModelReadOnlyCache({ modelId: 'user/uploaded', revision: undefined });
    const response = await cache.match('https://app.example.test/user/uploaded/config.json');
    expect(await response?.json()).toEqual({ source: 'uploaded-user' });
    const probe = await cache.match('/models/user/uploaded/config.json');
    expect(await probe?.json()).toEqual({ source: 'uploaded-user' });
    await expect(cache.match('/models/user/another/config.json')).resolves.toBeUndefined();
    await expect(cache.put('/models/user/uploaded/config.json', new Response('{}'))).rejects.toThrow('Read-only OPFS');
  });

  it('preserves an explicitly selected local model through its existing OPFS user mapping', async () => {
    const root = opfsDirectory({ node: { models: { user: { uploaded: {
      'config.json': file({ bytes: '{"source":"uploaded-local"}' }),
      '.config.json.complete': file({ bytes: '' }),
    } } } } });
    vi.stubGlobal('self', { location: new URL('https://app.example.test/assets/worker.js') });
    vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn().mockResolvedValue(root) } });
    const cache = createDownloadedModelReadOnlyCache({ modelId: 'local/uploaded', revision: undefined });
    const response = await cache.match('https://app.example.test/local/uploaded/config.json');
    expect(await response?.json()).toEqual({ source: 'uploaded-local' });
    const probe = await cache.match('/models/local/uploaded/config.json');
    expect(await probe?.json()).toEqual({ source: 'uploaded-local' });
    await expect(cache.match('https://huggingface.co/owner/model/resolve/main/config.json')).resolves.toBeUndefined();
  });

  it('keeps concurrent alias, exact, and denied observations bound to their original request', async () => {
    const revision = 'c6f46e4e3f885ebcad164d14059a49f90e27eb4d';
    const root = opfsDirectory({ node: cacheTree({ revision }) });
    const pendingAliasRoot = Promise.withResolvers<FileSystemDirectoryHandle>();
    const getDirectory = vi.fn().mockImplementationOnce(() => pendingAliasRoot.promise).mockResolvedValue(root);
    vi.stubGlobal('navigator', { storage: { getDirectory } });
    const onMatchObservation = vi.fn();
    const cache = createDownloadedModelReadOnlyCache({ modelId: 'LiquidAI/LFM2.5-230M-ONNX', revision, onMatchObservation });
    const aliasPath = 'huggingface.co/LiquidAI/LFM2.5-230M-ONNX/resolve/main/tokenizer_config.json';
    const exactPath = `huggingface.co/LiquidAI/LFM2.5-230M-ONNX/resolve/${revision}/config.json`;
    const localPath = '/models/LiquidAI/LFM2.5-230M-ONNX/config.json';
    const aliased = cache.match(`https://${aliasPath}`);
    const exact = cache.match(`https://${exactPath}`);
    await expect(cache.match(localPath)).resolves.toBeUndefined();
    expect(await (await exact)?.json()).toEqual({});
    pendingAliasRoot.resolve(root);
    expect(await (await aliased)?.json()).toEqual({ tokenizer_class: 'TokenizersBackend' });
    expect(onMatchObservation.mock.calls.map(([call]) => call.observation)).toEqual([
      { requestedPath: localPath, result: 'miss', bytes: undefined },
      { requestedPath: exactPath, result: 'hit', bytes: 2 },
      { requestedPath: aliasPath, result: 'alias-hit', bytes: 39 },
    ]);
  });

  it('preserves the original OPFS failure when canonical exact metadata cannot be read', async () => {
    const failure = new DOMException('Permission denied', 'NotAllowedError');
    vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn().mockRejectedValue(failure) } });
    const cache = createDownloadedModelReadOnlyCache({ modelId: 'LiquidAI/LFM2.5-230M-ONNX', revision: 'exact' });
    await expect(cache.match('https://huggingface.co/LiquidAI/LFM2.5-230M-ONNX/resolve/main/tokenizer_config.json')).rejects.toBe(failure);
  });

  it('canonicalizes known revisionless metadata to the selected exact revision even when stale main metadata exists', async () => {
    const revision = 'c6f46e4e3f885ebcad164d14059a49f90e27eb4d';
    const tree: DirectoryNode = {
      models: {
        'huggingface.co': {
          LiquidAI: {
            'LFM2.5-230M-ONNX': {
              resolve: {
                [revision]: {
                  'tokenizer_config.json': file({ bytes: '{"source":"selected-exact"}' }),
                  '.tokenizer_config.json.complete': file({ bytes: '' }),
                },
                main: {
                  'tokenizer_config.json': file({ bytes: '{"source":"stale-main"}' }),
                  '.tokenizer_config.json.complete': file({ bytes: '' }),
                },
              },
            },
          },
        },
      },
    };
    vi.stubGlobal('navigator', {
      userAgent: 'Vitest',
      vendor: '',
      storage: { getDirectory: vi.fn().mockResolvedValue(opfsDirectory({ node: tree })) },
    });
    const cache = createDownloadedModelReadOnlyCache({ modelId: 'LiquidAI/LFM2.5-230M-ONNX', revision });
    const tokenizer = await cache.match('https://huggingface.co/LiquidAI/LFM2.5-230M-ONNX/resolve/main/tokenizer_config.json');
    expect(tokenizer).toBeDefined();
    expect(await tokenizer!.json()).toEqual({ source: 'selected-exact' });
    expect(tokenizer!.headers.get('X-Cache-Revision-Alias')).toContain(`/resolve/${revision}/tokenizer_config.json`);
  });

  it('serves Transformers.js revisionless tokenizer and processor metadata probes from the exact cached revision', async () => {
    const revision = 'c6f46e4e3f885ebcad164d14059a49f90e27eb4d';
    vi.stubGlobal('navigator', {
      userAgent: 'Vitest',
      vendor: '',
      storage: { getDirectory: vi.fn().mockResolvedValue(opfsDirectory({ node: cacheTree({ revision }) })) },
    });
    const cache = createDownloadedModelReadOnlyCache({
      modelId: 'LiquidAI/LFM2.5-230M-ONNX',
      revision,
    });

    const tokenizer = await cache.match('https://huggingface.co/LiquidAI/LFM2.5-230M-ONNX/resolve/main/tokenizer_config.json');
    const processor = await cache.match('https://huggingface.co/LiquidAI/LFM2.5-230M-ONNX/resolve/main/preprocessor_config.json');

    expect(tokenizer).toBeDefined();
    expect(processor).toBeDefined();
    expect(await tokenizer!.json()).toMatchObject({ tokenizer_class: 'TokenizersBackend' });
    expect(await processor!.json()).toEqual({});
    expect(tokenizer!.headers.get('X-Cache-Revision-Alias')).toContain(`/resolve/${revision}/tokenizer_config.json`);
    expect(processor!.headers.get('X-Cache-Revision-Alias')).toContain(`/resolve/${revision}/preprocessor_config.json`);
  });

  it('satisfies the actual Transformers.js 4.2 revisionless tokenizer and processor registry probes from an immutable cache revision', async () => {
    const artifact = await getProductionTransformersArtifact();
    const revision = 'c6f46e4e3f885ebcad164d14059a49f90e27eb4d';
    vi.stubGlobal('navigator', {
      userAgent: 'Vitest',
      vendor: '',
      storage: { getDirectory: vi.fn().mockResolvedValue(opfsDirectory({ node: cacheTree({ revision }) })) },
    });
    const moduleUrl = new URL(artifact.moduleUrl);
    moduleUrl.searchParams.set('read-only-registry', crypto.randomUUID());
    const transformers = await importProductionTransformersArtifact({ moduleUrl: moduleUrl.href }) as {
      ModelRegistry: {
        get_tokenizer_files: (modelId: string) => Promise<string[]>;
        get_processor_files: (modelId: string) => Promise<string[]>;
      };
      env: {
        allowLocalModels: boolean;
        allowRemoteModels: boolean;
        useCustomCache: boolean;
        customCache: unknown;
      };
    };
    const previous = {
      allowLocalModels: transformers.env.allowLocalModels,
      allowRemoteModels: transformers.env.allowRemoteModels,
      useCustomCache: transformers.env.useCustomCache,
      customCache: transformers.env.customCache,
    };
    try {
      transformers.env.allowLocalModels = true;
      transformers.env.allowRemoteModels = false;
      transformers.env.useCustomCache = true;
      transformers.env.customCache = createDownloadedModelReadOnlyCache({
        modelId: 'LiquidAI/LFM2.5-230M-ONNX',
        revision,
      });

      await expect(transformers.ModelRegistry.get_tokenizer_files(
        'LiquidAI/LFM2.5-230M-ONNX',
      )).resolves.toEqual(['tokenizer.json', 'tokenizer_config.json']);
      await expect(transformers.ModelRegistry.get_processor_files(
        'LiquidAI/LFM2.5-230M-ONNX',
      )).resolves.toEqual(['preprocessor_config.json']);
    } finally {
      transformers.env.allowLocalModels = previous.allowLocalModels;
      transformers.env.allowRemoteModels = previous.allowRemoteModels;
      transformers.env.useCustomCache = previous.useCustomCache;
      transformers.env.customCache = previous.customCache;
    }
  });

  it('does not alias unrelated main-revision files to the immutable cache', async () => {
    const revision = 'c6f46e4e3f885ebcad164d14059a49f90e27eb4d';
    vi.stubGlobal('navigator', {
      userAgent: 'Vitest',
      vendor: '',
      storage: { getDirectory: vi.fn().mockResolvedValue(opfsDirectory({ node: cacheTree({ revision }) })) },
    });
    const cache = createDownloadedModelReadOnlyCache({
      modelId: 'LiquidAI/LFM2.5-230M-ONNX',
      revision,
    });

    await expect(cache.match('https://huggingface.co/LiquidAI/LFM2.5-230M-ONNX/resolve/main/config.json')).resolves.toBeUndefined();
  });
});
