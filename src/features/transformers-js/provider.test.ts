import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { Tool } from '@/01-models/tool';
import type { ToolCall } from '@/01-models/types';
import { toToolCallId } from '@/01-models/ids';
import { runProviderConversationForTest } from '@/features/lm/provider-test-support';
import type { TransformersJsInferenceScope } from './inference-operation';
import { runProviderTestInferenceOperation } from './provider-inference-test-scope';
import type { TransformersJsInferenceOperation } from './inference-operation';

// Mock the service
const mockService = {
  getState: vi.fn(),
  loadDownloadedModel: vi.fn(),
  generateText: vi.fn().mockRejectedValue(new Error('Legacy generation must not be used.')),
  generateMessage: vi.fn<({ messages, onEvent, params, tools, continuationOwner, signal }: Parameters<TransformersJsInferenceScope['generateMessage']>[0] & { signal: AbortSignal }) => Promise<void>>(),
  listCachedModels: vi.fn(),
  runInferenceOperation(args: TransformersJsInferenceOperation) {
    return runProviderTestInferenceOperation({ ...args, service: mockService });
  },
};

vi.mock('./index', () => ({
  transformersJsService: mockService,
}));

// Synthetic generation events, not decoded text or model-output evidence.
function setupGenerationMock({ toolCalls }: { toolCalls: ToolCall[] }) {
  let callCount = 0;
  mockService.generateMessage.mockImplementation(async ({ onEvent }) => {
    callCount++;
    const calls = callCount === 1 ? toolCalls : [];
    for (const [index, toolCall] of calls.entries()) {
      await onEvent({ event: { type: 'tool_start', index } });
      await onEvent({ event: { type: 'tool_call', index, toolCall } });
    }
    await onEvent({ event: { type: 'result', result: { type: 'finished', next: calls.length ? 'tool_results' : 'user' } } });
  });
}

describe('TransformersJsProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should auto-load model if not already ready', async () => {
    mockService.getState.mockReturnValue({ status: 'idle', activeModelId: undefined });
    mockService.loadDownloadedModel.mockResolvedValue(undefined);
    setupGenerationMock({ toolCalls: [] });

    const { TransformersJsProvider } = await import('./provider');
    const provider = new TransformersJsProvider();

    await runProviderConversationForTest({
      provider,
      model: 'some-model',
      messages: [{ role: 'user', content: 'hello' }],
      onChunk: vi.fn(),
    });

    expect(mockService.loadDownloadedModel).toHaveBeenCalledWith({ modelId: 'some-model' });
    expect(mockService.generateMessage).toHaveBeenCalledOnce();
    expect(mockService.generateMessage.mock.calls[0]![0].messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('should not auto-load if model is already ready', async () => {
    mockService.getState.mockReturnValue({ status: 'ready', activeModelId: 'some-model' });
    setupGenerationMock({ toolCalls: [] });

    const { TransformersJsProvider } = await import('./provider');
    const provider = new TransformersJsProvider();

    await runProviderConversationForTest({
      provider,
      model: 'some-model',
      messages: [],
      onChunk: () => {},
    });

    expect(mockService.loadDownloadedModel).not.toHaveBeenCalled();
    expect(mockService.generateMessage).toHaveBeenCalledOnce();
  });

  it('should throw error if engine is already loading a model', async () => {
    mockService.getState.mockReturnValue({ status: 'loading', activeModelId: undefined });

    const { TransformersJsProvider } = await import('./provider');
    const provider = new TransformersJsProvider();

    await expect(runProviderConversationForTest({
      provider,
      model: 'some-model',
      messages: [],
      onChunk: () => {},
    })).rejects.toThrow('Engine is busy');
  });

  it('should list available models from cache (only complete ones)', async () => {
    mockService.listCachedModels.mockResolvedValue([
      { id: 'model-1', isComplete: true },
      { id: 'model-2', isComplete: false },
    ]);

    const { TransformersJsProvider } = await import('./provider');
    const provider = new TransformersJsProvider();

    const models = await provider.listModels({ signal: undefined });
    expect(models).toEqual(['model-1']);
  });

  describe('tool calling', () => {
    const makeTool = ({ name }: { name: string }) => ({
      name,
      description: `Does ${name}`,
      parametersSchema: z.object({ input: z.string() }),
      execute: vi.fn<Tool['execute']>().mockResolvedValue({ status: 'success' as const, content: `result of ${name}` }),
    });

    it('should execute a tool call and loop back for the final response', async () => {
      mockService.getState.mockReturnValue({ status: 'ready', activeModelId: 'model' });

      const toolCall: ToolCall = {
        id: toToolCallId({ raw: 'call_1' }),
        type: 'function',
        function: { name: 'my_tool', arguments: '{"input":"hello"}' },
      };
      setupGenerationMock({ toolCalls: [toolCall] });

      const tool = makeTool({ name: 'my_tool' });
      const onToolCall = vi.fn();
      const onToolResult = vi.fn();

      const { TransformersJsProvider } = await import('./provider');
      const provider = new TransformersJsProvider();

      await runProviderConversationForTest({
        provider,
        model: 'model',
        messages: [{ role: 'user', content: 'test' }],
        onChunk: vi.fn(),
        tools: [tool],
        onToolCall,
        onToolResult,
      });

      // The shared runner performs two generations; the Provider never executes tools.
      expect(mockService.generateMessage).toHaveBeenCalledTimes(2);

      // Tool was called with validated args
      expect(tool.execute).toHaveBeenCalledWith(expect.objectContaining({ args: { input: 'hello' }, signal: expect.any(AbortSignal) }));
      expect(onToolCall).toHaveBeenCalledWith({
        id: 'call_1',
        toolName: 'my_tool',
        modelVisibleArguments: '{"input":"hello"}',
      });
      expect(onToolResult).toHaveBeenCalledWith({ id: 'call_1', result: { status: 'success', content: 'result of my_tool' } });

      // Second call includes tool result message
      const secondCallMessages = mockService.generateMessage.mock.calls[1]![0].messages;
      expect(secondCallMessages).toContainEqual(
        expect.objectContaining({ role: 'tool', tool_call_id: 'call_1', content: 'result of my_tool' }),
      );
    });

    it('should execute multiple tool calls before continuing generation', async () => {
      mockService.getState.mockReturnValue({ status: 'ready', activeModelId: 'model' });

      const toolCalls: ToolCall[] = [
        {
          id: toToolCallId({ raw: 'call_workspace' }),
          type: 'function',
          function: { name: 'shell_execute', arguments: '{"shell_script":"ls -la /workspace"}' },
        },
        {
          id: toToolCallId({ raw: 'call_tmp' }),
          type: 'function',
          function: { name: 'shell_execute', arguments: '{"shell_script":"ls -la /tmp"}' },
        },
      ];
      setupGenerationMock({ toolCalls });

      const execute = vi.fn(async ({ args }: { args: { shell_script: string } }) => ({
        status: 'success' as const,
        content: `result for ${args.shell_script}`,
      }));
      const tool = {
        name: 'shell_execute',
        description: 'Run shell',
        parametersSchema: z.object({ shell_script: z.string() }),
        execute,
      };

      const { TransformersJsProvider } = await import('./provider');
      const provider = new TransformersJsProvider();
      await runProviderConversationForTest({
        provider,
        model: 'model',
        messages: [{ role: 'user', content: 'Use shell tools.' }],
        onChunk: vi.fn(),
        tools: [tool],
      });

      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls.map(([request]) => request.args)).toEqual([
        { shell_script: 'ls -la /workspace' },
        { shell_script: 'ls -la /tmp' },
      ]);
      expect(mockService.generateMessage).toHaveBeenCalledTimes(2);
      const continuationMessages = mockService.generateMessage.mock.calls[1]![0].messages;
      const assistant = continuationMessages.find(message => message.role === 'assistant');
      expect(assistant?.tool_calls).toEqual(toolCalls);
      expect(continuationMessages.filter(message => message.role === 'tool')).toEqual([
        expect.objectContaining({ tool_call_id: 'call_workspace', content: 'result for ls -la /workspace' }),
        expect.objectContaining({ tool_call_id: 'call_tmp', content: 'result for ls -la /tmp' }),
      ]);
    });

    it('should report an error when the tool is not found', async () => {
      mockService.getState.mockReturnValue({ status: 'ready', activeModelId: 'model' });

      const toolCall: ToolCall = {
        id: toToolCallId({ raw: 'call_unknown' }),
        type: 'function',
        function: { name: 'nonexistent_tool', arguments: '{}' },
      };
      setupGenerationMock({ toolCalls: [toolCall] });

      const onToolCall = vi.fn();
      const onToolResult = vi.fn();

      const { TransformersJsProvider } = await import('./provider');
      const provider = new TransformersJsProvider();

      await runProviderConversationForTest({
        provider,
        model: 'model',
        messages: [{ role: 'user', content: 'test' }],
        onChunk: vi.fn(),
        tools: [],
        onToolCall,
        onToolResult,
      });

      expect(onToolCall).toHaveBeenCalledWith({
        id: 'call_unknown',
        toolName: 'nonexistent_tool',
        modelVisibleArguments: '{}',
      });
      expect(onToolResult).toHaveBeenCalledWith({
        id: 'call_unknown',
        result: { status: 'error', code: 'other', message: 'Tool "nonexistent_tool" not found.' },
      });
      // Error is sent back to the model
      const secondCallMessages = mockService.generateMessage.mock.calls[1]![0].messages;
      expect(secondCallMessages).toContainEqual(
        expect.objectContaining({ role: 'tool', tool_call_id: 'call_unknown' }),
      );
    });

    it('should report invalid_arguments when tool call JSON cannot be parsed', async () => {
      mockService.getState.mockReturnValue({ status: 'ready', activeModelId: 'model' });

      const toolCall: ToolCall = {
        id: toToolCallId({ raw: 'call_bad_json' }),
        type: 'function',
        function: { name: 'my_tool', arguments: 'not valid json' },
      };
      setupGenerationMock({ toolCalls: [toolCall] });

      const tool = makeTool({ name: 'my_tool' });
      const onToolCall = vi.fn();
      const onToolResult = vi.fn();

      const { TransformersJsProvider } = await import('./provider');
      const provider = new TransformersJsProvider();

      await runProviderConversationForTest({
        provider,
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
        }),
      );
      expect(onToolCall).toHaveBeenCalledWith({
        id: 'call_bad_json',
        toolName: 'my_tool',
        modelVisibleArguments: 'not valid json',
      });
      expect(tool.execute).not.toHaveBeenCalled();
    });

    it('should forward tool execution error back to the model', async () => {
      mockService.getState.mockReturnValue({ status: 'ready', activeModelId: 'model' });

      const toolCall: ToolCall = {
        id: toToolCallId({ raw: 'call_err' }),
        type: 'function',
        function: { name: 'failing_tool', arguments: '{"input":"x"}' },
      };
      setupGenerationMock({ toolCalls: [toolCall] });

      const tool = makeTool({ name: 'failing_tool' });
      tool.execute.mockResolvedValue({ status: 'error' as const, code: 'execution_failed' as const, message: 'something broke' });
      const onToolResult = vi.fn();

      const { TransformersJsProvider } = await import('./provider');
      const provider = new TransformersJsProvider();

      await runProviderConversationForTest({
        provider,
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
      const secondCallMessages = mockService.generateMessage.mock.calls[1]![0].messages;
      expect(secondCallMessages).toContainEqual(
        expect.objectContaining({ role: 'tool', content: 'Error [execution_failed]: something broke' }),
      );
    });

    it('should stop after abort before the second generation', async () => {
      mockService.getState.mockReturnValue({ status: 'ready', activeModelId: 'model' });

      const toolCall: ToolCall = {
        id: toToolCallId({ raw: 'call_abort' }),
        type: 'function',
        function: { name: 'my_tool', arguments: '{"input":"x"}' },
      };

      const controller = new AbortController();
      mockService.generateMessage.mockImplementation(async ({ onEvent }) => {
        await onEvent({ event: { type: 'tool_start', index: 0 } });
        await onEvent({ event: { type: 'tool_call', index: 0, toolCall } });
        controller.abort();
        await onEvent({ event: { type: 'result', result: { type: 'interrupted', reason: 'aborted' } } });
      });

      const tool = makeTool({ name: 'my_tool' });

      const { TransformersJsProvider } = await import('./provider');
      const provider = new TransformersJsProvider();

      await expect(runProviderConversationForTest({
        provider,
        model: 'model',
        messages: [{ role: 'user', content: 'test' }],
        onChunk: vi.fn(),
        tools: [tool],
        signal: controller.signal,
      })).rejects.toThrow('Generation aborted');

      expect(mockService.generateMessage).toHaveBeenCalledOnce();
      expect(tool.execute).not.toHaveBeenCalled();
    });
  });
});
