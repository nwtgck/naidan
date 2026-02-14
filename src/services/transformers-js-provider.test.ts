import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the service
const mockService = {
  getState: vi.fn(),
  loadModel: vi.fn(),
  generateText: vi.fn(),
  listCachedModels: vi.fn(),
};

vi.mock('./transformers-js', () => ({
  transformersJsService: mockService
}));

describe('TransformersJsProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should auto-load model if not already ready', async () => {
    mockService.getState.mockReturnValue({ status: 'idle', activeModelId: null });
    mockService.loadModel.mockResolvedValue(undefined);
    mockService.generateText.mockResolvedValue(undefined);

    const { TransformersJsProvider } = await import('./transformers-js-provider');
    const provider = new TransformersJsProvider();

    const onChunk = vi.fn();
    await provider.chat({
      model: 'some-model',
      messages: [{ role: 'user', content: 'hello' }],
      onChunk
    });

    expect(mockService.loadModel).toHaveBeenCalledWith('some-model');
    expect(mockService.generateText).toHaveBeenCalledWith(
      [{ role: 'user', content: 'hello' }],
      onChunk,
      undefined,
      undefined
    );
  });

  it('should not auto-load if model is already ready', async () => {
    mockService.getState.mockReturnValue({ status: 'ready', activeModelId: 'some-model' });
    mockService.generateText.mockResolvedValue(undefined);

    const { TransformersJsProvider } = await import('./transformers-js-provider');
    const provider = new TransformersJsProvider();

    await provider.chat({
      model: 'some-model',
      messages: [],
      onChunk: () => {}
    });

    expect(mockService.loadModel).not.toHaveBeenCalled();
    expect(mockService.generateText).toHaveBeenCalled();
  });

  it('should throw error if engine is already loading a model', async () => {
    mockService.getState.mockReturnValue({ status: 'loading', activeModelId: null });

    const { TransformersJsProvider } = await import('./transformers-js-provider');
    const provider = new TransformersJsProvider();

    await expect(provider.chat({
      model: 'some-model',
      messages: [],
      onChunk: () => {}
    })).rejects.toThrow('Engine is busy');
  });

  it('should list available models from cache (only complete ones)', async () => {
    mockService.listCachedModels.mockResolvedValue([
      { id: 'model-1', isComplete: true },
      { id: 'model-2', isComplete: false }
    ]);

    const { TransformersJsProvider } = await import('./transformers-js-provider');
    const provider = new TransformersJsProvider();

    const models = await provider.listModels({});
    expect(models).toEqual(['model-1']);
  });
});
