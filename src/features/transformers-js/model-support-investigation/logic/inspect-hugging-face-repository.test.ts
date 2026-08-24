import { describe, expect, it, vi } from 'vitest';
import {
  inspectHuggingFaceRepository,
  normalizeHuggingFaceModelId,
} from './inspect-hugging-face-repository';

describe('inspectHuggingFaceRepository', () => {
  it('normalizes supported Hugging Face model ID forms', () => {
    expect(normalizeHuggingFaceModelId({ modelId: 'org/model' })).toBe('org/model');
    expect(normalizeHuggingFaceModelId({ modelId: 'hf.co/org/model' })).toBe('org/model');
    expect(normalizeHuggingFaceModelId({ modelId: 'https://huggingface.co/org/model/' })).toBe('org/model');
    expect(() => normalizeHuggingFaceModelId({ modelId: 'org/model/extra' })).toThrow('Unsupported Hugging Face model ID');
  });

  it('records the resolved commit and normalized repository file manifest', async () => {
    const repositoryFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      pipeline_tag: 'text-generation',
      library_name: 'transformers',
      siblings: [
        { rfilename: 'model_q4.onnx', lfs: { oid: 'oid-1', size: 200 } },
        { rfilename: 'config.json', size: 100, blobId: 'blob-1' },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await inspectHuggingFaceRepository({
      modelId: 'hf.co/org/model',
      requestedRevision: 'main',
      repositoryFetch,
    });

    expect(repositoryFetch).toHaveBeenCalledWith(
      'https://huggingface.co/api/models/org/model/revision/main?blobs=true',
      { headers: { Accept: 'application/json' } },
    );
    expect(result.resolvedRevision).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(result.files).toEqual([
      { path: 'config.json', size: 100, blobId: 'blob-1', lfsOid: undefined },
      { path: 'model_q4.onnx', size: 200, blobId: undefined, lfsOid: 'oid-1' },
    ]);
  });

  it('rejects metadata without an exact resolved commit', async () => {
    const repositoryFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      sha: 'main',
      siblings: [],
    }), { status: 200 }));

    await expect(inspectHuggingFaceRepository({
      modelId: 'org/model',
      requestedRevision: 'main',
      repositoryFetch,
    })).rejects.toThrow('resolved commit SHA');
  });

  it('rejects malformed repository file entries through the API schema', async () => {
    const repositoryFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      siblings: [{ rfilename: 7 }],
    }), { status: 200 }));

    await expect(inspectHuggingFaceRepository({
      modelId: 'org/model',
      requestedRevision: 'main',
      repositoryFetch,
    })).rejects.toThrow('rfilename');
  });
});
