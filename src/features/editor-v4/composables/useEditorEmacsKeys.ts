import type { EditorChange, EditorDocument } from '@/features/editor-v4/logic/document';

export function useEditorEmacsKeys({ document }: { document: EditorDocument }) {
  let killedText = '';
  let segmenter: Intl.Segmenter | undefined;

  function move({ offset }: { offset: number }): undefined {
    document.setSelection({ selection: { primary: { start: offset, end: offset }, secondary: [] } });
    return undefined;
  }

  function replace({ start, end, text }: { start: number, end: number, text: string }): EditorChange | undefined {
    const caret = start + text.length;
    return document.applyEdits({
      edits: [{ start, end, text }],
      selectionAfter: { primary: { start: caret, end: caret }, secondary: [] },
      group: undefined,
    });
  }

  function previousCharacter({ offset }: { offset: number }): number {
    if (offset < 1) {
      return 0;
    }
    const text = document.text;
    if (typeof Intl.Segmenter === 'function') {
      segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    }
    const grapheme = segmenter?.segment(text).containing(offset - 1);
    if (grapheme !== undefined) {
      return grapheme.index;
    }
    const code = text.charCodeAt(offset - 1);
    const previous = text.charCodeAt(offset - 2);
    return code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff ? offset - 2 : offset - 1;
  }

  function run({
    key, readOnly,
  }: { key: string, readOnly: boolean }): { change: EditorChange | undefined } | undefined {
    const { start, end, direction } = document.selection.primary;
    const offset = { backward: start, forward: end, none: end }[direction ?? 'none'];
    const { line } = document.getPosition({ offset });
    const text = document.text;
    switch (key) {
    case 'a':
      return { change: move({ offset: document.getLineStart({ line }) }) };
    case 'e':
      return { change: move({ offset: document.getLineEnd({ line }) }) };
    case 'b':
      return { change: move({ offset: previousCharacter({ offset }) }) };
    case 'n':
      return { change: move({ offset: document.getAdjacentLineOffset({ offset, delta: 1 }) }) };
    case 'p':
      return { change: move({ offset: document.getAdjacentLineOffset({ offset, delta: -1 }) }) };
    default:
      break;
    }
    if (readOnly) {
      return undefined;
    }
    switch (key) {
    case 'k': {
      const last = document.getLineEnd({ line });
      const to = last === offset ? Math.min(text.length, last + 1) : last;
      killedText = text.slice(offset, to);
      return { change: replace({ start: offset, end: to, text: '' }) };
    }
    case 'h':
      return { change: document.deleteAtSelections({ direction: 'backward' }) };
    case 'w': {
      let wordStart = offset;
      while (wordStart > 0 && /\s/.test(text.charAt(wordStart - 1))) {
        wordStart--;
      }
      while (wordStart > 0 && /\S/.test(text.charAt(wordStart - 1))) {
        wordStart--;
      }
      killedText = text.slice(wordStart, offset);
      return { change: replace({ start: wordStart, end: offset, text: '' }) };
    }
    case 'y':
      return { change: killedText === '' ? undefined : document.replaceSelections({ text: killedText, group: undefined }) };
    case 't': {
      const middle = previousCharacter({ offset });
      const from = previousCharacter({ offset: middle });
      const transposed = text.slice(middle, offset) + text.slice(from, middle);
      return { change: middle === from ? undefined : replace({ start: from, end: offset, text: transposed }) };
    }
    default:
      return undefined;
    }
  }

  return {
    run,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

export const TEST_ONLY = {
};
