import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { ToolCall } from '@/models/types';

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

/**
 * Helper to set up a generateText mock that optionally fires tool calls on the first call.
 * - On the first call: calls onToolCalls with the given toolCalls (if any)
 * - On subsequent calls: no tool calls (simulates final text response)
 */
function setupGenerateTextMock(toolCallsOnFirstCall: ToolCall[] = []) {
  let callCount = 0;
  mockService.generateText.mockImplementation(
    async (
      _messages: unknown,
      _onChunk: (chunk: string) => void,
      onToolCalls: (toolCalls: ToolCall[]) => void
    ) => {
      callCount++;
      if (callCount === 1 && toolCallsOnFirstCall.length > 0) {
        onToolCalls(toolCallsOnFirstCall);
      }
    }
  );
}

describe('TransformersJsProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should auto-load model if not already ready', async () => {
    mockService.getState.mockReturnValue({ status: 'idle', activeModelId: null });
    mockService.loadModel.mockResolvedValue(undefined);
    setupGenerateTextMock();

    const { TransformersJsProvider } = await import('./transformers-js-provider');
    const provider = new TransformersJsProvider();

    await provider.chat({
      model: 'some-model',
      messages: [{ role: 'user', content: 'hello' }],
      onChunk: vi.fn(),
    });

    expect(mockService.loadModel).toHaveBeenCalledWith('some-model');
    expect(mockService.generateText).toHaveBeenCalledOnce();
    expect(mockService.generateText.mock.calls[0]![0]).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('should not auto-load if model is already ready', async () => {
    mockService.getState.mockReturnValue({ status: 'ready', activeModelId: 'some-model' });
    setupGenerateTextMock();

    const { TransformersJsProvider } = await import('./transformers-js-provider');
    const provider = new TransformersJsProvider();

    await provider.chat({
      model: 'some-model',
      messages: [],
      onChunk: () => {},
    });

    expect(mockService.loadModel).not.toHaveBeenCalled();
    expect(mockService.generateText).toHaveBeenCalledOnce();
  });

  it('should throw error if engine is already loading a model', async () => {
    mockService.getState.mockReturnValue({ status: 'loading', activeModelId: null });

    const { TransformersJsProvider } = await import('./transformers-js-provider');
    const provider = new TransformersJsProvider();

    await expect(provider.chat({
      model: 'some-model',
      messages: [],
      onChunk: () => {},
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

  describe('tool calling', () => {
    const makeTool = (name: string) => ({
      name,
      description: `Does ${name}`,
      parametersSchema: z.object({ input: z.string() }),
      execute: vi.fn().mockResolvedValue({ status: 'success' as const, content: `result of ${name}` }),
    });

    it('should execute a tool call and loop back for the final response', async () => {
      mockService.getState.mockReturnValue({ status: 'ready', activeModelId: 'model' });

      const toolCall: ToolCall = {
        id: 'call_1',
        type: 'function',
        function: { name: 'my_tool', arguments: '{"input":"hello"}' },
      };
      setupGenerateTextMock([toolCall]);

      const tool = makeTool('my_tool');
      const onToolCall = vi.fn();
      const onToolResult = vi.fn();

      const { TransformersJsProvider } = await import('./transformers-js-provider');
      const provider = new TransformersJsProvider();

      await provider.chat({
        model: 'model',
        messages: [{ role: 'user', content: 'test' }],
        onChunk: vi.fn(),
        tools: [tool],
        onToolCall,
        onToolResult,
      });

      // Two generateText calls: first returns tool call, second returns final answer
      expect(mockService.generateText).toHaveBeenCalledTimes(2);

      // Tool was called with validated args
      expect(tool.execute).toHaveBeenCalledWith({ args: { input: 'hello' }, signal: undefined });
      expect(onToolCall).toHaveBeenCalledWith({ id: 'call_1', toolName: 'my_tool', args: { input: 'hello' } });
      expect(onToolResult).toHaveBeenCalledWith({ id: 'call_1', result: { status: 'success', content: 'result of my_tool' } });

      // Second call includes tool result message
      const secondCallMessages = mockService.generateText.mock.calls[1]![0];
      expect(secondCallMessages).toContainEqual(
        expect.objectContaining({ role: 'tool', tool_call_id: 'call_1', content: 'result of my_tool' })
      );
    });

    it('should report an error when the tool is not found', async () => {
      mockService.getState.mockReturnValue({ status: 'ready', activeModelId: 'model' });

      const toolCall: ToolCall = {
        id: 'call_unknown',
        type: 'function',
        function: { name: 'nonexistent_tool', arguments: '{}' },
      };
      setupGenerateTextMock([toolCall]);

      const onToolResult = vi.fn();

      const { TransformersJsProvider } = await import('./transformers-js-provider');
      const provider = new TransformersJsProvider();

      await provider.chat({
        model: 'model',
        messages: [{ role: 'user', content: 'test' }],
        onChunk: vi.fn(),
        tools: [],
        onToolResult,
      });

      expect(onToolResult).toHaveBeenCalledWith({
        id: 'call_unknown',
        result: { status: 'error', code: 'other', message: 'Tool "nonexistent_tool" not found.' },
      });
      // Error is sent back to the model
      const secondCallMessages = mockService.generateText.mock.calls[1]![0];
      expect(secondCallMessages).toContainEqual(
        expect.objectContaining({ role: 'tool', tool_call_id: 'call_unknown' })
      );
    });

    it('should report invalid_arguments when tool call JSON cannot be parsed', async () => {
      mockService.getState.mockReturnValue({ status: 'ready', activeModelId: 'model' });

      const toolCall: ToolCall = {
        id: 'call_bad_json',
        type: 'function',
        function: { name: 'my_tool', arguments: 'not valid json' },
      };
      setupGenerateTextMock([toolCall]);

      const tool = makeTool('my_tool');
      const onToolCall = vi.fn();
      const onToolResult = vi.fn();

      const { TransformersJsProvider } = await import('./transformers-js-provider');
      const provider = new TransformersJsProvider();

      await provider.chat({
        model: 'model',
        messages: [{ role: 'user', content: 'test' }],
        onChunk: vi.fn(),
        tools: [tool],
        onToolCall,
        onToolResult,
      });

      expect(onToolResult).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'call_bad_json',
          result: expect.objectContaining({ status: 'error', code: 'invalid_arguments' }),
        })
      );
      expect(onToolCall).not.toHaveBeenCalled();
      expect(tool.execute).not.toHaveBeenCalled();
    });

    it('should forward tool execution error back to the model', async () => {
      mockService.getState.mockReturnValue({ status: 'ready', activeModelId: 'model' });

      const toolCall: ToolCall = {
        id: 'call_err',
        type: 'function',
        function: { name: 'failing_tool', arguments: '{"input":"x"}' },
      };
      setupGenerateTextMock([toolCall]);

      const tool = makeTool('failing_tool');
      tool.execute.mockResolvedValue({ status: 'error' as const, code: 'execution_failed' as const, message: 'something broke' });
      const onToolResult = vi.fn();

      const { TransformersJsProvider } = await import('./transformers-js-provider');
      const provider = new TransformersJsProvider();

      await provider.chat({
        model: 'model',
        messages: [{ role: 'user', content: 'test' }],
        onChunk: vi.fn(),
        tools: [tool],
        onToolResult,
      });

      expect(onToolResult).toHaveBeenCalledWith({
        id: 'call_err',
        result: { status: 'error', code: 'execution_failed', message: 'something broke' },
      });
      const secondCallMessages = mockService.generateText.mock.calls[1]![0];
      expect(secondCallMessages).toContainEqual(
        expect.objectContaining({ role: 'tool', content: 'Error [execution_failed]: something broke' })
      );
    });

    it('should stop after abort before the second generation', async () => {
      mockService.getState.mockReturnValue({ status: 'ready', activeModelId: 'model' });

      const toolCall: ToolCall = {
        id: 'call_abort',
        type: 'function',
        function: { name: 'my_tool', arguments: '{"input":"x"}' },
      };

      const controller = new AbortController();
      let callCount = 0;
      mockService.generateText.mockImplementation(
        async (
          _messages: unknown,
          _onChunk: (chunk: string) => void,
          onToolCalls: (toolCalls: ToolCall[]) => void
        ) => {
          callCount++;
          if (callCount === 1) {
            onToolCalls([toolCall]);
            controller.abort(); // abort during tool execution phase
          }
        }
      );

      const tool = makeTool('my_tool');

      const { TransformersJsProvider } = await import('./transformers-js-provider');
      const provider = new TransformersJsProvider();

      await expect(provider.chat({
        model: 'model',
        messages: [{ role: 'user', content: 'test' }],
        onChunk: vi.fn(),
        tools: [tool],
        signal: controller.signal,
      })).rejects.toThrow('Generation aborted');

      expect(mockService.generateText).toHaveBeenCalledOnce();
    });
  });
});
