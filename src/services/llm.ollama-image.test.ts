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
      body: {
        getReader: () => {
          const encoder = new TextEncoder();
          const chunks = [
            JSON.stringify({ done: false, total: 10 }) + '\n',
            JSON.stringify({ done: false, completed: 5, total: 10 }) + '\n',
            JSON.stringify({ done: true, image: 'YmFzZTY0ZGF0YQ==' })
          ];
          let index = 0;
          return {
            read: () => {
              if (index >= chunks.length) return Promise.resolve({ done: true });
              return Promise.resolve({ done: false, value: encoder.encode(chunks[index++]) });
            }
          };
        }
      }
    };
    (fetch as any).mockResolvedValueOnce(mockResponse);

    const provider = new OllamaProvider(config);
    const blob = await provider.generateImage({
      prompt: 'test prompt',
      model: 'x/z-image-turbo:test',
      width: 512,
      height: 512,
      steps: 10,
      seed: 123,
      images: [],
      onProgress: () => {},
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
          images: undefined,
          stream: true,
          width: 512,
          height: 512,
          steps: 10,
          options: { seed: 123 }
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
      body: {
        getReader: () => {
          const encoder = new TextEncoder();
          const chunks = [
            JSON.stringify({ done: false, total: 10 }) + '\n',
            JSON.stringify({ done: false, completed: 5, total: 10 }) + '\n',
            JSON.stringify({ done: true, image: 'YmFzZTY0cmVzcG9uc2U=' })
          ];
          let index = 0;
          return {
            read: () => {
              if (index >= chunks.length) return Promise.resolve({ done: true });
              return Promise.resolve({ done: false, value: encoder.encode(chunks[index++]) });
            }
          };
        }
      }
    };
    (fetch as any).mockResolvedValueOnce(mockResponse);

    const provider = new OllamaProvider(config);
    const inputBlob = new Blob(['input'], { type: 'image/png' });
    const blob = await provider.generateImage({
      prompt: 'test prompt',
      model: 'x/z-image-turbo:test',
      width: 512,
      height: 512,
      steps: undefined,
      seed: undefined,
      images: [{ blob: inputBlob }],
      onProgress: () => {},
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
          stream: true,
          width: 512,
          height: 512,
          steps: undefined,
          options: undefined
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
      steps: undefined,
      seed: undefined,
      images: [],
      onProgress: () => {},
      signal: undefined
    })).rejects.toThrow('Ollama Image Generation Error (/api/generate, 500): Something went wrong');
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
      steps: undefined,
      seed: undefined,
      images: [],
      onProgress: () => {},
      signal: controller.signal
    });

    controller.abort();
    await expect(promise).rejects.toThrow('The user aborted a request.');
  });
});
