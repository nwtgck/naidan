import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @huggingface/transformers
vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: {
    from_pretrained: vi.fn(),
  },
  AutoModelForCausalLM: {
    from_pretrained: vi.fn(),
  },
  env: {
    allowLocalModels: false,
    allowRemoteModels: true,
    useBrowserCache: false,
    useCustomCache: false,
  }
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
      location: { origin: 'http://localhost:3000' } as any
    } as any;
    global.fetch = originalFetchMock;
  });

  it('should collect URLs and mock heavy files', async () => {
    const comlink = await import('comlink');
    const { AutoTokenizer, AutoModelForCausalLM } = await import('@huggingface/transformers');
    await import('./transformers-js.scanner.worker');

    const scannerObj = (comlink.expose as any).mock.calls[0][0];

    // Mock responses for metadata files
    originalFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('.json')) {
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('Not Found', { status: 404 });
    });

    // Mock transformers.js behavior: it will fetch files
    (AutoTokenizer.from_pretrained as any).mockImplementation(async (id: string) => {
      await self.fetch(`https://huggingface.co/${id}/resolve/main/tokenizer.json`);
      await self.fetch(`https://huggingface.co/${id}/resolve/main/tokenizer_config.json`);
    });

    (AutoModelForCausalLM.from_pretrained as any).mockImplementation(async (id: string) => {
      await self.fetch(`https://huggingface.co/${id}/resolve/main/config.json`);
      await self.fetch(`https://huggingface.co/${id}/resolve/main/model.onnx`);
    });

    const result = await scannerObj.scanModel({
      tasks: [
        { type: 'tokenizer', modelId: 'org/repo', options: {} },
        { type: 'causal-lm', modelId: 'org/repo', options: {} }
      ]
    });

    expect(result.files).toHaveLength(4);
    const urls = result.files.map((f: any) => f.url);
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

  it('should handle scan task errors gracefully', async () => {
    const comlink = await import('comlink');
    const { AutoTokenizer } = await import('@huggingface/transformers');
    await import('./transformers-js.scanner.worker');
    const scannerObj = (comlink.expose as any).mock.calls[0][0];

    (AutoTokenizer.from_pretrained as any).mockRejectedValue(new Error('Scan failed'));

    const result = await scannerObj.scanModel({
      tasks: [{ type: 'tokenizer', modelId: 'org/repo', options: {} }]
    });

    // Even if it fails, it should return what it collected so far
    expect(result.files).toBeDefined();
    expect(Array.isArray(result.files)).toBe(true);
  });
});
