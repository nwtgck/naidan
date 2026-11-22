export const EditorV4__document_counts = ({ lines, characters, words }: { lines: number, characters: number, words: number }): string => (
  `${lines} 行 · ${characters} 个字符 · ${words} 个词`
);
