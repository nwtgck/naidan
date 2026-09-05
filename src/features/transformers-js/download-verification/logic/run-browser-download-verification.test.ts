import { describe, expect, it, vi } from 'vitest';
import {
  normalizePublicHuggingFaceModelId,
  runBrowserDownloadVerification,
  sanitizeDiagnosticText,
  sanitizeObservedUrl,
  TEST_ONLY,
} from '@/features/transformers-js/download-verification/logic/run-browser-download-verification';

const REVISION = '0123456789abcdef0123456789abcdef01234567';

function responseWithUrl({ body, init, url }: {
  body?: BodyInit | null,
  init?: ResponseInit,
  url: string,
}): Response {
  const response = new Response(body ?? null, init);
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function metadataResponse(): Response {
  return responseWithUrl({
    url: 'https://huggingface.co/api/models/org/model/revision/main?blobs=true',
    init: {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
    body: JSON.stringify({
      sha: REVISION,
      siblings: [
        { rfilename: 'config.json', size: 100, blobId: 'config-blob' },
        { rfilename: 'onnx/model_q4.onnx', size: 200_000, blobId: 'core-blob' },
        { rfilename: 'onnx/model_q4.onnx_data', size: 1_000_000_000, lfs: { sha256: 'a'.repeat(64), size: 1_000_000_000 } },
      ],
    }),
  });
}

describe('runBrowserDownloadVerification', () => {
  it('normalizes public Hugging Face model IDs and URLs', () => {
    expect(normalizePublicHuggingFaceModelId({ modelId: ' org/model ' })).toBe('org/model');
    expect(normalizePublicHuggingFaceModelId({ modelId: 'https://huggingface.co/org/model/' })).toBe('org/model');
    expect(() => normalizePublicHuggingFaceModelId({ modelId: 'org/model/private/path' })).toThrow(/OWNER\/REPO/u);
  });

  it('rejects an already-aborted verification instead of returning a partial successful run', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('closed', 'AbortError'));

    await expect(runBrowserDownloadVerification({
      modelId: 'org/model',
      signal: controller.signal,
      resolvedRepository: {
        modelId: 'org/model',
        normalizedModelId: 'org/model',
        requestedRevision: 'main',
        resolvedRevision: REVISION,
        repositoryFiles: [],
      },
    })).rejects.toMatchObject({ name: 'AbortError', message: 'closed' });
  });

  it('does not miss an abort that happens while the request abort listener is being registered', () => {
    const parent = new AbortController();
    const originalAddEventListener = parent.signal.addEventListener.bind(parent.signal);
    vi.spyOn(parent.signal, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'abort') parent.abort('close-race');
      originalAddEventListener(type, listener, options);
    });

    const request = TEST_ONLY.requestAbortController({
      signal: parent.signal,
      timeoutMs: 10_000,
    });

    expect(parent.signal.aborted).toBe(true);
    expect(request.controller.signal.aborted).toBe(true);
    expect(request.controller.signal.reason).toBe('close-race');
    request.dispose();
  });

  it('removes query strings and fragments from observed URLs and diagnostics', () => {
    expect(sanitizeObservedUrl({
      value: 'https://cdn.example.test/path/model.onnx?X-Amz-Signature=secret#fragment',
    })).toBe('https://cdn.example.test/path/model.onnx');
    expect(sanitizeDiagnosticText({
      value: 'failed at https://cdn.example.test/model?token=secret and retry',
    })).toBe('failed at https://cdn.example.test/model and retry');
  });

  it('uses credential-free no-referrer requests and avoids GET when HEAD is sufficient', async () => {
    const browserFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'GET') return metadataResponse();
      return responseWithUrl({
        url: 'https://cdn.example.test/artifact',
        init: {
          status: 200,
          headers: {
            'content-length': '1000000000',
            'accept-ranges': 'bytes',
            etag: 'public-artifact-etag',
          },
        },
      });
    }) as unknown as typeof fetch;

    const run = await runBrowserDownloadVerification({
      modelId: 'org/model',
      browserFetch,
      maximumProbedArtifacts: 1,
      now: (() => {
        const values = ['2026-09-03T08:00:00.000Z', '2026-09-03T08:00:01.000Z'];
        return () => values.shift() ?? '2026-09-03T08:00:01.000Z';
      })(),
    });

    expect(run.resolvedRevision).toBe(REVISION);
    expect(run.repositoryFiles.find(file => file.path.endsWith('.onnx_data'))).toMatchObject({
      lfsSha256: 'a'.repeat(64),
      lfsSize: 1_000_000_000,
    });
    expect(run.bytesConsumed).toBe(0);
    expect(run.transportObservations).toHaveLength(1);
    expect(run.transportObservations[0]).toMatchObject({
      method: 'HEAD',
      finalUrl: 'https://cdn.example.test/artifact',
      finalOrigin: 'https://cdn.example.test',
      bytesConsumed: 0,
    });

    const calls = vi.mocked(browserFetch).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [, init] of calls) {
      expect(init).toMatchObject({
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        redirect: 'follow',
      });
    }
  });

  it('uses an already-frozen repository revision without resolving main again', async () => {
    const browserFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('HEAD');
      return responseWithUrl({
        url: `https://huggingface.co/org/model/resolve/${REVISION}/onnx/model_q4.onnx`,
        init: {
          status: 200,
          headers: {
            'content-length': '200000',
            'accept-ranges': 'bytes',
          },
        },
      });
    }) as unknown as typeof fetch;

    const run = await runBrowserDownloadVerification({
      modelId: 'org/model',
      resolvedRepository: {
        modelId: 'hf.co/org/model',
        normalizedModelId: 'org/model',
        requestedRevision: 'main',
        resolvedRevision: REVISION,
        repositoryFiles: [{
          path: 'onnx/model_q4.onnx',
          size: 200_000,
          blobId: 'core-blob',
          lfsOid: undefined,
          lfsSha256: undefined,
          lfsSize: undefined,
        }],
      },
      browserFetch,
      maximumProbedArtifacts: 1,
    });

    expect(run.resolvedRevision).toBe(REVISION);
    expect(run.repositoryFiles).toHaveLength(1);
    expect(browserFetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(browserFetch).mock.calls[0]?.[0])).toContain(`/resolve/${REVISION}/`);
    expect(String(vi.mocked(browserFetch).mock.calls[0]?.[0])).not.toContain('/api/models/');
  });

  it('falls back to a bounded Range request when HEAD does not prove range support', async () => {
    const browserFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'GET' && new Headers(init.headers).get('Range') === null) return metadataResponse();
      if (init?.method === 'HEAD') {
        return responseWithUrl({
          url: 'https://huggingface.co/org/model/resolve/revision/onnx/model_q4.onnx_data',
          init: { status: 200 },
        });
      }
      return responseWithUrl({
        url: 'https://us.aws.cdn.hf.co/path/model_q4.onnx_data?X-Amz-Signature=secret',
        init: {
          status: 206,
          headers: {
            'content-range': 'bytes 0-4095/1000000000',
            'content-length': '4096',
            'accept-ranges': 'bytes',
          },
        },
        body: new Uint8Array(4096),
      });
    }) as unknown as typeof fetch;

    const run = await runBrowserDownloadVerification({
      modelId: 'org/model',
      browserFetch,
      maximumProbedArtifacts: 1,
      rangeBytes: 4096,
      perFileByteBudget: 64 * 1024,
      totalByteBudget: 2 * 1024 * 1024,
    });

    expect(run.bytesConsumed).toBe(4096);
    expect(run.transportObservations[0]).toMatchObject({
      method: 'GET-range',
      status: 206,
      rangeHonored: true,
      bytesConsumed: 4096,
      finalUrl: 'https://us.aws.cdn.hf.co/path/model_q4.onnx_data',
      finalOrigin: 'https://us.aws.cdn.hf.co',
    });
    const rangeCall = vi.mocked(browserFetch).mock.calls.find(([, init]) => new Headers(init?.headers).has('Range'));
    expect(rangeCall).toBeDefined();
    expect(new Headers(rangeCall?.[1]?.headers).get('Range')).toBe('bytes=0-4095');
  });

  it('stops consuming a server response that ignores Range at the per-file byte budget', async () => {
    const browserFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'GET' && new Headers(init.headers).get('Range') === null) return metadataResponse();
      if (init?.method === 'HEAD') {
        return responseWithUrl({ url: 'https://huggingface.co/artifact', init: { status: 405 } });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(40 * 1024));
          controller.enqueue(new Uint8Array(40 * 1024));
          controller.close();
        },
      });
      return responseWithUrl({
        url: 'https://cdn.example.test/artifact?signature=secret',
        init: { status: 200, headers: { 'content-length': '1000000000' } },
        body: stream,
      });
    }) as unknown as typeof fetch;

    const run = await runBrowserDownloadVerification({
      modelId: 'org/model',
      browserFetch,
      maximumProbedArtifacts: 1,
      perFileByteBudget: 64 * 1024,
      totalByteBudget: 64 * 1024,
    });

    expect(run.bytesConsumed).toBe(80 * 1024);
    expect(run.transportObservations[0]).toMatchObject({
      method: 'GET-range',
      rangeHonored: false,
      bytesConsumed: 80 * 1024,
      abortedByByteBudget: true,
      finalUrl: 'https://cdn.example.test/artifact',
    });
  });

  it('limits the number of probed model artifacts and records the skipped count', async () => {
    const metadata = responseWithUrl({
      url: 'https://huggingface.co/api/models/org/model/revision/main?blobs=true',
      init: { status: 200, headers: { 'content-type': 'application/json' } },
      body: JSON.stringify({
        sha: REVISION,
        siblings: Array.from({ length: 5 }, (_, index) => ({
          rfilename: `onnx/model_${index}.onnx_data`,
          size: 1000 + index,
        })),
      }),
    });
    const browserFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'GET') return metadata.clone();
      return responseWithUrl({
        url: 'https://cdn.example.test/artifact',
        init: { status: 200, headers: { 'content-length': '1000', 'accept-ranges': 'bytes' } },
      });
    }) as unknown as typeof fetch;

    const run = await runBrowserDownloadVerification({
      modelId: 'org/model',
      browserFetch,
      maximumProbedArtifacts: 2,
    });

    expect(run.transportObservations).toHaveLength(2);
    expect(run.skippedModelArtifactCount).toBe(3);
  });
});

describe('runBrowserDownloadVerification transport failures', () => {
  it('preserves bytes consumed before a Range response stream fails', async () => {
    const browserFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'GET' && new Headers(init.headers).get('Range') === null) return metadataResponse();
      if (init?.method === 'HEAD') {
        return responseWithUrl({ url: 'https://huggingface.co/artifact', init: { status: 405 } });
      }
      let pullCount = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pullCount === 0) {
            pullCount += 1;
            controller.enqueue(new Uint8Array(2048));
            return;
          }
          controller.error(new Error('fixture connection dropped'));
        },
      });
      return responseWithUrl({
        url: 'https://cdn.example.test/artifact?X-Amz-Signature=secret',
        init: {
          status: 206,
          headers: {
            'content-range': 'bytes 0-4095/1000000000',
            'content-length': '4096',
            'accept-ranges': 'bytes',
          },
        },
        body: stream,
      });
    }) as unknown as typeof fetch;

    const run = await runBrowserDownloadVerification({
      modelId: 'org/model',
      browserFetch,
      maximumProbedArtifacts: 1,
    });

    expect(run.bytesConsumed).toBe(2048);
    expect(run.transportObservations[0]).toMatchObject({
      method: 'GET-range',
      status: 206,
      rangeHonored: true,
      bytesConsumed: 2048,
      abortedByByteBudget: false,
      finalUrl: 'https://cdn.example.test/artifact',
      error: {
        name: 'Error',
        message: 'fixture connection dropped',
      },
    });
  });
});
