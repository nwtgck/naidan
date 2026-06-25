import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @huggingface/transformers
vi.mock('@huggingface/transformers', () => ({
  AutoProcessor: {
    from_pretrained: vi.fn(),
  },
  AutoTokenizer: {
    from_pretrained: vi.fn(),
  },
  AutoModelForCausalLM: {
    from_pretrained: vi.fn(),
  },
  AutoModelForImageTextToText: {
    from_pretrained: vi.fn(),
  },
  env: {
    allowLocalModels: false,
    allowRemoteModels: true,
    useBrowserCache: false,
    useCustomCache: false,
    fetch: vi.fn(),
  },
}));

// Mock Comlink
vi.mock('comlink', () => ({
  expose: vi.fn(),
}));

describe('transformers-js.scanner.worker', () => {
  let originalFetchMock: any;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    originalFetchMock = vi.fn();
    global.self = {
      fetch: originalFetchMock,
      location: { origin: 'http://localhost:3000' } as any,
    } as any;
    global.fetch = originalFetchMock;
  });

  it('should collect URLs and mock heavy files', async () => {
    const comlink = await import('comlink');
    const { AutoProcessor, AutoTokenizer, AutoModelForCausalLM, env } = await import('@huggingface/transformers');
    await import('./entry');

    const scannerObj = (comlink.expose as any).mock.calls[0][0];

    // Mock responses for metadata files
    originalFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('.json')) {
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('Not Found', { status: 404 });
    });

    // Mock transformers.js behavior: it will fetch files
    (AutoProcessor.from_pretrained as any).mockImplementation(async (id: string) => {
      await env.fetch(`https://huggingface.co/${id}/resolve/main/processor_config.json`);
      await env.fetch(`https://huggingface.co/${id}/resolve/main/chat_template.json`);
    });

    (AutoTokenizer.from_pretrained as any).mockImplementation(async (id: string) => {
      await env.fetch(`https://huggingface.co/${id}/resolve/main/tokenizer.json`);
      await env.fetch(`https://huggingface.co/${id}/resolve/main/tokenizer_config.json`);
    });

    (AutoModelForCausalLM.from_pretrained as any).mockImplementation(async (id: string) => {
      await env.fetch(`https://huggingface.co/${id}/resolve/main/config.json`);
      await env.fetch(`https://huggingface.co/${id}/resolve/main/model.onnx`);
    });

    const result = await scannerObj.scanModel({
      tasks: [
        { type: 'processor', modelId: 'org/repo', options: {} },
        { type: 'tokenizer', modelId: 'org/repo', options: {} },
        { type: 'causal-lm', modelId: 'org/repo', options: {} },
      ],
    });

    expect(result.files).toHaveLength(6);
    const urls = result.files.map((f: any) => f.url);
    expect(urls).toContain('https://huggingface.co/org/repo/resolve/main/processor_config.json');
    expect(urls).toContain('https://huggingface.co/org/repo/resolve/main/chat_template.json');
    expect(urls).toContain('https://huggingface.co/org/repo/resolve/main/tokenizer.json');
    expect(urls).toContain('https://huggingface.co/org/repo/resolve/main/model.onnx');

    // Verify fetch interceptor mocked the heavy file
    // We can't directly check the response of the internal calls in from_pretrained easily,
    // but we can manually test the fetch interceptor.
    const interceptedFetch = self.fetch;
    const heavyRes = await interceptedFetch('https://huggingface.co/org/repo/resolve/main/model.onnx');
    const heavyData = new Uint8Array(await heavyRes.arrayBuffer());
    expect(heavyData).toEqual(new Uint8Array([0, 1, 2, 3]));
    expect(originalFetchMock).not.toHaveBeenCalledWith('https://huggingface.co/org/repo/resolve/main/model.onnx', expect.anything());
  });

  it('should support image-text-to-text scan tasks', async () => {
    const comlink = await import('comlink');
    const { AutoModelForImageTextToText, env } = await import('@huggingface/transformers');
    await import('./entry');
    const scannerObj = (comlink.expose as any).mock.calls[0][0];

    originalFetchMock.mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    (AutoModelForImageTextToText.from_pretrained as any).mockImplementation(async (id: string) => {
      await env.fetch(`https://huggingface.co/${id}/resolve/main/config.json`);
      await env.fetch(`https://huggingface.co/${id}/resolve/main/vision_encoder.onnx`);
    });

    const result = await scannerObj.scanModel({
      tasks: [{ type: 'image-text-to-text', modelId: 'org/repo', options: {} }],
    });

    expect(result.files.map((file: { url: string }) => file.url)).toContain('https://huggingface.co/org/repo/resolve/main/vision_encoder.onnx');
  });

  it('should wire env.fetch to the scanner interceptor', async () => {
    const { env } = await import('@huggingface/transformers');
    await import('./entry');

    expect(env.fetch).toBe(self.fetch);
  });

  it('should handle scan task errors gracefully', async () => {
    const comlink = await import('comlink');
    const { AutoTokenizer } = await import('@huggingface/transformers');
    await import('./entry');
    const scannerObj = (comlink.expose as any).mock.calls[0][0];

    (AutoTokenizer.from_pretrained as any).mockRejectedValue(new Error('Scan failed'));

    const result = await scannerObj.scanModel({
      tasks: [{ type: 'tokenizer', modelId: 'org/repo', options: {} }],
    });

    // Even if it fails, it should return what it collected so far
    expect(result.files).toBeDefined();
    expect(Array.isArray(result.files)).toBe(true);
  });
});
