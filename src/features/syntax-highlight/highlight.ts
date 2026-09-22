import { createShellHighlighter } from './shell/lexer';
import type { SyntaxHighlighter, SyntaxLanguage } from './types';

export function createSyntaxHighlighter({ language }: { language: SyntaxLanguage }): SyntaxHighlighter {
  switch (language) {
  case 'plain': {
    let length = 0;
    return {
      update({ edit }) {
        const { offset, text, ...unhandled } = edit;
        unhandled satisfies Record<PropertyKey, never>;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) throw new Error('Invalid code edit offset');
        length = offset + text.length;
        return { offset, tokens: text.length === 0 ? [] : [{ kind: 'plain', text }] };
      },
    };
  }
  case 'shell': return createShellHighlighter();
  default: {
    const _ex: never = language;
    throw new Error(`Unsupported syntax language: ${_ex}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
