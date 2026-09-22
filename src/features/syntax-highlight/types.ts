export type SyntaxLanguage = 'plain' | 'shell';
export type SyntaxTokenKind = 'plain' | 'keyword' | 'comment' | 'string' | 'variable' | 'operator' | 'command';
export type SyntaxToken = { kind: SyntaxTokenKind, text: string };
// Offsets count UTF-16 source code units, never tokens. Both edits replace the
// complete suffix from offset; appending is a replacement at the old source end.
export type CodeEdit = { offset: number, text: string };
export type HighlightEdit = { offset: number, tokens: SyntaxToken[] };
export interface SyntaxHighlighter {
  update({ edit }: { edit: CodeEdit }): HighlightEdit,
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
