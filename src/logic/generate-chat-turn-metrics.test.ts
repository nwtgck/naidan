import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AssistantMessageNode, ToolMessageNode } from '@/01-models/types';
import type { LmProvider } from '@/01-models/lm';
import type { GenerationMetricsObserver } from '@/01-models/generation-metrics';
import { toMessageId, toToolCallId } from '@/01-models/ids';
import { createTokenMetrics } from './generation-metrics/measurement';
import { generateChatTurn, type ChatGenerationTelemetryEvent } from './generate-chat-turn';

function assistant({ n }: { n: number }): AssistantMessageNode {
  return { id: toMessageId({ raw: `a${n}` }), role: 'assistant', createdAt: n, parts: [], replies: { items: [] }, modelId: 'model', lmParameters: undefined, interruption: undefined };
}

describe('turn-level optional telemetry', () => {
  it('binds every callback to its model call, ignores retired callbacks, and keeps metrics out of persisted nodes', async () => {
    const metrics = createTokenMetrics({ measurement: 'ollama_eval', nOutputTokens: 20, nMeasuredTokens: 20, durationMs: 1000 })!;
    const events: ChatGenerationTelemetryEvent[] = [];
    const nodes: AssistantMessageNode[] = [];
    let firstObserver: GenerationMetricsObserver | undefined;
    let invocation = 0;
    const onChange = vi.fn();
    const provider: LmProvider = {
      listModels: async () => ['model'],
      async *chat({ onGenerationMetrics }) {
        invocation++;
        const before = onChange.mock.calls.length;
        onGenerationMetrics?.({ metrics });
        expect(onChange.mock.calls).toHaveLength(before);
        if (invocation === 1) {
          firstObserver = onGenerationMetrics;
          yield { type: 'tool_call', partId: 'c', index: 0, toolCall: { id: toToolCallId({ raw: 'call' }), type: 'function', function: { name: 'answer', arguments: '{}' } } };
          yield { type: 'result', result: { type: 'finished', next: 'tool_results', generationMetrics: metrics } };
        } else {
          firstObserver?.({ metrics });
          yield { type: 'result', result: { type: 'finished', next: 'user', generationMetrics: metrics } };
        }
      },
    };
    const execute = vi.fn(async () => ({ status: 'success' as const, content: 'ok' }));
    const result = await generateChatTurn({
      provider,
      model: 'model',
      debug: undefined,
      parameters: undefined,
      readBinaryObject: undefined,
      abortController: new AbortController(),
      approvalContext: undefined,
      tools: [{ name: 'answer', description: 'Answer', parametersSchema: z.object({}), execute }],
      createAssistantMessage: () => {
        const node = assistant({ n: nodes.length });
        nodes.push(node);
        return node;
      },
      createToolMessage: () => ({ id: toMessageId({ raw: 'tool' }), role: 'tool', createdAt: 1, parts: [], replies: { items: [] }, modelId: undefined, lmParameters: undefined }) satisfies ToolMessageNode,
      buildMessages: () => [],
      onChange,
      onToolCallDraftsChange: undefined,
      onToolEvent: () => {},
      onGenerationTelemetry: ({ event }) => {
        events.push(event);
      },
      persistToolContent: async ({ text }) => ({ type: 'text', text }),
      describeError: ({ error }) => error.message,
    });
    expect(result).toMatchObject({ type: 'finished', next: 'user', generationMetrics: metrics });
    expect(execute).toHaveBeenCalledOnce();
    expect(events.map(event => [event.type, event.messageId])).toEqual([
      ['started', nodes[0]?.id], ['sample', nodes[0]?.id], ['finished', nodes[0]?.id],
      ['started', nodes[1]?.id], ['sample', nodes[1]?.id], ['finished', nodes[1]?.id],
    ]);
    firstObserver?.({ metrics });
    expect(events).toHaveLength(6);
    expect(JSON.stringify(nodes)).not.toContain('generationMetrics');
    expect(JSON.stringify(nodes)).not.toContain('perSecond');
  });

  it('does not let a throwing telemetry consumer affect a successful answer', async () => {
    const result = await generateChatTurn({
      provider: {
        listModels: async () => [],
        async *chat() {
          yield { type: 'result', result: { type: 'finished', next: 'user' } };
        },
      },
      model: 'model',
      debug: undefined,
      parameters: undefined,
      readBinaryObject: undefined,
      abortController: new AbortController(),
      approvalContext: undefined,
      tools: [],
      createAssistantMessage: () => assistant({ n: 0 }),
      createToolMessage: () => {
        throw new Error('No tool calls');
      },
      buildMessages: () => [],
      onChange: () => {},
      onToolCallDraftsChange: undefined,
      onToolEvent: () => {},
      onGenerationTelemetry: () => {
        throw new Error('display observer');
      },
      persistToolContent: async ({ text }) => ({ type: 'text', text }),
      describeError: ({ error }) => error.message,
    });
    expect(result).toEqual({ type: 'finished', next: 'user' });
  });
});
