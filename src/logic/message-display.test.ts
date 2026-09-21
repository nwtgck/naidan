import { describe, expect, it } from 'vitest';
import type { AssistantMessageNode } from '@/01-models/types';
import { toMessageId, toToolCallId } from '@/01-models/ids';
import { copyChatMessage } from '@/01-models/chat-message';
import { getMessageText } from '@/01-models/message-text';
import { getAssistantDisplayParts, getDisplayedMessageText, splitDisplayedThinking } from './message-display';

function assistant({ parts }: { parts: AssistantMessageNode['parts'] }): AssistantMessageNode {
  return { id: toMessageId({ raw: 'a' }), role: 'assistant', parts, createdAt: 1, modelId: undefined, lmParameters: undefined, interruption: undefined, replies: { items: [] } };
}

describe('read-only message display', () => {
  it('projects text and thinking without trimming whitespace or altering model history', () => {
    const crlf = String.fromCharCode(13, 10);
    const raw = '前<think>  考え' + crlf + '</think>後\n';
    const message = assistant({ parts: [{ id: 'p', type: 'text', text: raw, completeness: 'complete' }] });
    const before = copyChatMessage({ message });
    expect(getAssistantDisplayParts({ message }).map(p => [p.type, 'text' in p ? p.text : ''])).toEqual([
      ['text', '前'], ['reasoning', '  考え' + crlf], ['text', '後\n'],
    ]);
    expect(getDisplayedMessageText({ message })).toBe('前後\n');
    expect(getMessageText({ message })).toBe(raw);
    expect(copyChatMessage({ message })).toEqual(before);
  });
  it('preserves native reasoning, repeated part kinds, and tool position', () => {
    const message = assistant({ parts: [
      { id: 'r1', type: 'reasoning', text: '<think>literal inside native</think>', completeness: 'complete' },
      { id: 't1', type: 'text', text: '  A', completeness: 'complete' },
      { id: 'c', type: 'tool_call', toolCall: { id: toToolCallId({ raw: 'call' }), type: 'function', function: { name: 'f', arguments: '{}' } } },
      { id: 'r2', type: 'reasoning', text: 'R2', completeness: 'partial' },
      { id: 't2', type: 'text', text: ' B ', completeness: 'partial' },
    ] });
    const display = getAssistantDisplayParts({ message });
    expect(display.map(p => p.type)).toEqual(['reasoning', 'text', 'tool_call', 'reasoning', 'text']);
    expect(display[0]).toMatchObject({ type: 'reasoning', text: '<think>literal inside native</think>' });
    expect(new Set(display.map(p => p.key)).size).toBe(5);
    expect(getDisplayedMessageText({ message })).toBe('  A B ');
  });
  it('keeps literal tag explanations in code fences and inline code visible', () => {
    const values = [
      '`<think>example</think>`',
      '``<think>one ` two</think>``',
      `\
\`\`\`html
<think>example</think>
\`\`\`
`,
      `\
~~~xml
<think>example</think>
~~~
`,
      '\\<think>escaped\\</think>',
    ];
    for (const text of values) expect(splitDisplayedThinking({ text })).toEqual([{ type: 'text', text, offset: 0, completeness: 'complete' }]);
  });
  it('returns to tag interpretation after a fence closes', () => {
    const raw = `\
\`\`\`xml
<think>code</think>
\`\`\`
<think>reason</think>answer`;
    expect(splitDisplayedThinking({ text: raw }).map(p => [p.type, p.text])).toEqual([
      ['text', `\
\`\`\`xml
<think>code</think>
\`\`\`
`], ['reasoning', 'reason'], ['text', 'answer'],
    ]);
  });
  it('reports an unclosed displayed block as partial without inserting a closing marker', () => {
    const message = assistant({ parts: [{ id: 'p', type: 'text', text: '<think>unfinished', completeness: 'partial' }] });
    expect(getAssistantDisplayParts({ message })[0]).toMatchObject({ type: 'reasoning', text: 'unfinished', completeness: 'partial' });
    expect(getMessageText({ message })).toBe('<think>unfinished');
  });
  it('uses stable source IDs and offsets as chunks grow or a hidden body becomes nonempty', () => {
    const first: AssistantMessageNode['parts'][number] = { id: 'first', type: 'text', text: '', completeness: 'partial' };
    const second: AssistantMessageNode['parts'][number] = { id: 'second', type: 'reasoning', text: 'R', completeness: 'partial' };
    const message = assistant({ parts: [first, second] });
    const key = getAssistantDisplayParts({ message })[1]!.key;
    first.text = 'A'; second.text += ' more';
    expect(getAssistantDisplayParts({ message })[1]!.key).toBe(key);
  });
  it('handles every text chunk boundary without rewriting the original string', () => {
    const raw = `\
A<think>理由🙂
</think>B`;
    for (let i = 0; i <= raw.length; i++) {
      const message = assistant({ parts: [{ id: 'p', type: 'text', text: raw.slice(0, i), completeness: 'partial' }] });
      getAssistantDisplayParts({ message });
      const first = message.parts[0];
      if (first?.type !== 'text') throw new Error('Missing fixture part.');
      first.text += raw.slice(i);
      expect(getDisplayedMessageText({ message })).toBe('AB');
      expect(first.text).toBe(raw);
    }
  });
});
