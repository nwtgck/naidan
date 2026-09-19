import { describe, expect, it } from 'vitest';
import { parseHuggingFaceResolveIdentity } from './hugging-face-resolve-identity';

describe('Hugging Face resolve identity', () => {
  it('retains an encoded revision ref without moving the artifact boundary', () => {
    expect(parseHuggingFaceResolveIdentity({ url: 'https://huggingface.co/org/model/resolve/refs%2Fpr%2F1/onnx/model.onnx' }))
      .toEqual({ modelId: 'org/model', revision: 'refs/pr/1', path: 'onnx/model.onnx' });
  });
  it.each(['resolve/model', 'org/resolve', 'org/model'])('keeps the model identity for %s', modelId => {
    expect(parseHuggingFaceResolveIdentity({ url: `https://huggingface.co/${modelId}/resolve/abc123/onnx/resolve/model%20name.onnx?download=true#fragment` }))
      .toEqual({ modelId, revision: 'abc123', path: 'onnx/resolve/model name.onnx' });
  });

  it.each([
    'not a URL',
    'https://huggingface.co.example/org/model/resolve/abc/model.onnx',
    'https://example.com/org/model/resolve/abc/model.onnx',
    'https://huggingface.co/org/model/tree/abc/resolve/model.onnx',
    'https://huggingface.co/org/model/resolve/abc/',
    'https://huggingface.co/org/model/resolve/abc//model.onnx',
    'https://huggingface.co/org/model/resolve/abc/model%zz.onnx',
    'https://huggingface.co/org/model/resolve/abc/onnx%2Fmodel.onnx',
    'https://huggingface.co/org%2Fother/model/resolve/abc/model.onnx',
    'https://huggingface.co/org/model/resolve/abc/model%5Connx',
  ])('rejects a malformed or ambiguous identity: %s', url => {
    expect(parseHuggingFaceResolveIdentity({ url })).toBeUndefined();
  });
});
