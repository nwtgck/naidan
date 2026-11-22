import { describe, expect, it } from 'vitest';
import { createSyntaxHighlighter } from './highlight';
import type { SyntaxLanguage } from './types';

function highlightSyntax({ code, language }: { code: string, language: SyntaxLanguage }) {
  return createSyntaxHighlighter({ language }).update({ edit: { offset: 0, text: code } }).tokens;
}

describe('highlightSyntax', () => {
  it('uses shell highlighting only when explicitly selected', () => {
    const code = 'echo "$HOME"';
    expect(highlightSyntax({ code, language: 'plain' })).toEqual([{ kind: 'plain', text: code }]);
    expect(highlightSyntax({ code: '', language: 'plain' })).toEqual([]);
    expect(highlightSyntax({ code, language: 'shell' })[0]).toEqual({ kind: 'command', text: 'echo' });
  });

  it('keeps source intact when highlighting JavaScript strings, comments, and keywords', () => {
    const code = `\
const url = "https://example.com"; // reference
/* A multi-line
   comment */
`;
    const tokens = highlightSyntax({ code, language: 'javascript' });
    expect(tokens.map(token => token.text).join('')).toBe(code);
    expect(tokens).toContainEqual({ kind: 'keyword', text: 'const' });
    expect(tokens).toContainEqual({ kind: 'string', text: '"https://example.com"' });
    expect(tokens).toContainEqual({ kind: 'comment', text: '// reference' });
    expect(tokens).toContainEqual({
      kind: 'comment',
      text: `\
/* A multi-line
   comment */`,
    });
  });

  it('recomputes tokens when a TypeScript source suffix changes', () => {
    const highlighter = createSyntaxHighlighter({ language: 'typescript' });
    const prefix = 'type Name = ';
    highlighter.update({ edit: { offset: 0, text: prefix + 'string' } });
    const edit = highlighter.update({ edit: { offset: prefix.length, text: 'boolean' } });
    expect(edit.offset).toBe(0);
    expect(edit.tokens.map(token => token.text).join('')).toBe(prefix + 'boolean');
    expect(edit.tokens).toContainEqual({ kind: 'keyword', text: 'boolean' });
  });
});
