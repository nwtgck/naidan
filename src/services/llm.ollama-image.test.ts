import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaProvider } from './llm';

describe('OllamaProvider Image Generation', () => {
  const config = {
    endpoint: 'http://localhost:11434',
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('successfully generates an image', async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({
        data: [{ b64_json: 'YmFzZTY0ZGF0YQ==' }] // "base64data" in base64
      })
    };
    (fetch as any).mockResolvedValueOnce(mockResponse);

    // Mock for the subsequent fetch that converts data URL to blob
    (fetch as any).mockResolvedValueOnce({
      blob: () => Promise.resolve(new Blob(['dummy'], { type: 'image/png' }))
    });

    const provider = new OllamaProvider(config);
    const blob = await provider.generateImage({
      prompt: 'test prompt',
      model: 'x/z-image-turbo:test',
      width: 512,
      height: 512,
      images: [],
      signal: undefined
    });

    expect(blob).toBeInstanceOf(Blob);
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:11434/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model: 'x/z-image-turbo:test',
          prompt: 'test prompt',
          size: '512x512',
          response_format: 'b64_json'
        })
      })
    );
  });

  it('successfully generates an image from another image (multimodal)', async () => {
    // Mock FileReader
    function MockFileReader(this: any) {
      this.readAsDataURL = vi.fn(() => {
        this.result = 'data:image/png;base64,YmFzZTY0ZGF0YQ==';
        if (this.onloadend) this.onloadend();
      });
    }
    vi.stubGlobal('FileReader', MockFileReader);

    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({
        image: 'YmFzZTY0cmVzcG9uc2U=' // "base64response" in base64
      })
    };
    (fetch as any).mockResolvedValueOnce(mockResponse);

    // Mock for the subsequent fetch that converts data URL to blob
    (fetch as any).mockResolvedValueOnce({
      blob: () => Promise.resolve(new Blob(['dummy'], { type: 'image/png' }))
    });

    const provider = new OllamaProvider(config);
    const inputBlob = new Blob(['input'], { type: 'image/png' });
    const blob = await provider.generateImage({
      prompt: 'test prompt',
      model: 'x/z-image-turbo:test',
      width: 512,
      height: 512,
      images: [{ blob: inputBlob }],
      signal: undefined
    });

    expect(blob).toBeInstanceOf(Blob);
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/generate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model: 'x/z-image-turbo:test',
          prompt: 'test prompt',
          images: ['YmFzZTY0ZGF0YQ=='],
          stream: false
        })
      })
    );
  });

  it('throws error on API failure', async () => {
    const mockResponse = {
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: () => Promise.resolve({ error: { message: 'Something went wrong' } })
    };
    (fetch as any).mockResolvedValueOnce(mockResponse);

    const provider = new OllamaProvider(config);
    await expect(provider.generateImage({
      prompt: 'test',
      model: 'test',
      width: 512,
      height: 512,
      images: [],
      signal: undefined
    })).rejects.toThrow('Ollama Image Generation Error (500): Something went wrong');
  });

  it('aborts generation when signal is aborted', async () => {
    const controller = new AbortController();
    const mockError = new Error('The user aborted a request.');
    mockError.name = 'AbortError';

    (fetch as any).mockRejectedValueOnce(mockError);

    const provider = new OllamaProvider(config);
    const promise = provider.generateImage({
      prompt: 'test',
      model: 'test',
      width: 512,
      height: 512,
      images: [],
      signal: controller.signal
    });

    controller.abort();
    await expect(promise).rejects.toThrow('The user aborted a request.');
  });
});
