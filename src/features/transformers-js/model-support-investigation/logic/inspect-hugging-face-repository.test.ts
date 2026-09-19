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

  it('reports an HTML metadata fallback explicitly instead of surfacing a JSON parser token error', async () => {
    const repositoryFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response('<!doctype html><html></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }));

    await expect(inspectHuggingFaceRepository({
      modelId: 'org/model',
      requestedRevision: 'main',
      repositoryFetch,
    })).rejects.toThrow(
      'Hugging Face repository metadata resolved to HTML instead of JSON: https://huggingface.co/api/models/org/model/revision/main?blobs=true',
    );
  });

  it('reports HTML-like metadata even when the response Content-Type is misleading', async () => {
    const repositoryFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response('  <!doctype html><html></html>', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(inspectHuggingFaceRepository({
      modelId: 'org/model',
      requestedRevision: 'main',
      repositoryFetch,
    })).rejects.toThrow('returned HTML-like content instead of JSON');
  });

  it('preserves the JSON parser failure as the cause of malformed metadata errors', async () => {
    const repositoryFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response('{not-json', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    try {
      await inspectHuggingFaceRepository({
        modelId: 'org/model',
        requestedRevision: 'main',
        repositoryFetch,
      });
      expect.unreachable('Expected malformed repository metadata to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        message: expect.stringContaining('repository metadata is not valid JSON'),
        cause: expect.any(SyntaxError),
      });
    }
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
