import { describe, expect, it } from 'vitest';
import { reactive, watch } from 'vue';
import { createAssistantGeneration } from './assistant-generation';
import type { AssistantMessageNode, ToolCall } from './types';
import { toMessageId, toToolCallId } from './ids';

function node(): AssistantMessageNode {
  return { id: toMessageId({ raw: 'new' }), role: 'assistant', createdAt: 17, modelId: undefined, lmParameters: undefined, parts: [], interruption: undefined, replies: { items: [] } };
}
function call({ id }: { id: string }): ToolCall {
  return { id: toToolCallId({ raw: id }), type: 'function', function: { name: 'calculator', arguments: ' { "expression": "17 * 23" } ' } };
}

describe('assistant generation content', () => {
  it('keeps empty parts, original tags, repeated deltas, and reasoning boundaries', () => {
    const message = node(); const state = createAssistantGeneration({ node: message });
    state.beginPart({ partId: 'r1', index: 0, type: 'reasoning' });
    state.appendText({ partId: 'r1', text: ' ' }); state.appendText({ partId: 'r1', text: ' ' });
    state.closePart({ partId: 'r1', completeness: 'complete' });
    state.beginPart({ partId: 'r2', index: 1, type: 'reasoning' });
    state.closePart({ partId: 'r2', completeness: 'complete' });
    state.beginPart({ partId: 'text', index: 2, type: 'text' });
    state.appendText({ partId: 'text', text: `\
<think>literal</think>\\r
🙂` });
    state.closePart({ partId: 'text', completeness: 'complete' });
    state.finish({ result: { type: 'finished', next: 'user' } });
    expect(message.parts).toEqual([
      { id: 'r1', type: 'reasoning', text: '  ', completeness: 'complete' },
      { id: 'r2', type: 'reasoning', text: '', completeness: 'complete' },
      { id: 'text', type: 'text', text: `\
<think>literal</think>\\r
🙂`, completeness: 'complete' },
    ]);
    expect(message.createdAt).toBe(17);
    expect(message.interruption).toBeUndefined();
  });

  it('orders completed calls by position without modifying arguments or keeping mutable aliases', () => {
    const message = node(); const state = createAssistantGeneration({ node: message });
    const second = call({ id: 'B' });
    state.addToolCall({ partId: 'b', index: 4, toolCall: second });
    state.addToolCall({ partId: 'a', index: 1, toolCall: call({ id: 'A' }) });
    second.function.arguments = 'changed';
    state.finish({ result: { type: 'finished', next: 'tool_results' } });
    expect(message.parts.map(part => part.id)).toEqual(['a', 'b']);
    expect(message.parts[1]).toMatchObject({ toolCall: { function: { arguments: ' { "expression": "17 * 23" } ' } } });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('rejects invalid position %s before changing history', index => {
    const message = node(); const state = createAssistantGeneration({ node: message });
    expect(() => state.beginPart({ partId: 'p', index, type: 'text' })).toThrow('position');
    expect(message.parts).toEqual([]);
  });

  it('does not reuse IDs, positions, or completed call IDs', () => {
    const message = node(); const state = createAssistantGeneration({ node: message });
    state.beginPart({ partId: 'p', index: 0, type: 'text' });
    expect(() => state.beginPart({ partId: 'p', index: 1, type: 'text' })).toThrow('part ID');
    expect(() => state.addToolCall({ partId: 'c', index: 0, toolCall: call({ id: 'call' }) })).toThrow('position');
    state.addToolCall({ partId: 'c', index: 1, toolCall: call({ id: 'call' }) });
    expect(() => state.addToolCall({ partId: 'd', index: 2, toolCall: call({ id: 'call' }) })).toThrow('call ID');
    expect(message.parts.map(part => part.id)).toEqual(['p', 'c']);
  });

  it('rejects resumed partial content and prior interruption without altering them', () => {
    const message = node(); message.parts.push({ id: 'p', type: 'text', text: 'prior', completeness: 'partial' });
    expect(() => createAssistantGeneration({ node: message })).toThrow('new assistant');
    expect(message.parts[0]).toMatchObject({ text: 'prior', completeness: 'partial' });
    const empty = node(); empty.interruption = { type: 'cancelled' };
    expect(() => createAssistantGeneration({ node: empty })).toThrow('new assistant');
    expect(empty.interruption).toEqual({ type: 'cancelled' });
  });

  it('prevents repeated close, later deltas, and implicit new parts', () => {
    const message = node(); const state = createAssistantGeneration({ node: message });
    expect(() => state.appendText({ partId: 'missing', text: 'A' })).toThrow('Unknown');
    state.beginPart({ partId: 'p', index: 0, type: 'text' });
    state.appendText({ partId: 'p', text: 'A' });
    state.closePart({ partId: 'p', completeness: 'partial' });
    expect(() => state.appendText({ partId: 'p', text: 'B' })).toThrow('closed');
    expect(() => state.closePart({ partId: 'p', completeness: 'complete' })).toThrow('already closed');
    expect(message.parts[0]).toMatchObject({ text: 'A', completeness: 'partial' });
  });

  it('requires completed text and calls to agree with a successful result', () => {
    const state = createAssistantGeneration({ node: node() });
    expect(() => state.finish({ result: { type: 'finished', next: 'tool_results' } })).toThrow('without a completed call');
    state.beginPart({ partId: 'p', index: 0, type: 'text' });
    expect(() => state.finish({ result: { type: 'finished', next: 'user' } })).toThrow('partial');
    state.closePart({ partId: 'p', completeness: 'complete' });
    state.addToolCall({ partId: 'c', index: 1, toolCall: call({ id: 'C' }) });
    expect(() => state.finish({ result: { type: 'finished', next: 'user' } })).toThrow('require results');
    state.finish({ result: { type: 'finished', next: 'tool_results' } });
    expect(() => state.beginPart({ partId: 'later', index: 2, type: 'text' })).toThrow('already finished');
  });

  it('retains completed calls and open partial text on interruption without inventing a cause', () => {
    const message = node(); const state = createAssistantGeneration({ node: message });
    state.beginPart({ partId: 'p', index: 0, type: 'text' });
    state.appendText({ partId: 'p', text: 'received' });
    state.addToolCall({ partId: 'c', index: 2, toolCall: call({ id: 'C' }) });
    state.finish({ result: { type: 'interrupted', reason: 'aborted' } });
    expect(message.parts[0]).toMatchObject({ text: 'received', completeness: 'partial' });
    expect(message.parts[1]?.type).toBe('tool_call');
    expect(message.interruption).toBeUndefined();
  });

  it('uses the reactive history node for every mutation', () => {
    const message = reactive(node()); const state = createAssistantGeneration({ node: message });
    const observations: string[] = [];
    const stop = watch(() => message.parts.filter(part => part.type === 'text').map(part => `${part.text}:${part.completeness}`).join(''), text => observations.push(text), { flush: 'sync' });
    state.beginPart({ partId: 'p', index: 0, type: 'text' });
    state.appendText({ partId: 'p', text: 'A' });
    state.closePart({ partId: 'p', completeness: 'complete' });
    stop();
    expect(observations).toEqual([':partial', 'A:partial', 'A:complete']);
  });
});
