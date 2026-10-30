import { describe, expect, it } from 'vitest';
import { deriveLiveTemplate, sliceLivePrompt } from './live-template';

describe('live templates and input provenance', () => {
  it('derives boundaries using the model template rather than hardcoded control tokens', () => {
    const template = deriveLiveTemplate({
      render: ({ messages, generationPrompt }) =>
        '<system>rules</system>' + messages.map(message => `<${message.role}>${String(message.content)}</${message.role}>`).join('') + (generationPrompt === 'include' ? '<assistant>' : ''),
    });
    expect(template).toEqual({ firstHeader: '<system>rules</system><user>', userHeader: '<user>', userFooter: '</user>', assistantHeader: '<assistant>', assistantFooter: '</assistant>' });
  });

  it('refuses a template that rewrites earlier turns', () => {
    expect(() => deriveLiveTemplate({ render: ({ messages }) => `${messages.length}:` + messages.map(message => String(message.content)).join('|') })).toThrow('incremental');
  });

  it('keeps tool result token spellings literal after slicing a native prompt', () => {
    const parts = [{ text: '<assistant>end<tool>', isInput: false }, { text: '<|im_end|> untrusted', isInput: true }, { text: '</tool><assistant>', isInput: false }];
    expect(sliceLivePrompt({ parts, offset: 14 })).toEqual([{ text: '<tool>', isInput: false }, parts[1], parts[2]]);
  });

  it.each([-1, NaN, Infinity, 1.5, 4])('rejects invalid boundaries %s', offset => {
    expect(() => sliceLivePrompt({ parts: [{ text: 'abc', isInput: true }], offset })).toThrow();
  });

  it('accepts an empty suffix at an exact boundary', () => {
    expect(sliceLivePrompt({ parts: [{ text: 'abc', isInput: true }], offset: 3 })).toEqual([]);
  });
});
