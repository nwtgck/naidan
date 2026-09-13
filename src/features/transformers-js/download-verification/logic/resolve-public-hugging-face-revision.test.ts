import { describe, expect, it, vi } from 'vitest';
import { resolvePublicHuggingFaceRevision } from '@/features/transformers-js/download-verification/logic/resolve-public-hugging-face-revision';

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('resolvePublicHuggingFaceRevision', () => {
  it('reuses optional artifact sizes from the already resolved SHA response without another request', async () => {
    const repositoryFetch = vi.fn<typeof fetch>(async () => Response.json({ sha: SHA, siblings: [
      { rfilename: 'onnx/a', size: 123, lfs: { size: 123, pointerSize: 9 } },
      { rfilename: 'onnx/b', lfs: { size: 456, pointerSize: 9 } },
      { rfilename: 'onnx/c' },
    ] }));
    const result = await resolvePublicHuggingFaceRevision({ modelId: 'org/model', repositoryFetch });
    expect(result.resolvedRevision).toBe(SHA);
    expect(result.sizeHints).toEqual([{ path: 'onnx/a', bytes: 123 }, { path: 'onnx/b', bytes: 456 }]);
    expect(repositoryFetch).toHaveBeenCalledOnce();
    expect(repositoryFetch.mock.calls[0]?.[0]).toBe('https://huggingface.co/api/models/org/model/revision/main');
  });

  it('keeps SHA success but rejects invalid and duplicate optional sizes in either order', async () => {
    const repositoryFetch = vi.fn<typeof fetch>(async () => Response.json({ sha: SHA, siblings: [
      { rfilename: 'a', size: 100 }, { rfilename: 'a', size: -1 },
      { rfilename: 'b', size: -1 }, { rfilename: 'b', size: 100 },
      { rfilename: 'c', size: 100, lfs: { size: 200 } },
      { rfilename: 'd', size: Number.MAX_SAFE_INTEGER + 1 },
      { rfilename: 'e', size: 0 },
    ] }));
    expect(await resolvePublicHuggingFaceRevision({ modelId: 'org/model', repositoryFetch })).toEqual({
      normalizedModelId: 'org/model', requestedRevision: 'main', resolvedRevision: SHA,
    });
    expect(repositoryFetch).toHaveBeenCalledOnce();
  });

  it('resolves main to an exact public commit without credentials', async () => {
    const repositoryFetch = vi.fn(async () => new Response(JSON.stringify({ sha: SHA }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const result = await resolvePublicHuggingFaceRevision({
      modelId: 'https://huggingface.co/org/model',
      repositoryFetch: repositoryFetch as typeof fetch,
    });

    expect(result).toEqual({
      normalizedModelId: 'org/model',
      requestedRevision: 'main',
      resolvedRevision: SHA,
    });
    expect(repositoryFetch).toHaveBeenCalledWith(
      'https://huggingface.co/api/models/org/model/revision/main',
      expect.objectContaining({
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json' },
      }),
    );
  });

  it('fails closed for private/gated-like repository responses', async () => {
    const repositoryFetch = vi.fn(async () => new Response('forbidden', { status: 403, statusText: 'Forbidden' }));
    await expect(resolvePublicHuggingFaceRevision({
      modelId: 'org/private-model',
      repositoryFetch: repositoryFetch as typeof fetch,
    })).rejects.toThrow('403 Forbidden');
  });

  it('rejects metadata without an exact commit SHA', async () => {
    const repositoryFetch = vi.fn(async () => new Response(JSON.stringify({ sha: 'main' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(resolvePublicHuggingFaceRevision({
      modelId: 'org/model',
      repositoryFetch: repositoryFetch as typeof fetch,
    })).rejects.toThrow('resolved commit SHA');
  });
});
