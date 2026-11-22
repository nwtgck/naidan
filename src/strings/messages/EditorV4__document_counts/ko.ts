export const EditorV4__document_counts = ({ lines, characters, words }: { lines: number, characters: number, words: number }): string => (
  `${lines}줄 · ${characters}자 · ${words}단어`
);
