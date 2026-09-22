import { describe, expect, it } from 'vitest';
import type { InferenceGenerationEvent } from '@/features/transformers-js/generation-events';
import type { WorkerToolDefinition } from '@/features/transformers-js/types';
import type { StandardToolHandling } from '@/features/transformers-js/standard-tool-call-protocol';
import { createLfm2Generation, formatLfm2MessagesForToolHandling, formatMessagesForLfm2ReasoningProtocol } from './lfm2-generation';

const handling: StandardToolHandling = {
  outputProtocol: 'delimited-pythonic',
  historyEncoding: 'native-template',
  preservedDelimiterIds: [],
};
const tools: WorkerToolDefinition[] = [{
  type: 'function',
  function: { name: 'lookup_weather', description: '', parameters: { type: 'object' } },
}];

function setup({ declarations }: { declarations: WorkerToolDefinition[] | undefined }) {
  const events: InferenceGenerationEvent[] = [];
  const codec = createLfm2Generation({
    emit: ({ event }) => events.push(event),
    endTokens: ['<|im_end|>'],
    handling,
    tools: declarations,
  });
  return { codec, events };
}

describe('LFM2 prompt-open structured generation', () => {
  it('maps structured reasoning history to the native template field without parsing content tags', () => {
    expect(formatLfm2MessagesForToolHandling({ handling, messages: [
      { role: 'user', content: '<think>literal user text</think>' },
      { role: 'assistant', content: 'visible', reasoning: { text: 'private', completeness: 'complete' } },
    ] })).toEqual([
      { role: 'user', content: '<think>literal user text</think>' },
      { role: 'assistant', content: 'visible', reasoning: 'private' },
    ]);
    expect(() => formatLfm2MessagesForToolHandling({ handling, messages: [
      { role: 'user', content: '', reasoning: { text: 'invalid', completeness: 'complete' } },
    ] })).toThrow(/assistant/);
    expect(() => formatLfm2MessagesForToolHandling({ handling, messages: [
      { role: 'assistant', content: '', reasoning: { text: 'unfinished', completeness: 'partial' } },
    ] })).toThrow(/partial reasoning/);
  });

  it('leaves LFM2 generated-output messages on the shared standard formatter route', () => {
    const messages = [{ role: 'assistant', content: '<think>literal text</think>' }];
    expect(formatLfm2MessagesForToolHandling({ handling, messages })).toEqual(messages);
    expect(formatLfm2MessagesForToolHandling({ handling: { ...handling, historyEncoding: 'verified-content' }, messages })).toEqual(messages);
  });

  it('enables reasoning history only for an observed LFM2 prompt-open template', () => {
    const messages = [{ role: 'assistant' as const, content: 'visible', reasoning: { text: 'private', completeness: 'complete' as const } }];
    expect(formatMessagesForLfm2ReasoningProtocol({
      messages, handling, modelType: 'lfm2', reasoningProtocol: 'prompt-open-think',
    })).toEqual([{ role: 'assistant', content: 'visible', reasoning: 'private' }]);
    expect(() => formatMessagesForLfm2ReasoningProtocol({
      messages, handling, modelType: 'lfm2', reasoningProtocol: 'generated-output',
    })).toThrow(/reviewed model-specific template adapter/);
    expect(() => formatMessagesForLfm2ReasoningProtocol({
      messages, handling, modelType: 'other', reasoningProtocol: 'prompt-open-think',
    })).toThrow(/reviewed model-specific template adapter/);
  });

  it('keeps reasoning and visible text as ordered parts with distinct indices', () => {
    const { codec, events } = setup({ declarations: undefined });
    codec.text({ text: 'private analysis' });
    codec.control({ token: '</think>' });
    codec.text({ text: 'visible answer' });
    codec.control({ token: '<|im_end|>' });
    codec.finish({ reason: 'unknown' });
    expect(events).toEqual([
      { type: 'part_start', index: 0, kind: 'reasoning' },
      { type: 'text_delta', index: 0, text: 'private analysis' },
      { type: 'part_end', index: 0, completeness: 'complete' },
      { type: 'part_start', index: 1, kind: 'text' },
      { type: 'text_delta', index: 1, text: 'visible answer' },
      { type: 'part_end', index: 1, completeness: 'complete' },
      { type: 'result', result: { type: 'finished', next: 'user' } },
    ]);
  });

  it('delegates the recorded Pythonic tool frame after reasoning without reusing index zero', () => {
    const { codec, events } = setup({ declarations: tools });
    codec.text({ text: 'I need the weather.' });
    codec.control({ token: '</think>' });
    codec.control({ token: '<|tool_call_start|>' });
    codec.text({ text: "[lookup_weather(city='Tokyo')]" });
    codec.control({ token: '<|tool_call_end|>' });
    codec.control({ token: '<|im_end|>' });
    codec.finish({ reason: 'unknown' });
    expect(events.filter(event => event.type === 'part_start')).toEqual([
      { type: 'part_start', index: 0, kind: 'reasoning' },
    ]);
    expect(events.filter(event => event.type === 'tool_start')).toEqual([{ type: 'tool_start', index: 1 }]);
    expect(events.filter(event => event.type === 'tool_call')).toMatchObject([{
      type: 'tool_call', index: 1,
      toolCall: { type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' } },
    }]);
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'finished', next: 'tool_results' } });
  });

  it.each(['aborted', 'limit', 'unknown'] as const)('retains unfinished reasoning as partial without adding a close marker (%s)', reason => {
    const { codec, events } = setup({ declarations: undefined });
    codec.text({ text: 'unfinished </thi' });
    codec.finish({ reason });
    expect(events).toEqual([
      { type: 'part_start', index: 0, kind: 'reasoning' },
      { type: 'text_delta', index: 0, text: 'unfinished </thi' },
      { type: 'part_end', index: 0, completeness: 'partial' },
      { type: 'result', result: { type: 'interrupted', reason } },
    ]);
  });

  it('preserves marker-looking ordinary text and recognizes only native controls', () => {
    const { codec, events } = setup({ declarations: undefined });
    codec.text({ text: '<think>literal</think>' });
    codec.finish({ reason: 'limit' });
    expect(events.find(event => event.type === 'text_delta')).toEqual({
      type: 'text_delta', index: 0, text: '<think>literal</think>',
    });
  });

  it('handles empty reasoning and a terminal-only body without synthesizing text', () => {
    const { codec, events } = setup({ declarations: undefined });
    codec.control({ token: '</think>' });
    codec.control({ token: '<|im_end|>' });
    codec.finish({ reason: 'unknown' });
    expect(events).toEqual([
      { type: 'part_start', index: 0, kind: 'reasoning' },
      { type: 'part_end', index: 0, completeness: 'complete' },
      { type: 'part_start', index: 1, kind: 'text' },
      { type: 'part_end', index: 1, completeness: 'complete' },
      { type: 'result', result: { type: 'finished', next: 'user' } },
    ]);
  });

  it('keeps a native end inside reasoning incomplete and rejects misplaced reasoning controls', () => {
    const ended = setup({ declarations: undefined });
    ended.codec.control({ token: '<|im_end|>' });
    ended.codec.finish({ reason: 'unknown' });
    expect(ended.events).toEqual([
      { type: 'part_start', index: 0, kind: 'reasoning' },
      { type: 'part_end', index: 0, completeness: 'partial' },
      { type: 'result', result: { type: 'interrupted', reason: 'unknown' } },
    ]);

    const misplaced = setup({ declarations: undefined });
    expect(() => misplaced.codec.control({ token: '<think>' })).toThrow(/inside LFM2 reasoning/);
    misplaced.codec.control({ token: '</think>' });
    expect(() => misplaced.codec.control({ token: '<think>' })).toThrow(/Misplaced/);
  });
});
