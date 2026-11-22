import type { SyntaxHighlighter, SyntaxLanguage, SyntaxToken, SyntaxTokenKind } from './types';

const javascriptKeywords = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if',
  'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'static', 'super', 'switch',
  'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield',
]);
const typescriptKeywords = new Set([
  'abstract', 'any', 'as', 'asserts', 'bigint', 'boolean', 'declare', 'enum', 'implements', 'infer',
  'interface', 'is', 'keyof', 'module', 'namespace', 'never', 'number', 'object', 'override',
  'private', 'protected', 'public', 'readonly', 'satisfies', 'string', 'symbol', 'type', 'unknown',
]);

// Incomplete strings and comments are common when a patch omits nearby lines.
// Match the text that is available without requiring a complete program.
const lexicalToken = /(?<comment>\/\/[^\r\n\u2028\u2029]*|\/\*[\s\S]*?(?:\*\/|$))|(?<string>"(?:\\(?:\r\n|[\s\S])|[^"\\\r\n\u2028\u2029])*"?|'(?:\\(?:\r\n|[\s\S])|[^'\\\r\n\u2028\u2029])*'?|`(?:\\[\s\S]|[^`\\])*`?)|(?<word>[$_\p{ID_Start}][$_\p{ID_Continue}\u200C\u200D]*)|(?<operator>[=<>!&|+*%?:~^-]+|\/)/gu;

function tokenize({ source, language }: { source: string, language: 'javascript' | 'typescript' }): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  let offset = 0;
  for (const match of source.matchAll(lexicalToken)) {
    const start = match.index;
    if (start > offset) {
      tokens.push({ kind: 'plain', text: source.slice(offset, start) });
    }
    const text = match[0];
    const groups = match.groups;
    let kind: SyntaxTokenKind = 'plain';
    if (groups?.comment !== undefined) {
      kind = 'comment';
    } else if (groups?.string !== undefined) {
      kind = 'string';
    } else if (groups?.operator !== undefined) {
      kind = 'operator';
    } else if (javascriptKeywords.has(text) || (language === 'typescript' && typescriptKeywords.has(text))) {
      kind = 'keyword';
    }
    tokens.push({ kind, text });
    offset = start + text.length;
  }
  if (offset < source.length) {
    tokens.push({ kind: 'plain', text: source.slice(offset) });
  }
  return tokens;
}

export function createJavaScriptHighlighter({ language }: {
  language: Extract<SyntaxLanguage, 'javascript' | 'typescript'>,
}): SyntaxHighlighter {
  let source = '';
  return {
    update({ edit }) {
      const { offset, text, ...unhandled } = edit;
      unhandled satisfies Record<PropertyKey, never>;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length) {
        throw new Error('Invalid code edit offset');
      }
      source = source.slice(0, offset) + text;
      return { offset: 0, tokens: tokenize({ source, language }) };
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
