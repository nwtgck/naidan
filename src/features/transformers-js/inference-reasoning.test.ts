import { describe, expect, it } from 'vitest';
import type { InferenceMessage } from './types';
import { readCompleteInferenceReasoning } from './inference-reasoning';
import { cloneChatMessages } from './inference-input-snapshot';

describe('structured reasoning at the template boundary', () => {
  it('never derives reasoning from literal body tags', () => {
    const message = { role: 'assistant', content: '<think> R </think>answer' };
    expect(readCompleteInferenceReasoning({ message })).toBeUndefined();
    expect(cloneChatMessages({ messages: [message] })).toEqual([message]);
    expect(Object.hasOwn(cloneChatMessages({ messages: [message] })[0]!, 'reasoning')).toBe(false);
  });

  it.each(['', '  Reason \r\n', '🙂e\u0301', '<think>quoted</think>'])('keeps complete reasoning text exactly: %j', text => {
    const message: InferenceMessage = { role: 'assistant', content: '', reasoning: { text, completeness: 'complete' } };
    expect(readCompleteInferenceReasoning({ message })).toBe(text);
    const snapshot = cloneChatMessages({ messages: [message] })[0]!;
    message.reasoning!.text = 'edited';
    expect(snapshot.reasoning).toEqual({ text, completeness: 'complete' });
    expect(readCompleteInferenceReasoning({ message: snapshot })).toBe(text);
  });

  it('preserves unfinished reasoning through the snapshot and refuses to synthesize its closing frame', () => {
    const message: InferenceMessage = { role: 'assistant', content: [], reasoning: { text: 'unfinished', completeness: 'partial' } };
    const snapshot = cloneChatMessages({ messages: [message] })[0]!;
    expect(snapshot).toEqual(message);
    expect(() => readCompleteInferenceReasoning({ message: snapshot })).toThrow('unfinished');
    expect(message.reasoning?.completeness).toBe('partial');
  });

  it('does not accept reasoning in a nonassistant message', () => {
    for (const role of ['user', 'system', 'tool', 'developer']) {
      expect(() => readCompleteInferenceReasoning({ message: { role, content: '', reasoning: { text: '', completeness: 'complete' } } })).toThrow('Only assistant');
    }
  });

  it('validates worker-side field values instead of treating absent state as complete', () => {
    for (const reasoning of [null, {}, { text: 'R' }, { text: 5, completeness: 'complete' }, { text: 'R', completeness: 'unknown' }]) {
      // Invalid untrusted wire values exercise the runtime boundary.
      // @ts-expect-error Malformed reasoning must not reach the template.
      expect(() => readCompleteInferenceReasoning({ message: { role: 'assistant', content: '', reasoning } })).toThrow();
    }
  });
});

export const TEST_ONLY = {
};
