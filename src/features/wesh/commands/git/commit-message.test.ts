import { describe, expect, it } from 'vitest';
import { appendMessageParagraph, cleanupMessage } from '@/features/wesh/commands/git/commit-message';

describe('git message paragraph cleanup', () => {
  it('joins repeated message values as paragraphs before cleanup', () => {
    const first = appendMessageParagraph({ current: undefined, value: 'one' });
    const second = appendMessageParagraph({ current: first, value: 'two' });
    expect(second).toBe(`\
one

two`);
  });

  it('removes leading and trailing blank paragraphs and collapses blank runs', () => {
    expect(cleanupMessage({ text: `\


 one  



 two 

` })).toBe(`\
 one

 two`);
  });

  it('normalizes whitespace-only messages to empty', () => {
    expect(cleanupMessage({ text: `\
  
	
` })).toBe('');
  });
});
