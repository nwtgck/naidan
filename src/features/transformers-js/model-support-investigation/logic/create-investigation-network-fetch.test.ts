import { describe, expect, it, vi } from 'vitest';
import {
  createModelSupportInvestigationNetworkFetch,
  ModelSupportInvestigationNetworkPolicyError,
} from '@/features/transformers-js/model-support-investigation/logic/create-investigation-network-fetch';

function guarded({
  policy = 'allow',
  runtimeFetch = vi.fn<typeof fetch>(async () => new Response('ok', { status: 200 })),
}: {
  policy?: 'allow' | 'deny';
  runtimeFetch?: typeof fetch;
} = {}) {
  return {
    runtimeFetch,
    fetch: createModelSupportInvestigationNetworkFetch({
      runtimeFetch,
      applicationOrigin: 'https://naidan.example',
      externalNetworkPolicy: policy,
      maximumModelArtifactRangeBytes: 64 * 1024,
    }),
  };
}

function partialContentResponse({ start, end, total = 1024 * 1024 }: {
  start: number;
  end: number;
  total?: number;
}): Response {
  const length = end - start + 1;
  return new Response(new Uint8Array(length), {
    status: 206,
    headers: {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(length),
    },
  });
}

describe('createModelSupportInvestigationNetworkFetch', () => {
  it('allows same-origin runtime asset requests regardless of external-network policy', async () => {
    const runtimeFetch = vi.fn(async () => new Response('runtime'));
    const fetch = createModelSupportInvestigationNetworkFetch({
      runtimeFetch,
      applicationOrigin: 'https://naidan.example',
      externalNetworkPolicy: 'deny',
      maximumModelArtifactRangeBytes: 64 * 1024,
    });

    await expect(fetch('https://naidan.example/transformers/ort.wasm')).resolves.toBeInstanceOf(Response);
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
  });

  it('enforces model-artifact download bounds even for same-origin URLs', async () => {
    const { fetch, runtimeFetch } = guarded({ policy: 'deny' });

    await expect(fetch('https://naidan.example/models/model_q4.onnx')).rejects.toMatchObject({
      code: 'unbounded-model-artifact-get',
    });
    expect(runtimeFetch).not.toHaveBeenCalled();
  });

  it('fails closed before fetch when external-network access is denied', async () => {
    const { fetch, runtimeFetch } = guarded({ policy: 'deny' });

    await expect(fetch('https://huggingface.co/api/models/org/model')).rejects.toMatchObject({
      name: 'ModelSupportInvestigationNetworkPolicyError',
      code: 'external-network-disabled',
    });
    expect(runtimeFetch).not.toHaveBeenCalled();
  });

  it('allows bounded model-artifact HEAD and Range observations', async () => {
    const runtimeFetch = vi.fn<typeof fetch>(async (_input, init) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'HEAD') return new Response(null, { status: 200 });
      return partialContentResponse({ start: 0, end: 65_535 });
    });
    const { fetch } = guarded({ runtimeFetch });
    const url = 'https://huggingface.co/org/model/resolve/revision/onnx/model_q4.onnx_data';

    await fetch(url, { method: 'HEAD' });
    await fetch(url, { headers: { Range: 'bytes=0-65535' } });

    expect(runtimeFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects unbounded model-artifact GET before the underlying fetch can download a body', async () => {
    const { fetch, runtimeFetch } = guarded();
    const url = 'https://huggingface.co/org/model/resolve/revision/onnx/model_q4.onnx_data';

    await expect(fetch(url)).rejects.toBeInstanceOf(ModelSupportInvestigationNetworkPolicyError);
    await expect(fetch(url)).rejects.toMatchObject({ code: 'unbounded-model-artifact-get' });
    expect(runtimeFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['bytes=0-', 'model-artifact-range-invalid'],
    ['bytes=0-65536', 'model-artifact-range-too-large'],
    ['bytes=0-1,4-5', 'model-artifact-range-invalid'],
  ] as const)('rejects unsafe model-artifact Range %s', async (range, code) => {
    const { fetch, runtimeFetch } = guarded();
    const url = 'https://huggingface.co/org/model/resolve/revision/onnx/model_q4.onnx';

    await expect(fetch(url, { headers: { Range: range } })).rejects.toMatchObject({ code });
    expect(runtimeFetch).not.toHaveBeenCalled();
  });

  it('cancels and rejects a server response that ignores a bounded model-artifact Range request', async () => {
    const cancel = vi.fn(async () => undefined);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel,
    });
    const runtimeFetch = vi.fn<typeof fetch>(async () => new Response(body, {
      status: 200,
      headers: { 'Content-Length': String(1024 * 1024 * 1024) },
    }));
    const { fetch } = guarded({ runtimeFetch });

    await expect(fetch(
      'https://huggingface.co/org/model/resolve/revision/onnx/model_q4.onnx_data',
      { headers: { Range: 'bytes=0-4095' } },
    )).rejects.toMatchObject({ code: 'model-artifact-range-not-honored' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed partial-content responses instead of exposing a possibly unbounded body', async () => {
    const runtimeFetch = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(4096), {
      status: 206,
      headers: {
        'Content-Range': 'bytes 4096-8191/10000',
        'Content-Length': '4096',
      },
    }));
    const { fetch } = guarded({ runtimeFetch });

    await expect(fetch(
      'https://huggingface.co/org/model/resolve/revision/onnx/model_q4.onnx',
      { headers: { Range: 'bytes=0-4095' } },
    )).rejects.toMatchObject({ code: 'model-artifact-range-not-honored' });
  });

  it('does not reinterpret normal small declaration GETs as model-body downloads', async () => {
    const { fetch, runtimeFetch } = guarded();

    await fetch('https://huggingface.co/org/model/resolve/revision/config.json');

    expect(runtimeFetch).toHaveBeenCalledTimes(1);
  });
});
