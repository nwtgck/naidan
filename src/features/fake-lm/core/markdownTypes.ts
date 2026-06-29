export type FakeLmLanguage = 'ja' | 'en';

export type FakeLmMode = 'chat' | 'explain' | 'calm' | 'nonsense';

export type Inline =
  | { kind: 'text', text: string }
  | { kind: 'bold', text: string };

export type MarkdownBlock =
  | { kind: 'heading', level: 2 | 3, content: Inline[] }
  | { kind: 'paragraph', content: Inline[] }
  | { kind: 'list', items: Inline[][] }
  | { kind: 'table', headers: Inline[][], rows: Inline[][][] };

export type BlockPlan =
  | { kind: 'heading', level: 2 | 3 }
  | { kind: 'openingParagraph', sentenceCount: number }
  | { kind: 'paragraph', sentenceCount: number }
  | { kind: 'list', itemCount: number }
  | { kind: 'table', rowCount: number, columnCount: 2 | 3 }
  | { kind: 'closingParagraph' };
