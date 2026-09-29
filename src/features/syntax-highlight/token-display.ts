import type { HighlightEdit, SyntaxToken } from './types';

// Maintain source offsets separately from token indices: provisional keywords
// and variables can recolor an already displayed suffix without changing text.
export function createTokenDisplay() {
  let length = 0;
  const tokens: SyntaxToken[] = [];
  return {
    tokens,
    apply({ edit }: { edit: HighlightEdit }) {
      const { offset, tokens: replacement, ...unhandled } = edit;
      unhandled satisfies Record<PropertyKey, never>;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) throw new Error('Invalid highlight edit offset');
      while (length > offset) {
        const token = tokens.at(-1)!;
        const start = length - token.text.length;
        if (start >= offset) {
          tokens.pop(); length = start;
        } else {
          token.text = token.text.slice(0, offset - start); length = offset;
        }
      }
      for (const { kind, text, ...unhandledToken } of replacement) {
        unhandledToken satisfies Record<PropertyKey, never>;
        if (text.length === 0) continue;
        const previous = tokens.at(-1);
        if (previous?.kind === kind) previous.text += text;
        else tokens.push({ kind, text });
        length += text.length;
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
