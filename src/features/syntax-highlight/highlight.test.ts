import { describe, expect, it } from 'vitest';
import { createSyntaxHighlighter } from './highlight';

function highlightSyntax({ code, language }: { code: string, language: 'shell' | 'plain' }) {
  return createSyntaxHighlighter({ language }).update({ edit: { offset: 0, text: code } }).tokens;
}

describe('highlightSyntax', () => {
  it('uses shell highlighting only when explicitly selected', () => {
    const code = 'echo "$HOME"';
    expect(highlightSyntax({ code, language: 'plain' })).toEqual([{ kind: 'plain', text: code }]);
    expect(highlightSyntax({ code: '', language: 'plain' })).toEqual([]);
    expect(highlightSyntax({ code, language: 'shell' })[0]).toEqual({ kind: 'command', text: 'echo' });
  });
});
