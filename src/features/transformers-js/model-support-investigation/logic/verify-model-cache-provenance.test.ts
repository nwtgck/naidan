import { describe, expect, it, vi } from 'vitest';
import type {
  ModelSupportInvestigationCacheInventory,
  ModelSupportInvestigationRepository,
} from '@/features/transformers-js/model-support-investigation/types';
import {
  MODEL_CACHE_PROVENANCE_MAXIMUM_FILE_COUNT,
  TEST_ONLY,
  verifyModelCacheProvenance,
} from './verify-model-cache-provenance';

type FakeHandle = FakeDirectory | FakeFile;
interface FakeDirectory {
  kind: 'directory',
  children: Record<string, FakeHandle>,
}
interface FakeFile {
  kind: 'file',
  bytes: Uint8Array,
}

function directory({ children }: { children: Record<string, FakeHandle> }): FakeDirectory {
  return { kind: 'directory', children };
}

function file({ bytes }: { bytes: Uint8Array }): FakeFile {
  return { kind: 'file', bytes };
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
    async getFileHandle(name: string) {
      const child = value.children[name];
      if (child?.kind !== 'file') throw new DOMException('Not found', 'NotFoundError');
      return {
        kind: 'file',
        name,
        getFile: async () => {
          const bytes = new Uint8Array(child.bytes.byteLength);
          bytes.set(child.bytes);
          return new File([bytes.buffer], name);
        },
      } as FileSystemFileHandle;
    },
  } as FileSystemDirectoryHandle;
}

function storageRoot({ revision, repositoryPath, bytes }: {
  revision: string,
  repositoryPath: string,
  bytes: Uint8Array,
}): FileSystemDirectoryHandle {
  const pathParts = repositoryPath.split('/');
  const fileName = pathParts.pop();
  if (fileName === undefined) throw new Error('repositoryPath must name a file');
  let current: FakeHandle = file({ bytes });
  current = directory({ children: { [fileName]: current } });
  for (const part of pathParts.reverse()) current = directory({ children: { [part]: current } });
  return toDirectoryHandle({ value: directory({ children: {
    models: directory({ children: {
      'huggingface.co': directory({ children: {
        org: directory({ children: {
          model: directory({ children: {
            resolve: directory({ children: { [revision]: current } }),
          } }),
        } }),
      } }),
    } }),
  } }) });
}

function repository({ revision, repositoryPath, size }: {
  revision: string,
  repositoryPath: string,
  size: number,
}): ModelSupportInvestigationRepository {
  return {
    requestedModelId: 'org/model',
    normalizedModelId: 'org/model',
    requestedRevision: 'main',
    resolvedRevision: revision,
    apiUrl: 'https://huggingface.co/api/models/org/model/revision/main?blobs=true',
    responseUrl: 'https://huggingface.co/api/models/org/model/revision/main?blobs=true',
    fileCount: 1,
    files: [{ path: repositoryPath, size, blobId: undefined, lfsOid: undefined }],
    pipelineTag: 'text-generation',
    libraryName: 'transformers',
    metadata: {},
  };
}

function inventory({ revision, repositoryPath, size }: {
  revision: string,
  repositoryPath: string,
  size: number,
}): ModelSupportInvestigationCacheInventory {
  return {
    normalizedModelId: 'org/model',
    rootPath: 'models/huggingface.co/org/model',
    exists: true,
    revisionProvenance: 'unknown',
    revisionProvenanceReason: 'Completion markers do not independently prove file bytes.',
    totalBytes: size,
    fileCount: 1,
    completionMarkerCount: 1,
    incompleteFileCount: 0,
    orphanCompletionMarkerCount: 0,
    orphanCompletionMarkerPaths: [],
    zeroByteFileCount: 0,
    weightFileCount: 1,
    allFilesHaveCompletionMarkers: true,
    files: [{
      path: `resolve/${revision}/${repositoryPath}`,
      repositoryPath,
      cacheRevision: revision,
      size,
      lastModified: 1,
      hasCompletionMarker: true,
      isWeightFile: true,
    }],
  };
}

function rangedFetch({ bytes }: { bytes: Uint8Array }): typeof fetch {
  return vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Length': String(bytes.byteLength),
          'Content-Type': 'application/octet-stream',
          ETag: '"sample-etag"',
          'Last-Modified': 'Sun, 30 Aug 2026 00:00:00 GMT',
        },
      });
    }
    const range = new Headers(init?.headers).get('Range');
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    if (match === null) throw new Error(`Unexpected range: ${range}`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const body = bytes.slice(start, end + 1);
    return new Response(body, {
      status: 206,
      headers: {
        'Content-Length': String(body.byteLength),
        'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`,
        ETag: '"sample-etag"',
      },
    });
  });
}

const revision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const repositoryPath = 'onnx/model_q4.onnx';

describe('verifyModelCacheProvenance', () => {
  it('matches bounded first, middle, and last samples against the exact resolved revision', async () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 251);
    const repositoryFetch = rangedFetch({ bytes });
    const result = await verifyModelCacheProvenance({
      inventory: inventory({ revision, repositoryPath, size: bytes.byteLength }),
      repository: repository({ revision, repositoryPath, size: bytes.byteLength }),
      storageRoot: storageRoot({ revision, repositoryPath, bytes }),
      repositoryFetch,
      rangeBytes: 32 * 1024,
      maximumFileCount: 3,
    });

    expect(result).toMatchObject({
      status: 'bounded-samples-matched',
      confidence: 'bounded-samples-matched',
      files: [{ status: 'bounded-samples-matched', cacheRevision: revision }],
    });
    expect(result.files[0]?.transport).toMatchObject({
      status: 'observed',
      attempts: [{
        method: 'HEAD',
        status: 'observed',
        responseStatus: 200,
        contentLength: String(bytes.byteLength),
        contentType: 'application/octet-stream',
        acceptRanges: 'bytes',
        etag: '"sample-etag"',
        corsVisibility: 'readable',
      }],
    });
    expect(result.files[0]?.ranges).toHaveLength(3);
    expect(result.files[0]?.ranges.every(sample => sample.localSha256 === sample.remoteSha256)).toBe(true);
    expect(repositoryFetch).toHaveBeenCalledTimes(4);
    expect(repositoryFetch).toHaveBeenCalledWith(
      `https://huggingface.co/org/model/resolve/${revision}/onnx/model_q4.onnx`,
      expect.objectContaining({ credentials: 'omit', cache: 'no-store' }),
    );
  });


  it('falls back from unsupported HEAD to a one-byte Range transport probe without retaining the body', async () => {
    const bytes = Uint8Array.from({ length: 100 }, (_, index) => index);
    let transportBodyCancelled = false;
    const repositoryFetch = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 405 });
      const range = new Headers(init?.headers).get('Range');
      if (range === 'bytes=0-0') {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 1));
          },
          cancel() {
            transportBodyCancelled = true;
          },
        }), {
          status: 206,
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Length': '1',
            'Content-Range': `bytes 0-0/${bytes.byteLength}`,
            'Content-Type': 'application/octet-stream',
            ETag: '"range-etag"',
          },
        });
      }
      const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
      if (match === null) throw new Error(`Unexpected range: ${range}`);
      const start = Number(match[1]);
      const end = Number(match[2]);
      const body = bytes.slice(start, end + 1);
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Length': String(body.byteLength),
          'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`,
        },
      });
    });

    const result = await verifyModelCacheProvenance({
      inventory: inventory({ revision, repositoryPath, size: bytes.byteLength }),
      repository: repository({ revision, repositoryPath, size: bytes.byteLength }),
      storageRoot: storageRoot({ revision, repositoryPath, bytes }),
      repositoryFetch,
      rangeBytes: 32 * 1024,
      maximumFileCount: 3,
    });

    expect(transportBodyCancelled).toBe(true);
    expect(result.files[0]?.transport).toMatchObject({
      status: 'observed',
      attempts: [
        { method: 'HEAD', status: 'unsupported', responseStatus: 405 },
        {
          method: 'range-0-0',
          status: 'observed',
          responseStatus: 206,
          contentLength: '1',
          contentRange: `bytes 0-0/${bytes.byteLength}`,
          acceptRanges: 'bytes',
          etag: '"range-etag"',
        },
      ],
    });
    expect(result).toMatchObject({ status: 'bounded-samples-matched' });
  });

  it('sanitizes query and hash data from transport URLs and keeps the default file cap bounded', () => {
    expect(TEST_ONLY.sanitizedTransportUrl({
      value: 'https://cdn.example/model.onnx?token=secret#fragment',
    })).toBe('https://cdn.example/model.onnx');
    expect(MODEL_CACHE_PROVENANCE_MAXIMUM_FILE_COUNT).toBe(3);
  });

  it('records a bounded mismatch without claiming whole-file provenance', async () => {
    const localBytes = Uint8Array.from({ length: 100 }, (_, index) => index);
    const remoteBytes = localBytes.slice();
    remoteBytes[50] = 255;
    const result = await verifyModelCacheProvenance({
      inventory: inventory({ revision, repositoryPath, size: localBytes.byteLength }),
      repository: repository({ revision, repositoryPath, size: remoteBytes.byteLength }),
      storageRoot: storageRoot({ revision, repositoryPath, bytes: localBytes }),
      repositoryFetch: rangedFetch({ bytes: remoteBytes }),
      rangeBytes: 32 * 1024,
      maximumFileCount: 3,
    });

    expect(result).toMatchObject({ status: 'mismatched', confidence: 'bounded-sample-mismatch' });
    expect(result.files[0]?.ranges[0]).toMatchObject({ status: 'mismatched' });
  });

  it('cancels a full response when the server ignores the Range request', async () => {
    const bytes = Uint8Array.from({ length: 100 }, (_, index) => index);
    let cancelled = false;
    const repositoryFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }), { status: 200 }));

    const result = await verifyModelCacheProvenance({
      inventory: inventory({ revision, repositoryPath, size: bytes.byteLength }),
      repository: repository({ revision, repositoryPath, size: bytes.byteLength }),
      storageRoot: storageRoot({ revision, repositoryPath, bytes }),
      repositoryFetch,
      rangeBytes: 32 * 1024,
      maximumFileCount: 3,
    });

    expect(cancelled).toBe(true);
    expect(result).toMatchObject({ status: 'partial', confidence: 'incomplete' });
    expect(result.files[0]?.ranges[0]).toMatchObject({ status: 'range-not-supported' });
  });

  it('cancels a 206 response that exceeds the exact bounded sample length', async () => {
    const bytes = Uint8Array.from({ length: 100 }, (_, index) => index);
    let cancelled = false;
    const repositoryFetch = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200 });
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(101));
        },
        cancel() {
          cancelled = true;
        },
      }), {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-99/100' },
      });
    });

    const result = await verifyModelCacheProvenance({
      inventory: inventory({ revision, repositoryPath, size: bytes.byteLength }),
      repository: repository({ revision, repositoryPath, size: bytes.byteLength }),
      storageRoot: storageRoot({ revision, repositoryPath, bytes }),
      repositoryFetch,
      rangeBytes: 32 * 1024,
      maximumFileCount: 3,
    });

    expect(cancelled).toBe(true);
    expect(result).toMatchObject({ status: 'partial', confidence: 'incomplete' });
    expect(result.files[0]?.ranges[0]).toMatchObject({
      status: 'failed',
      error: { message: 'Range response exceeded 100 bytes' },
    });
  });

  it('samples a completed requested-revision cache file against resolved-revision bytes', async () => {
    const bytes = Uint8Array.from({ length: 100 }, (_, index) => index);
    const repositoryFetch = rangedFetch({ bytes });
    const cache = inventory({ revision: 'main', repositoryPath, size: bytes.byteLength });

    const result = await verifyModelCacheProvenance({
      inventory: cache,
      repository: repository({ revision, repositoryPath, size: bytes.byteLength }),
      storageRoot: storageRoot({ revision: 'main', repositoryPath, bytes }),
      repositoryFetch,
      rangeBytes: 32 * 1024,
      maximumFileCount: 3,
    });

    expect(result).toMatchObject({
      status: 'bounded-samples-matched',
      confidence: 'bounded-samples-matched',
      files: [{ cacheRevision: 'main', repositoryPath, status: 'bounded-samples-matched' }],
    });
    expect(repositoryFetch).toHaveBeenCalledWith(
      `https://huggingface.co/org/model/resolve/${revision}/${repositoryPath}`,
      expect.objectContaining({ credentials: 'omit', cache: 'no-store' }),
    );
  });

  it('rejects a repository size mismatch without requesting bytes', async () => {
    const bytes = Uint8Array.from({ length: 100 }, (_, index) => index);
    const repositoryFetch = vi.fn<typeof fetch>();
    const result = await verifyModelCacheProvenance({
      inventory: inventory({ revision, repositoryPath, size: bytes.byteLength }),
      repository: repository({ revision, repositoryPath, size: bytes.byteLength + 1 }),
      storageRoot: storageRoot({ revision, repositoryPath, bytes }),
      repositoryFetch,
      rangeBytes: 32 * 1024,
      maximumFileCount: 3,
    });

    expect(result).toMatchObject({ status: 'mismatched', confidence: 'bounded-sample-mismatch' });
    expect(result.files[0]).toMatchObject({ status: 'mismatched', ranges: [] });
    expect(repositoryFetch).not.toHaveBeenCalled();
  });
});
