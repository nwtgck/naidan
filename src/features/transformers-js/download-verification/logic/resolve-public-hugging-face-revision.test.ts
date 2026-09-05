import { describe, expect, it, vi } from 'vitest';
import { resolvePublicHuggingFaceRevision } from '@/features/transformers-js/download-verification/logic/resolve-public-hugging-face-revision';

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('resolvePublicHuggingFaceRevision', () => {
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
