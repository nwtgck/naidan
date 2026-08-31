import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpfsModelCache, TEST_ONLY } from './opfs-model-cache';
import { writeToOpfs } from '@/features/transformers-js/utils';

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

  it('reports one sanitized match observation for exact hits, alias hits, and misses', async () => {
    const resolvedRevision = 'd'.repeat(40);
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockResolvedValue(opfsRoot({
        resolvedRevision,
        exactBytes: 'exact',
        mainBytes: 'main',
      })) },
    });
    const observations: Array<{ requestedPath: string, result: string, bytes: number | undefined }> = [];
    const cache = createOpfsModelCache({
      revisionAliases: [{
        modelId: 'org/repo',
        resolvedRevision: 'e'.repeat(40),
        sourceRevision: 'main',
        repositoryPaths: ['onnx/model_q4.onnx'],
      }],
      onMatchObservation: ({ observation }) => observations.push(observation),
    });

    await cache.match(`https://huggingface.co/org/repo/resolve/${resolvedRevision}/onnx/model_q4.onnx?token=secret#fragment`);
    await cache.match(`https://huggingface.co/org/repo/resolve/${'e'.repeat(40)}/onnx/model_q4.onnx`);
    await cache.match('https://huggingface.co/org/repo/resolve/main/missing.onnx?token=secret');

    expect(observations).toEqual([
      {
        requestedPath: `huggingface.co/org/repo/resolve/${resolvedRevision}/onnx/model_q4.onnx`,
        result: 'hit',
        bytes: 5,
      },
      {
        requestedPath: `huggingface.co/org/repo/resolve/${'e'.repeat(40)}/onnx/model_q4.onnx`,
        result: 'alias-hit',
        bytes: 4,
      },
      {
        requestedPath: 'huggingface.co/org/repo/resolve/main/missing.onnx',
        result: 'miss',
        bytes: undefined,
      },
    ]);
  });

  it('does not repair or delete an incomplete zero-byte artifact in read-only mode', async () => {
    const onnxDirectory = directoryHandle({
      files: {
        'model_q4.onnx': fileHandle({ bytes: '' }),
        '.model_q4.onnx.complete': fileHandle({ bytes: 'marker' }),
      },
    });
    const root = directoryHandle({ directories: {
      models: directoryHandle({ directories: {
        'huggingface.co': directoryHandle({ directories: {
          org: directoryHandle({ directories: {
            repo: directoryHandle({ directories: {
              resolve: directoryHandle({ directories: {
                main: directoryHandle({ directories: { onnx: onnxDirectory } }),
              } }),
            } }),
          } }),
        } }),
      } }),
    } });
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockResolvedValue(root) },
    });

    const cache = createOpfsModelCache({ mutationPolicy: 'read-only' });
    await expect(cache.match('https://huggingface.co/org/repo/resolve/main/onnx/model_q4.onnx'))
      .resolves
      .toBeUndefined();
    expect(onnxDirectory.removeEntry).not.toHaveBeenCalled();
  });

  it('leaves an incomplete GPT-OSS split artifact untouched and reports a cache miss in read-only mode', async () => {
    const onnxDirectory = directoryHandle({
      files: {
        // Mirrors the split-file shape observed during GPT-OSS investigation;
        // the test uses tiny bytes because completion-marker semantics are size-independent.
        'model_q4f16.onnx_data_4': fileHandle({ bytes: 'partial' }),
      },
    });
    const root = directoryHandle({ directories: {
      models: directoryHandle({ directories: {
        'huggingface.co': directoryHandle({ directories: {
          openai: directoryHandle({ directories: {
            'gpt-oss-20b': directoryHandle({ directories: {
              resolve: directoryHandle({ directories: {
                main: directoryHandle({ directories: { onnx: onnxDirectory } }),
              } }),
            } }),
          } }),
        } }),
      } }),
    } });
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockResolvedValue(root) },
    });

    const cache = createOpfsModelCache({ mutationPolicy: 'read-only' });
    await expect(cache.match(
      'https://huggingface.co/openai/gpt-oss-20b/resolve/main/onnx/model_q4f16.onnx_data_4',
    )).resolves.toBeUndefined();
    expect(onnxDirectory.removeEntry).not.toHaveBeenCalled();
  });

  it('writes model responses in explicit read-write mode', async () => {
    const cache = createOpfsModelCache({ mutationPolicy: 'read-write' });
    const response = new Response('model bytes', {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });

    await cache.put('https://huggingface.co/org/repo/resolve/main/onnx/model_q4.onnx', response);

    expect(writeToOpfs).toHaveBeenCalledWith({
      path: 'models/huggingface.co/org/repo/resolve/main/onnx/model_q4.onnx',
      response,
    });
  });

  it('propagates OPFS write failures in explicit read-write mode', async () => {
    vi.mocked(writeToOpfs).mockRejectedValueOnce(new Error('QuotaExceededError'));
    const cache = createOpfsModelCache({ mutationPolicy: 'read-write' });

    await expect(cache.put(
      'https://huggingface.co/org/repo/resolve/main/onnx/model_q4.onnx',
      new Response('model bytes', { status: 200 }),
    )).rejects.toThrow('QuotaExceededError');
  });

  it('rejects HTML responses before writing in explicit read-write mode', async () => {
    const cache = createOpfsModelCache({ mutationPolicy: 'read-write' });

    await expect(cache.put(
      'https://huggingface.co/org/repo/resolve/main/onnx/model_q4.onnx',
      new Response('<html>not a model</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    )).rejects.toThrow('Detected HTML response');
    expect(writeToOpfs).not.toHaveBeenCalled();
  });

  it('rejects writes in read-only mode instead of silently caching a remote response', async () => {
    const cache = createOpfsModelCache({ mutationPolicy: 'read-only' });

    await expect(cache.put(
      'https://huggingface.co/org/repo/resolve/main/onnx/model_q4.onnx',
      new Response('remote bytes'),
    )).rejects.toThrow('Read-only OPFS model cache MUST NOT be written during model loading');
  });

});
