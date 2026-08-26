import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpfsModelCache, TEST_ONLY } from './opfs-model-cache';

vi.mock('@/features/transformers-js/utils', () => ({
  urlToPath: vi.fn(({ url }: { url: string }) => {
    const parsed = new URL(url);
    return parsed.hostname === 'huggingface.co' ? `models/${parsed.hostname}${parsed.pathname}` : null;
  }),
  writeToOpfs: vi.fn().mockResolvedValue(undefined),
}));


function fileHandle({ bytes }: { bytes: string }) {
  const encoded = new TextEncoder().encode(bytes);
  return {
    getFile: vi.fn().mockResolvedValue({
      size: encoded.byteLength,
      stream: () => new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded);
          controller.close();
        },
      }),
    }),
  };
}

function directoryHandle({ directories = {}, files = {} }: {
  directories?: Record<string, ReturnType<typeof directoryHandle>>,
  files?: Record<string, ReturnType<typeof fileHandle>>,
} = {}) {
  return {
    getDirectoryHandle: vi.fn(async (name: string) => {
      const directory = directories[name];
      if (directory === undefined) throw new DOMException('missing directory', 'NotFoundError');
      return directory;
    }),
    getFileHandle: vi.fn(async (name: string) => {
      const file = files[name];
      if (file === undefined) throw new DOMException('missing file', 'NotFoundError');
      return file;
    }),
    removeEntry: vi.fn(),
  };
}

function opfsRoot({ resolvedRevision, exactBytes, mainBytes }: {
  resolvedRevision: string,
  exactBytes?: string,
  mainBytes?: string,
}) {
  const revisionDirectory = ({ bytes }: { bytes?: string }) => directoryHandle({
    directories: {
      onnx: directoryHandle({
        files: bytes === undefined ? {} : {
          'model_q4.onnx': fileHandle({ bytes }),
          '.model_q4.onnx.complete': fileHandle({ bytes: 'marker' }),
        },
      }),
    },
  });
  return directoryHandle({ directories: {
    models: directoryHandle({ directories: {
      'huggingface.co': directoryHandle({ directories: {
        org: directoryHandle({ directories: {
          repo: directoryHandle({ directories: {
            resolve: directoryHandle({ directories: {
              [resolvedRevision]: revisionDirectory({ bytes: exactBytes }),
              main: revisionDirectory({ bytes: mainBytes }),
            } }),
          } }),
        } }),
      } }),
    } }),
  } });
}

describe('createOpfsModelCache production compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('treats unexpected OPFS lookup failures as cache misses like the base worker', async () => {
    const securityError = new Error('OPFS unavailable');
    securityError.name = 'SecurityError';
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockRejectedValue(securityError) },
    });

    const cache = createOpfsModelCache();
    await expect(cache.match('https://huggingface.co/org/repo/resolve/main/config.json')).resolves.toBeUndefined();
  });
  it('prefers an exact resolved-revision cache hit over an approved main alias', async () => {
    const resolvedRevision = 'a'.repeat(40);
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockResolvedValue(opfsRoot({
        resolvedRevision,
        exactBytes: 'exact',
        mainBytes: 'main',
      })) },
    });
    const cache = createOpfsModelCache({ revisionAliases: [{
      modelId: 'org/repo',
      resolvedRevision,
      sourceRevision: 'main',
      repositoryPaths: ['onnx/model_q4.onnx'],
    }] });

    const response = await cache.match(`https://huggingface.co/org/repo/resolve/${resolvedRevision}/onnx/model_q4.onnx`);
    expect(await response?.text()).toBe('exact');
    expect(response?.headers.get('X-Cache-Revision-Alias')).toBeNull();
  });

  it('uses an approved main alias only when the exact resolved-revision file is absent', async () => {
    const resolvedRevision = 'b'.repeat(40);
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockResolvedValue(opfsRoot({
        resolvedRevision,
        mainBytes: 'main',
      })) },
    });
    const cache = createOpfsModelCache({ revisionAliases: [{
      modelId: 'org/repo',
      resolvedRevision,
      sourceRevision: 'main',
      repositoryPaths: ['onnx/model_q4.onnx'],
    }] });

    const response = await cache.match(`https://huggingface.co/org/repo/resolve/${resolvedRevision}/onnx/model_q4.onnx`);
    expect(await response?.text()).toBe('main');
    expect(response?.headers.get('X-Cache-Revision-Alias')).toContain('/resolve/main/onnx/model_q4.onnx');
  });

  it('does not alias a repository path that was not explicitly approved', async () => {
    const resolvedRevision = 'c'.repeat(40);
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockResolvedValue(opfsRoot({
        resolvedRevision,
        mainBytes: 'main',
      })) },
    });
    const cache = createOpfsModelCache({ revisionAliases: [{
      modelId: 'org/repo',
      resolvedRevision,
      sourceRevision: 'main',
      repositoryPaths: ['config.json'],
    }] });

    await expect(cache.match(`https://huggingface.co/org/repo/resolve/${resolvedRevision}/onnx/model_q4.onnx`)).resolves.toBeUndefined();
  });

  it('rewrites only explicitly sample-matched resolved-revision requests to the source cache revision', () => {
    const resolvedRevision = 'a'.repeat(40);
    const aliases = [{
      modelId: 'org/repo',
      resolvedRevision,
      sourceRevision: 'main',
      repositoryPaths: ['onnx/model_q4.onnx'],
    }];

    expect(TEST_ONLY.revisionAliasUrl({
      urlString: `https://huggingface.co/org/repo/resolve/${resolvedRevision}/onnx/model_q4.onnx`,
      revisionAliases: aliases,
    })).toBe('https://huggingface.co/org/repo/resolve/main/onnx/model_q4.onnx');
    expect(TEST_ONLY.revisionAliasUrl({
      urlString: `https://huggingface.co/org/repo/resolve/${resolvedRevision}/config.json`,
      revisionAliases: aliases,
    })).toBeUndefined();
  });

});
