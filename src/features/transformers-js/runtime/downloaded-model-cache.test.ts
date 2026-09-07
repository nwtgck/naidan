import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDownloadedModelReadOnlyCache } from './downloaded-model-cache';

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
    const revision = 'c6f46e4e3f885ebcad164d14059a49f90e27eb4d';
    vi.stubGlobal('navigator', {
      userAgent: 'Vitest',
      vendor: '',
      storage: { getDirectory: vi.fn().mockResolvedValue(opfsDirectory({ node: cacheTree({ revision }) })) },
    });
    const moduleUrl = pathToFileURL(resolve(
      process.cwd(),
      'node_modules/@huggingface/transformers/dist/transformers.web.js',
    )).href;
    const transformers = await import(/* @vite-ignore */ moduleUrl) as unknown as {
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
