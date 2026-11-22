import type { EditorEdit, EditorRange } from './document';

export function normalizeEditorNewlines({ text }: { text: string }): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

function splitsSurrogatePair({ text, offset }: { text: string, offset: number }): boolean {
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

function matchesChangeRange({ before, after, start, end, insertedEnd }: {
  before: string,
  after: string,
  start: number,
  end: number,
  insertedEnd: number,
}): boolean {
  return start >= 0 && start <= end && end <= before.length
    && start <= insertedEnd && insertedEnd <= after.length
    && !splitsSurrogatePair({ text: before, offset: start })
    && !splitsSurrogatePair({ text: before, offset: end })
    && !splitsSurrogatePair({ text: after, offset: start })
    && !splitsSurrogatePair({ text: after, offset: insertedEnd })
    && before.startsWith(after.slice(0, start))
    && before.slice(end) === after.slice(insertedEnd);
}

export function findInputEdit({ before, after, selectionBefore, selectionAfter }: {
  before: string,
  after: string,
  selectionBefore: EditorRange | undefined,
  selectionAfter: EditorRange | undefined,
}): EditorEdit | undefined {
  if (before === after) {
    return undefined;
  }

  // Selection hints distinguish identical insertions and deletions in repeated
  // text. Validate the prefix and suffix in case of autocorrection or a drop.
  if (selectionBefore !== undefined && selectionAfter !== undefined) {
    const cursor = selectionAfter.end;
    const end = selectionBefore.end;
    let start = Math.min(selectionBefore.start, cursor);
    let previousEnd = end;
    if (selectionBefore.start === end && cursor === end && before.length > after.length) {
      previousEnd += before.length - after.length;
    }
    if (matchesChangeRange({ before, after, start, end: previousEnd, insertedEnd: cursor })) {
      return { start, end: previousEnd, text: after.slice(start, cursor) };
    }
    // An unchanged native selection can accompany a replacement of that range.
    start = selectionBefore.start;
    const insertedEnd = end + after.length - before.length;
    if (matchesChangeRange({ before, after, start, end, insertedEnd })) {
      return { start, end, text: after.slice(start, insertedEnd) };
    }
  }

  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) {
    start++;
  }
  if (splitsSurrogatePair({ text: before, offset: start }) || splitsSurrogatePair({ text: after, offset: start })) {
    start--;
  }
  let end = before.length;
  let insertedEnd = after.length;
  while (end > start && insertedEnd > start && before.charCodeAt(end - 1) === after.charCodeAt(insertedEnd - 1)) {
    end--;
    insertedEnd--;
  }
  if (splitsSurrogatePair({ text: before, offset: end }) || splitsSurrogatePair({ text: after, offset: insertedEnd })) {
    end++;
    insertedEnd++;
  }
  return { start, end, text: after.slice(start, insertedEnd) };
}

export const TEST_ONLY = {
};
