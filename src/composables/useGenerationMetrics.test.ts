import { computed } from 'vue';
import { describe, expect, it } from 'vitest';
import type { AssistantMessageNode, Chat, ToolMessageNode } from '@/01-models/types';
import type { GenerationMetricsPresentation } from '@/01-models/generation-metrics';
import { toChatId, toMessageId, toToolCallId } from '@/01-models/ids';
import { createTokenMetrics } from '@/logic/generation-metrics/measurement';
import { useChatDisplayFlow } from './useChatDisplayFlow';
import { resolveGenerationMetricsHosts } from './useGenerationMetrics';

function node({ id = 'assistant', parts = [] }: { id?: string, parts?: AssistantMessageNode['parts'] } = {}): AssistantMessageNode {
  return { id: toMessageId({ raw: id }), role: 'assistant', parts, createdAt: 1, modelId: undefined, lmParameters: undefined, interruption: undefined, replies: { items: [] } };
}

function presentation(): GenerationMetricsPresentation {
  const metrics = createTokenMetrics({ measurement: 'ollama_eval', nOutputTokens: 20, nMeasuredTokens: 20, durationMs: 1000 })!;
  return { runId: 1, metrics, live: false, updatedAt: 1000, scope: 'last', calls: [{ metrics }] };
}

function flow({ first, leaf = first, processing = false }: { first: AssistantMessageNode, leaf?: AssistantMessageNode, processing?: boolean }) {
  const chat: Chat = { id: toChatId({ raw: 'chat' }), root: { items: [first] }, currentLeafId: leaf.id, title: null, createdAt: 1, updatedAt: 1, debugEnabled: false };
  return useChatDisplayFlow({ chat: computed(() => chat), isProcessing: () => processing, getToolCallDrafts: undefined }).chatFlow.value;
}

describe('one speed host per displayed response', () => {
  it('uses the final answer rather than the earlier thinking section', () => {
    const assistant = node({ parts: [{ type: 'reasoning', text: 'thinking', completeness: 'complete' }, { type: 'text', text: 'answer', completeness: 'complete' }] });
    const items = flow({ first: assistant });
    const hosts = resolveGenerationMetricsHosts({ flow: items, presentations: [{ messageId: assistant.id, presentation: presentation() }] });
    expect(hosts.size).toBe(1);
    const last = items.at(-1);
    expect(last?.type).toBe('message');
    if (last?.type === 'message') {
      expect(hosts.has(last.key)).toBe(true);
      expect(last.mode).toBe('content');
    }
  });

  it('keeps a single completed reasoning section on its normal message footer', () => {
    const assistant = node({ parts: [{ type: 'reasoning', text: 'thinking', completeness: 'complete' }] });
    const items = flow({ first: assistant });
    const hosts = resolveGenerationMetricsHosts({ flow: items, presentations: [{ messageId: assistant.id, presentation: presentation() }] });
    expect(hosts.size).toBe(1);
    const host = items.at(-1);
    if (host?.type !== 'message') {
      throw new Error('Expected standalone thinking message');
    }
    expect(hosts.has(host.key)).toBe(true);
  });

  it('uses the live reasoning footer while that part is still streaming', () => {
    const assistant = node({ parts: [{ type: 'reasoning', text: 'thinking', completeness: 'partial' }] });
    const items = flow({ first: assistant, processing: true });
    const hosts = resolveGenerationMetricsHosts({ flow: items, presentations: [{ messageId: assistant.id, presentation: { ...presentation(), live: true, scope: 'current' } }] });
    expect(hosts.size).toBe(1);
    const host = items.at(-1);
    if (host?.type !== 'message') {
      throw new Error('Expected live message footer');
    }
    expect(host.mode).toBe('thinking');
    expect(hosts.has(host.key)).toBe(true);
  });

  it('uses a single process-header badge when the whole tool-assisted answer is collapsed', () => {
    const first = node({ id: 'first', parts: [{ type: 'tool_call', toolCall: { id: toToolCallId({ raw: 'call' }), type: 'function', function: { name: 'tool', arguments: '{}' } } }] });
    const second = node({ id: 'second', parts: [{ type: 'reasoning', text: 'reasoning only', completeness: 'complete' }] });
    const tool: ToolMessageNode = { id: toMessageId({ raw: 'tool' }), role: 'tool', parts: [{ type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'call' }), status: 'success', content: { type: 'text', text: 'ok' } } }], createdAt: 1, modelId: undefined, lmParameters: undefined, replies: { items: [second] } };
    first.replies.items.push(tool);
    const items = flow({ first, leaf: second });
    const hosts = resolveGenerationMetricsHosts({ flow: items, presentations: [{ messageId: second.id, presentation: presentation() }] });
    expect(items).toHaveLength(1);
    const group = items[0];
    if (group?.type !== 'process_sequence') {
      throw new Error('Expected collapsed process');
    }
    expect(hosts.size).toBe(1);
    expect(hosts.has(group.id)).toBe(true);
  });

  it('keeps a tool-assisted response on the last assistant and never duplicates in nested process items', () => {
    const first = node({ id: 'first', parts: [{ type: 'tool_call', toolCall: { id: toToolCallId({ raw: 'call' }), type: 'function', function: { name: 'tool', arguments: '{}' } } }] });
    const second = node({ id: 'second', parts: [{ type: 'text', text: 'answer', completeness: 'complete' }] });
    const tool: ToolMessageNode = { id: toMessageId({ raw: 'tool' }), role: 'tool', parts: [], createdAt: 1, modelId: undefined, lmParameters: undefined, replies: { items: [second] } };
    first.replies.items.push(tool);
    const items = flow({ first, leaf: second });
    const hosts = resolveGenerationMetricsHosts({ flow: items, presentations: [{ messageId: second.id, presentation: { ...presentation(), scope: 'turn' } }] });
    expect(hosts.size).toBe(1);
    const last = items.at(-1);
    if (last?.type !== 'message') {
      throw new Error('Expected final answer footer');
    }
    expect(last.node.id).toBe(second.id);
    expect(hosts.has(last.key)).toBe(true);
  });
});
