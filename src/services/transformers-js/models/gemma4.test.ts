import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@huggingface/transformers', () => ({
  RawImage: {
    read: vi.fn(),
  },
}));

describe('transformers-js-gemma4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects Gemma 4 from model type or model id', async () => {
    const { isGemma4Model } = await import('./gemma4');

    expect(isGemma4Model({
      modelType: 'gemma4',
      activeModelId: null,
    })).toBe(true);

    expect(isGemma4Model({
      modelType: undefined,
      activeModelId: 'hf.co/onnx-community/gemma-4-E2B-it-ONNX',
    })).toBe(true);

    expect(isGemma4Model({
      modelType: 'llama',
      activeModelId: 'hf.co/meta-llama/Llama-3.2-3B-Instruct',
    })).toBe(false);
  });

  it('converts image_url content into Gemma 4 template images and placeholders', async () => {
    const { RawImage } = await import('@huggingface/transformers');
    const { buildGemma4TemplateInput } = await import('./gemma4');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('image-bytes', {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    })));
    (RawImage.read as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'raw-1' });

    const result = await buildGemma4TemplateInput({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      }],
    });

    expect(result.templateMessages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image' },
        { type: 'image' },
      ],
    }]);
    expect(result.images).toEqual([{ id: 'raw-1' }]);
  });
});
