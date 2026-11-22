import { describe, expect, it } from 'vitest';
import { EditorDocument, findInputEdit } from './document';

describe('EditorDocument', () => {
  it('selects the next literal occurrence, wrapping without selecting a range twice', () => {
    const document = new EditorDocument({ text: 'id id id' });
    document.setSelection({ selection: { primary: { start: 4, end: 4 }, secondary: [] } });

    expect(document.selectNextOccurrence()).toBe(true);
    expect(document.selection).toEqual({ primary: { start: 3, end: 5 }, secondary: [] });
    expect(document.selectNextOccurrence()).toBe(true);
    expect(document.selection.secondary).toEqual([{ start: 6, end: 8 }]);
    expect(document.selectNextOccurrence()).toBe(true);
    expect(document.selection).toEqual({ primary: { start: 3, end: 5 }, secondary: [{ start: 0, end: 2 }, { start: 6, end: 8 }] });
    expect(document.selectNextOccurrence()).toBe(false);
    expect(document.version).toBe(0);
    expect(document.dirty).toBe(false);
  });

  it('replaces multiple selections in one transaction and restores the selections on undo', () => {
    const document = new EditorDocument({ text: 'id id id' });
    document.setSelection({
      selection: {
        primary: { start: 3, end: 5, direction: 'backward' },
        secondary: [{ start: 0, end: 2 }],
      },
    });
    const originalSelection = document.selection;

    const change = document.replaceSelections({ text: 'key', group: undefined });
    expect(change).toEqual({
      baseVersion: 0,
      version: 1,
      checkpoint: 1,
      edits: [{ start: 0, end: 2, text: 'key' }, { start: 3, end: 5, text: 'key' }],
    });
    expect(document.text).toBe('key key id');
    expect(document.selection).toEqual({ primary: { start: 7, end: 7 }, secondary: [{ start: 3, end: 3 }] });
    expect(document.undo()).toEqual({
      baseVersion: 1,
      version: 2,
      checkpoint: 0,
      edits: [{ start: 0, end: 3, text: 'id' }, { start: 4, end: 7, text: 'id' }],
    });
    expect(document.text).toBe('id id id');
    expect(document.selection).toEqual(originalSelection);
    expect(document.dirty).toBe(false);
    expect(document.redo()?.version).toBe(3);
    expect(document.text).toBe('key key id');
    expect(document.dirty).toBe(true);
  });

  it('selects all nonoverlapping occurrences without replacing the original match', () => {
    const document = new EditorDocument({ text: 'aaaaa' });
    document.setSelection({ selection: { primary: { start: 1, end: 3 }, secondary: [] } });

    expect(document.selectAllOccurrences()).toBe(true);
    expect(document.selection).toEqual({ primary: { start: 1, end: 3 }, secondary: [{ start: 3, end: 5 }] });
    document.deleteAtSelections({ direction: 'forward' });
    expect(document.text).toBe('a');
    expect(document.selection).toEqual({ primary: { start: 1, end: 1 }, secondary: [] });
    document.undo();
    expect(document.text).toBe('aaaaa');
  });

  it('moves multiple carets between document lines without splitting graphemes', () => {
    const text = `\
aX
😀Q
aX
e\u0301Q`;
    const document = new EditorDocument({ text });
    document.setSelection({ selection: { primary: { start: 1, end: 1 }, secondary: [{ start: 8, end: 8 }] } });
    document.moveSelections({ key: 'ArrowDown', extend: false });
    expect(document.selection).toEqual({ primary: { start: 3, end: 3 }, secondary: [{ start: 10, end: 10 }] });
    document.moveSelections({ key: 'ArrowRight', extend: true });
    expect(document.selection).toEqual({ primary: { start: 3, end: 5 }, secondary: [{ start: 10, end: 12 }] });
    document.replaceSelections({ text: 'Z', group: undefined });
    expect(document.text).toBe(`\
aX
ZQ
aX
ZQ`);
    document.undo();
    expect(document.text).toBe(text);
  });

  it('keeps an in-flight savepoint reachable after further typing', () => {
    const document = new EditorDocument({ text: 'a' });
    document.setSelection({ selection: { primary: { start: 1, end: 1 }, secondary: [] } });
    document.replaceSelections({ text: 'b', group: 'typing' });
    const pendingSavepoint = document.captureSavepoint();
    document.replaceSelections({ text: 'c', group: 'typing' });
    document.markSaved({ checkpoint: pendingSavepoint });

    expect(document.dirty).toBe(true);
    document.undo();
    expect(document.text).toBe('ab');
    expect(document.dirty).toBe(false);
    document.redo();
    expect(document.text).toBe('abc');
    expect(document.dirty).toBe(true);
  });

  it('groups adjacent native typing but starts a new transaction after a caret move', () => {
    const document = new EditorDocument({ text: ' ' });
    document.applyInput({
      text: 'a ',
      selectionBefore: { start: 0, end: 0 },
      selectionAfter: { start: 1, end: 1 },
      group: 'typing',
    });
    document.applyInput({
      text: 'ab ',
      selectionBefore: { start: 1, end: 1 },
      selectionAfter: { start: 2, end: 2 },
      group: 'typing',
    });
    document.setSelection({ selection: { primary: { start: 3, end: 3 }, secondary: [] } });
    document.replaceSelections({ text: 'y', group: 'typing' });

    document.undo();
    expect(document.text).toBe('ab ');
    document.undo();
    expect(document.text).toBe(' ');
    expect(document.canUndo).toBe(false);
  });

  it('deletes whole graphemes at multiple cursors', () => {
    const document = new EditorDocument({ text: 'A👩‍💻 e\u0301!' });
    document.setSelection({
      selection: { primary: { start: 6, end: 6 }, secondary: [{ start: 9, end: 9 }] },
    });
    document.deleteAtSelections({ direction: 'backward' });

    expect(document.text).toBe('A !');
    expect(document.selection).toEqual({ primary: { start: 1, end: 1 }, secondary: [{ start: 2, end: 2 }] });
    document.undo();
    expect(document.text).toBe('A👩‍💻 e\u0301!');
    expect(document.selection.secondary).toEqual([{ start: 9, end: 9 }]);
  });

  it('preserves the line index when replacing across several blocks and restoring history', () => {
    const text = Array.from({ length: 800 }, (_, index) => `L${index} 💡`).join('\n');
    const document = new EditorDocument({ text });
    const start = document.getLineStart({ line: 246 }) + 1;
    const end = document.getLineStart({ line: 533 }) + 2;
    const inserted = `\
first
second
`;
    const expected = text.slice(0, start) + inserted + text.slice(end);
    document.applyEdits({
      edits: [{ start, end, text: inserted }],
      selectionAfter: undefined,
      group: undefined,
    });

    for (const operation of ['edit', 'undo', 'redo'] as const) {
      const expectedText = operation === 'undo' ? text : expected;
      if (operation === 'undo') {
        document.undo();
      } else if (operation === 'redo') {
        document.redo();
      }
      let offset = 0;
      const lines = expectedText.split('\n');
      expect(document.text).toBe(expectedText);
      expect(document.lineCount).toBe(lines.length);
      for (const [index, line] of lines.entries()) {
        expect(document.getLineStart({ line: index + 1 })).toBe(offset);
        expect(document.getPosition({ offset: offset + line.length })).toEqual({ line: index + 1, column: line.length + 1 });
        offset += line.length + 1;
      }
    }
  });

  it('preserves line starts and positions after disjoint edits, undo, and redo', () => {
    const text = Array.from({ length: 800 }, (_, index) => `L${index} 💡`).join('\n');
    const document = new EditorDocument({ text });
    const first = { start: 1, end: document.getLineStart({ line: 3 }), text: 'first' };
    const middle = {
      start: document.getLineStart({ line: 255 }) + 1,
      end: document.getLineStart({ line: 530 }) + 2,
      text: ['first', 'second', 'third'].join('\n'),
    };
    const last = { start: text.length, end: text.length, text: '\n' };
    const expected = [
      text.slice(0, first.start), first.text, text.slice(first.end, middle.start),
      middle.text, text.slice(middle.end), last.text,
    ].join('');
    function expectLineIndex({ content }: { content: string }): void {
      const lines = content.split('\n');
      expect(document.text).toBe(content);
      expect(document.lineCount).toBe(lines.length);
      let offset = 0;
      for (const [index, line] of lines.entries()) {
        expect(document.getLineStart({ line: index + 1 })).toBe(offset);
        expect(document.getPosition({ offset: offset + line.length })).toEqual({ line: index + 1, column: line.length + 1 });
        offset += line.length + 1;
      }
    }
    document.applyEdits({ edits: [last, first, middle], selectionAfter: undefined, group: undefined });
    expectLineIndex({ content: expected });
    document.undo();
    expectLineIndex({ content: text });
    document.redo();
    expectLineIndex({ content: expected });
  });

  it('preserves raw UTF-16 code units in forward and inverse input edits', () => {
    const prefix = 'a'.repeat(8192);
    const suffix = 'z'.repeat(8192);
    const oldText = '\ud800' + 'o'.repeat(1022) + '😀' + '\udc00';
    const newText = '\udc00' + 'n'.repeat(1022) + '🙂' + '\ud800';
    const original = prefix + oldText + suffix;
    const changed = prefix + newText + suffix;
    const document = new EditorDocument({ text: original });
    const change = document.applyInput({
      text: changed,
      selectionBefore: { start: prefix.length, end: prefix.length + oldText.length },
      selectionAfter: { start: prefix.length + newText.length, end: prefix.length + newText.length },
      group: undefined,
    });
    expect(change?.edits[0]?.text).toBe(newText);
    expect(document.undo()?.edits[0]?.text).toBe(oldText);
    expect(document.text).toBe(original);
    document.redo();
    expect(document.text).toBe(changed);
  });

  it('rejects stale or overlapping ranges without modifying the document or version', () => {
    const document = new EditorDocument({ text: 'first' });
    expect(() => document.applyEdits({
      edits: [{ start: 0, end: 3, text: '1' }, { start: 2, end: 5, text: '2' }],
      selectionAfter: undefined,
      group: undefined,
    })).toThrow(RangeError);
    expect(() => document.applyEdits({
      edits: [{ start: 0, end: 6, text: '1' }],
      selectionAfter: undefined,
      group: undefined,
    })).toThrow(RangeError);
    expect(document.text).toBe('first');
    expect(document.version).toBe(0);
    expect(document.canUndo).toBe(false);
  });
});

describe('findInputEdit', () => {
  it('uses the native selection to disambiguate a repeated insertion', () => {
    expect(findInputEdit({
      before: 'aaaa',
      after: 'aaaaa',
      selectionBefore: { start: 2, end: 2 },
      selectionAfter: { start: 3, end: 3 },
    })).toEqual({ start: 2, end: 2, text: 'a' });
  });

  it('uses the native selection to disambiguate a repeated forward deletion', () => {
    expect(findInputEdit({
      before: 'aaaa',
      after: 'aaa',
      selectionBefore: { start: 1, end: 1 },
      selectionAfter: { start: 1, end: 1 },
    })).toEqual({ start: 1, end: 2, text: '' });
  });

  it('falls back for an unpredictable native replacement outside the supplied selection', () => {
    expect(findInputEdit({
      before: '🙂 say bye',
      after: '🙃 say bye',
      selectionBefore: { start: 10, end: 10 },
      selectionAfter: { start: 10, end: 10 },
    })).toEqual({ start: 0, end: 2, text: '🙃' });
  });
});
