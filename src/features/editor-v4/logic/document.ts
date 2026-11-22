import { EditorLineIndex } from './line-index';
import { findInputEdit, normalizeEditorNewlines } from './input-edit';

export { findInputEdit } from './input-edit';

export type EditorRange = Readonly<{ start: number, end: number }>;
export type EditorSelection = EditorRange & Readonly<{ direction?: 'forward' | 'backward' | 'none' | undefined }>;
export type EditorSelectionSet = Readonly<{ primary: EditorSelection, secondary: readonly EditorSelection[] }>;
export type EditorEdit = EditorRange & Readonly<{ text: string }>;
export type EditorEditGroup = 'typing' | 'backspace';
type EditorSelectionMotion = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';
export type EditorChange = Readonly<{
  baseVersion: number,
  version: number,
  edits: readonly EditorEdit[],
  checkpoint: number,
}>;

interface HistoryEntry {
  readonly forward: readonly EditorEdit[];
  readonly backward: readonly EditorEdit[];
  readonly selectionBefore: EditorSelectionSet;
  readonly selectionAfter: EditorSelectionSet;
  readonly checkpointBefore: number;
  readonly checkpointAfter: number;
  readonly cost: number;
}

const historyBudget = 8 * 1024 * 1024;
const incrementalLineIndexEditLimit = 64;
const selectionLimit = 10_000;
const typingGroupWindowMs = 750;
const typingGroupLength = 4096;
const wordCharacter = /[\p{L}\p{M}\p{N}\p{Pc}]/u;
let graphemeSegmenter: Intl.Segmenter | undefined;
let wordSegmenter: Intl.Segmenter | undefined;

function isBackwardDeletion({ direction }: { direction: 'backward' | 'forward' }): boolean {
  switch (direction) {
  case 'backward': return true;
  case 'forward': return false;
  default: {
    const exhaustive: never = direction;
    throw new Error(`Unhandled deletion direction: ${exhaustive}`);
  }
  }
}

function caretAt({ offset }: { offset: number }): EditorSelection {
  return { start: offset, end: offset };
}

function assertRange({ range, length }: { range: EditorRange, length: number }): void {
  const { start, end } = range;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end > length) {
    throw new RangeError('Editor range is outside the document');
  }
}

function rangesOverlap({ first, second }: { first: EditorRange, second: EditorRange }): boolean {
  if (first.start === first.end || second.start === second.end) {
    return first.start <= second.end && second.start <= first.end;
  }
  return first.start < second.end && second.start < first.end;
}

function normalizeSelection({ selection, length }: { selection: EditorSelectionSet, length: number }): EditorSelectionSet {
  const ranges = [selection.primary, ...selection.secondary].map((range, index) => {
    assertRange({ range, length });
    const { start, end, direction } = range;
    return { start, end, direction: end === start || direction === 'none' ? undefined : direction, primary: index === 0 };
  }).sort((left, right) => left.start - right.start || left.end - right.end);

  const merged: typeof ranges = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && rangesOverlap({ first: previous, second: range })) {
      previous.end = Math.max(previous.end, range.end);
      if (range.primary) {
        previous.direction = range.direction;
        previous.primary = true;
      }
    } else {
      merged.push(range);
    }
  }

  const primary: EditorSelection[] = [];
  const secondary: EditorSelection[] = [];
  for (const range of merged) {
    const target = range.primary ? primary : secondary;
    const { start, end, direction } = range;
    target.push(direction === undefined ? { start, end } : { start, end, direction });
  }
  return { primary: primary[0]!, secondary };
}

function sameSelection({ first, second }: { first: EditorSelectionSet, second: EditorSelectionSet }): boolean {
  const sameRange = ({ left, right }: { left: EditorSelection, right: EditorSelection }): boolean =>
    left.start === right.start && left.end === right.end && left.direction === right.direction;
  return sameRange({ left: first.primary, right: second.primary })
    && first.secondary.length === second.secondary.length
    && first.secondary.every((range, index) => sameRange({ left: range, right: second.secondary[index]! }));
}

function normalizeEdits({ edits, text }: { edits: readonly EditorEdit[], text: string }): EditorEdit[] {
  const sorted = edits.map(edit => {
    const { start, end, text: replacement, ...unhandled } = edit;
    unhandled satisfies Record<PropertyKey, never>;
    assertRange({ range: { start, end }, length: text.length });
    return { start, end, text: normalizeEditorNewlines({ text: replacement }) };
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  const changes: EditorEdit[] = [];
  let lastEnd = 0;
  for (const change of sorted) {
    if (change.start < lastEnd) {
      throw new RangeError('Editor edits must not overlap');
    }
    lastEnd = change.end;
    if (change.text === text.slice(change.start, change.end)) {
      continue;
    }
    const previous = changes.at(-1);
    if (previous !== undefined && previous.end === change.start) {
      changes[changes.length - 1] = { start: previous.start, end: change.end, text: previous.text + change.text };
    } else {
      changes.push(change);
    }
  }
  return changes;
}

function detachEditText({ text, documentLength }: { text: string, documentLength: number }): string {
  if (text.length === 0 || text.length * 2 >= documentLength) {
    return text;
  }
  // A small substring can retain the backing storage of a whole document
  // version. Copy its code units directly, including any isolated surrogate.
  if (text.length === 1) {
    return String.fromCharCode(text.charCodeAt(0));
  }
  const chunks: string[] = [];
  const units: number[] = [];
  const chunkLength = 1024;
  for (let start = 0; start < text.length; start += chunkLength) {
    const end = Math.min(start + chunkLength, text.length);
    for (let offset = start; offset < end; offset++) {
      units.push(text.charCodeAt(offset));
    }
    chunks.push(String.fromCharCode(...units));
    units.length = 0;
  }
  return chunks.join('');
}

function invertEdits({ edits, text }: { edits: readonly EditorEdit[], text: string }): EditorEdit[] {
  let shift = 0;
  return edits.map(edit => {
    const start = edit.start + shift;
    const end = start + edit.text.length;
    shift += edit.text.length - (edit.end - edit.start);
    return { start, end, text: detachEditText({ text: text.slice(edit.start, edit.end), documentLength: text.length }) };
  });
}

function applyChanges({ edits, text }: { edits: readonly EditorEdit[], text: string }): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(text.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

function shiftSelections({ selection, edits, inverse }: {
  selection: EditorSelectionSet,
  edits: readonly EditorEdit[],
  inverse: readonly EditorEdit[],
}): EditorSelectionSet {
  function shiftOffset({ offset, affinity }: { offset: number, affinity: 'before' | 'after' }): number {
    let left = 0;
    let right = edits.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      const start = edits[middle]!.start;
      if (start < offset || (start === offset && affinity === 'after')) {
        left = middle + 1;
      } else {
        right = middle;
      }
    }
    const previous = edits[left - 1];
    return previous === undefined ? offset : inverse[left - 1]!.end + Math.max(0, offset - previous.end);
  }
  function shiftRange({ range }: { range: EditorSelection }): EditorSelection {
    const start = shiftOffset({ offset: range.start, affinity: 'after' });
    const end = Math.max(start, shiftOffset({ offset: range.end, affinity: 'before' }));
    return { start, end, direction: range.direction };
  }
  return {
    primary: shiftRange({ range: selection.primary }),
    secondary: selection.secondary.map(range => shiftRange({ range })),
  };
}

function previousCodePoint({ text, offset }: { text: string, offset: number }): number {
  const last = text.charCodeAt(offset - 1);
  const first = text.charCodeAt(offset - 2);
  return last >= 0xdc00 && last <= 0xdfff && first >= 0xd800 && first <= 0xdbff ? offset - 2 : offset - 1;
}

function nextCodePoint({ text, offset }: { text: string, offset: number }): number {
  const point = text.codePointAt(offset);
  return offset + (point !== undefined && point > 0xffff ? 2 : 1);
}

function wordAt({ text, offset }: { text: string, offset: number }): EditorRange {
  let start = offset;
  let end = offset;
  while (start > 0) {
    const previous = previousCodePoint({ text, offset: start });
    if (!wordCharacter.test(text.slice(previous, start))) {
      break;
    }
    start = previous;
  }
  while (end < text.length) {
    const next = nextCodePoint({ text, offset: end });
    if (!wordCharacter.test(text.slice(end, next))) {
      break;
    }
    end = next;
  }
  return { start, end };
}

function hasOverlap({ sortedSelections, candidate }: { sortedSelections: readonly EditorSelection[], candidate: EditorRange }): boolean {
  let left = 0;
  let right = sortedSelections.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    const selection = sortedSelections[middle]!;
    if (selection.end <= candidate.start) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }
  const selection = sortedSelections[left];
  return selection !== undefined && rangesOverlap({ first: selection, second: candidate });
}

function historyCost({ forward, backward, selectionBefore, selectionAfter }: {
  forward: readonly EditorEdit[],
  backward: readonly EditorEdit[],
  selectionBefore: EditorSelectionSet,
  selectionAfter: EditorSelectionSet,
}): number {
  let cost = 96 + (selectionBefore.secondary.length + selectionAfter.secondary.length) * 24;
  for (const edit of forward) {
    cost += 48 + edit.text.length * 2;
  }
  for (const edit of backward) {
    cost += 48 + edit.text.length * 2;
  }
  return cost;
}

export class EditorDocument {
  private content: string;
  private revision = 0;
  private stateId = 0;
  private savepoint = 0;
  private selections: EditorSelectionSet = { primary: { start: 0, end: 0 }, secondary: [] };
  private lines: EditorLineIndex;
  private graphemes: Intl.Segments | undefined;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private undoCost = 0;
  private occurrenceEnd: number | undefined;
  private lastGroup: { kind: EditorEditGroup, time: number } | undefined;

  constructor({ text }: { text: string }) {
    this.content = normalizeEditorNewlines({ text });
    this.lines = new EditorLineIndex({ text: this.content });
  }

  get text(): string {
    return this.content;
  }

  get version(): number {
    return this.revision;
  }

  get checkpoint(): number {
    return this.stateId;
  }

  get dirty(): boolean {
    return this.stateId !== this.savepoint;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get selection(): EditorSelectionSet {
    return this.selections;
  }

  get lineCount(): number {
    return this.lines.lineCount;
  }

  getPosition({ offset }: { offset: number }): { line: number, column: number } {
    assertRange({ range: caretAt({ offset }), length: this.content.length });
    return this.lines.getPosition({ offset });
  }

  getLineStart({ line }: { line: number }): number {
    if (!Number.isSafeInteger(line) || line < 1 || line > this.lines.lineCount) {
      throw new RangeError('Editor line is outside the document');
    }
    return this.lines.getLineStart({ line });
  }

  getLineEnd({ line }: { line: number }): number {
    return line === this.lineCount ? this.content.length : this.getLineStart({ line: line + 1 }) - 1;
  }

  getAdjacentLineOffset({ offset, delta }: { offset: number, delta: -1 | 1 }): number {
    const { line, column } = this.getPosition({ offset });
    const destination = line + delta;
    if (destination < 1 || destination > this.lineCount) {
      return offset;
    }
    const lineEnd = this.getLineEnd({ line: destination });
    const target = Math.min(this.getLineStart({ line: destination }) + column - 1, lineEnd);
    if (target === lineEnd) {
      return target;
    }
    return this.getGraphemes()?.containing(target)?.index
      ?? previousCodePoint({ text: this.content, offset: target + 1 });
  }

  private getGraphemes(): Intl.Segments | undefined {
    if (typeof Intl.Segmenter === 'function') {
      graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      this.graphemes ??= graphemeSegmenter.segment(this.content);
    }
    return this.graphemes;
  }

  private moveOffset({ key, offset }: { key: EditorSelectionMotion, offset: number }): number {
    switch (key) {
    case 'ArrowLeft':
      return offset === 0 ? 0 : this.getGraphemes()?.containing(offset - 1)?.index
        ?? previousCodePoint({ text: this.content, offset });
    case 'ArrowRight': {
      const grapheme = this.getGraphemes()?.containing(offset);
      return grapheme === undefined ? Math.min(this.content.length, nextCodePoint({ text: this.content, offset }))
        : grapheme.index + grapheme.segment.length;
    }
    case 'ArrowUp': return this.getAdjacentLineOffset({ offset, delta: -1 });
    case 'ArrowDown': return this.getAdjacentLineOffset({ offset, delta: 1 });
    case 'Home': return this.getLineStart({ line: this.getPosition({ offset }).line });
    case 'End': return this.getLineEnd({ line: this.getPosition({ offset }).line });
    default: {
      const exhaustive: never = key;
      throw new Error(`Unhandled selection movement: ${exhaustive}`);
    }
    }
  }

  moveSelections({ key, extend }: { key: EditorSelectionMotion, extend: boolean }): void {
    const move = ({ range }: { range: EditorSelection }): EditorSelection => {
      if (!extend && range.start !== range.end) {
        switch (key) {
        case 'ArrowLeft': return caretAt({ offset: range.start });
        case 'ArrowRight': return caretAt({ offset: range.end });
        case 'ArrowUp': case 'ArrowDown': case 'Home': case 'End': break;
        default: {
          const exhaustive: never = key;
          throw new Error(`Unhandled selection movement: ${exhaustive}`);
        }
        }
      }
      const reverse = range.direction === 'backward';
      const offset = this.moveOffset({ key, offset: reverse ? range.start : range.end });
      const anchor = reverse ? range.end : range.start;
      if (!extend || offset === anchor) {
        return caretAt({ offset });
      }
      return offset < anchor ? { start: offset, end: anchor, direction: 'backward' } : { start: anchor, end: offset };
    };
    this.setSelection({
      selection: {
        primary: move({ range: this.selections.primary }),
        secondary: this.selections.secondary.map(range => move({ range })),
      },
    });
  }

  setSelection({ selection }: { selection: EditorSelectionSet }): void {
    const normalized = normalizeSelection({ selection, length: this.content.length });
    if (sameSelection({ first: this.selections, second: normalized })) {
      return;
    }
    this.selections = normalized;
    this.lastGroup = undefined;
    this.occurrenceEnd = undefined;
  }

  captureSavepoint(): number {
    this.lastGroup = undefined;
    return this.stateId;
  }

  markSaved({ checkpoint }: { checkpoint: number }): void {
    this.savepoint = checkpoint;
    this.lastGroup = undefined;
  }

  applyEdits({ edits, selectionAfter, group }: {
    edits: readonly EditorEdit[],
    selectionAfter: EditorSelectionSet | undefined,
    group: EditorEditGroup | undefined,
  }): EditorChange | undefined {
    const forward = normalizeEdits({ edits, text: this.content });
    return this.commit({ forward, content: applyChanges({ edits: forward, text: this.content }), selectionAfter, group });
  }

  applyInput({ text, selectionBefore, selectionAfter, group }: {
    text: string,
    selectionBefore: EditorRange | undefined,
    selectionAfter: EditorSelection,
    group: EditorEditGroup | undefined,
  }): EditorChange | undefined {
    const content = normalizeEditorNewlines({ text });
    const edit = findInputEdit({ before: this.content, after: content, selectionBefore, selectionAfter });
    return this.commit({
      forward: edit === undefined ? [] : [edit],
      content,
      selectionAfter: { primary: selectionAfter, secondary: [] },
      group,
    });
  }

  private commit({ forward, content, selectionAfter, group }: {
    forward: readonly EditorEdit[],
    content: string,
    selectionAfter: EditorSelectionSet | undefined,
    group: EditorEditGroup | undefined,
  }): EditorChange | undefined {
    if (forward.length === 0) {
      if (selectionAfter !== undefined) {
        this.setSelection({ selection: selectionAfter });
      }
      return undefined;
    }
    const documentLength = Math.max(this.content.length, content.length);
    let previousText: string | undefined;
    let detachedText = '';
    const ownedForward = forward.map(edit => {
      if (edit.text !== previousText) {
        previousText = edit.text;
        detachedText = detachEditText({ text: edit.text, documentLength });
      }
      return { start: edit.start, end: edit.end, text: detachedText };
    });
    const backward = invertEdits({ edits: ownedForward, text: this.content });
    const selectionBefore = this.selections;
    const nextSelection = normalizeSelection({
      selection: selectionAfter ?? shiftSelections({ selection: selectionBefore, edits: ownedForward, inverse: backward }),
      length: content.length,
    });
    const checkpoint = this.revision + 1;
    const cost = historyCost({ forward: ownedForward, backward, selectionBefore, selectionAfter: nextSelection });
    this.recordHistory({
      entry: { forward: ownedForward, backward, selectionBefore, selectionAfter: nextSelection, checkpointBefore: this.stateId, checkpointAfter: checkpoint, cost },
      group,
    });
    this.redoStack.length = 0;
    return this.changeDocument({ edits: ownedForward, content, selection: nextSelection, checkpoint });
  }

  replaceSelections({ text, group }: { text: string, group: EditorEditGroup | undefined }): EditorChange | undefined {
    const replacement = normalizeEditorNewlines({ text });
    return this.applySelectionEdits({
      primary: { ...this.selections.primary, text: replacement },
      secondary: this.selections.secondary.map(range => ({ ...range, text: replacement })),
      group,
    });
  }

  deleteAtSelections({ direction }: { direction: 'backward' | 'forward' }): EditorChange | undefined {
    const backward = isBackwardDeletion({ direction });
    const graphemes = this.getGraphemes();
    const deletion = ({ range }: { range: EditorSelection }): EditorRange => {
      const { start, end } = range;
      if (start !== end || (backward ? start === 0 : end === this.content.length)) {
        return range;
      }
      const grapheme = graphemes?.containing(backward ? start - 1 : end);
      if (grapheme !== undefined) {
        return { start: grapheme.index, end: grapheme.index + grapheme.segment.length };
      }
      return backward
        ? { start: previousCodePoint({ text: this.content, offset: start }), end }
        : { start, end: nextCodePoint({ text: this.content, offset: end }) };
    };
    return this.applyDeletions({
      primary: deletion({ range: this.selections.primary }),
      secondary: this.selections.secondary.map(range => deletion({ range })),
      group: backward ? 'backspace' : undefined,
    });
  }

  deleteWordsAtSelections({ direction }: { direction: 'backward' | 'forward' }): EditorChange | undefined {
    const backward = isBackwardDeletion({ direction });
    const text = this.content;
    if (typeof Intl.Segmenter === 'function') {
      wordSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
    }
    const words = wordSegmenter?.segment(text);
    const deletion = ({ range }: { range: EditorSelection }): EditorRange => {
      const { start, end } = range;
      if (start !== end) {
        return range;
      }
      let cursor = start;
      while (/\s/.test(text.charAt(backward ? cursor - 1 : cursor))) {
        cursor += backward ? -1 : 1;
      }
      if (backward ? cursor === 0 : cursor === text.length) {
        return backward ? { start: cursor, end } : { start, end: cursor };
      }
      const word = words?.containing(backward ? cursor - 1 : cursor);
      if (word !== undefined) {
        return backward ? { start: word.index, end } : { start, end: word.index + word.segment.length };
      }
      const fallback = wordAt({ text, offset: cursor });
      return backward
        ? { start: fallback.start < cursor ? fallback.start : previousCodePoint({ text, offset: cursor }), end }
        : { start, end: fallback.end > cursor ? fallback.end : nextCodePoint({ text, offset: cursor }) };
    };
    return this.applyDeletions({
      primary: deletion({ range: this.selections.primary }),
      secondary: this.selections.secondary.map(range => deletion({ range })),
      group: undefined,
    });
  }

  private applyDeletions({ primary, secondary, group }: {
    primary: EditorRange,
    secondary: readonly EditorRange[],
    group: EditorEditGroup | undefined,
  }): EditorChange | undefined {
    // Adjacent carets may touch the same word or grapheme.
    const normalized = normalizeSelection({
      selection: { primary, secondary },
      length: this.content.length,
    });
    return this.applySelectionEdits({
      primary: { ...normalized.primary, text: '' },
      secondary: normalized.secondary.map(range => ({ ...range, text: '' })),
      group,
    });
  }

  selectNextOccurrence(): boolean {
    const { primary, secondary } = this.selections;
    if (primary.start === primary.end) {
      const word = wordAt({ text: this.content, offset: primary.start });
      if (word.start === word.end) {
        return false;
      }
      this.setSelection({ selection: { primary: word, secondary: [] } });
      return true;
    }
    if (secondary.length + 1 >= selectionLimit) {
      return false;
    }
    const term = this.content.slice(primary.start, primary.end);
    const sorted = [primary, ...secondary].sort((left, right) => left.start - right.start);
    const start = this.occurrenceEnd ?? primary.end;
    const next = this.findOccurrence({ term, start, stop: this.content.length, selections: sorted })
      ?? this.findOccurrence({ term, start: 0, stop: start, selections: sorted });
    if (next === undefined) {
      return false;
    }
    this.setSelection({ selection: { primary, secondary: [...secondary, next] } });
    this.occurrenceEnd = next.end;
    return true;
  }

  selectAllOccurrences(): boolean {
    const current = this.selections.primary;
    const primary = current.start === current.end ? wordAt({ text: this.content, offset: current.start }) : current;
    if (primary.start === primary.end) {
      return false;
    }
    const term = this.content.slice(primary.start, primary.end);
    const secondary: EditorSelection[] = [];
    let start = 0;
    while (start < this.content.length) {
      const match = this.findOccurrence({ term, start, stop: this.content.length, selections: [primary] });
      if (match === undefined) {
        break;
      }
      if (secondary.length + 1 >= selectionLimit) {
        return false;
      }
      secondary.push(match);
      start = match.end;
    }
    this.setSelection({ selection: { primary, secondary } });
    return true;
  }

  undo(): EditorChange | undefined {
    const entry = this.undoStack.pop();
    if (entry === undefined) {
      return undefined;
    }
    this.redoStack.push(entry);
    this.undoCost -= entry.cost;
    this.lastGroup = undefined;
    return this.changeDocument({
      edits: entry.backward,
      content: applyChanges({ edits: entry.backward, text: this.content }),
      selection: entry.selectionBefore,
      checkpoint: entry.checkpointBefore,
    });
  }

  redo(): EditorChange | undefined {
    const entry = this.redoStack.pop();
    if (entry === undefined) {
      return undefined;
    }
    this.recordHistory({ entry, group: undefined });
    return this.changeDocument({
      edits: entry.forward,
      content: applyChanges({ edits: entry.forward, text: this.content }),
      selection: entry.selectionAfter,
      checkpoint: entry.checkpointAfter,
    });
  }

  private changeDocument({ edits, content, selection, checkpoint }: {
    edits: readonly EditorEdit[],
    content: string,
    selection: EditorSelectionSet,
    checkpoint: number,
  }): EditorChange {
    const baseVersion = this.revision;
    if (edits.length <= incrementalLineIndexEditLimit) {
      // The edits use offsets into the original text. Updating from right to
      // left keeps those offsets valid between replacements.
      for (let index = edits.length - 1; index >= 0; index--) {
        this.lines.replace(edits[index]!);
      }
    } else {
      // A large batch can shift the same suffix blocks too many times.
      this.lines.reset({ text: content });
    }
    this.content = content;
    this.graphemes = undefined;
    this.selections = selection;
    this.stateId = checkpoint;
    this.occurrenceEnd = undefined;
    this.revision++;
    return { baseVersion, version: this.revision, edits, checkpoint };
  }

  private applySelectionEdits({ primary, secondary, group }: {
    primary: EditorEdit,
    secondary: readonly EditorEdit[],
    group: EditorEditGroup | undefined,
  }): EditorChange | undefined {
    const edits = [primary, ...secondary].sort((left, right) => left.start - right.start);
    let shift = 0;
    let primaryCaret = caretAt({ offset: primary.start });
    const secondaryCarets: EditorSelection[] = [];
    for (const edit of edits) {
      const caret = caretAt({ offset: edit.start + shift + edit.text.length });
      if (edit === primary) {
        primaryCaret = caret;
      } else {
        secondaryCarets.push(caret);
      }
      shift += edit.text.length - (edit.end - edit.start);
    }
    return this.applyEdits({ edits, selectionAfter: { primary: primaryCaret, secondary: secondaryCarets }, group });
  }

  private findOccurrence({ term, start, stop, selections }: {
    term: string,
    start: number,
    stop: number,
    selections: readonly EditorSelection[],
  }): EditorRange | undefined {
    let index = this.content.indexOf(term, start);
    while (index !== -1 && index < stop) {
      const range = { start: index, end: index + term.length };
      if (!hasOverlap({ sortedSelections: selections, candidate: range })) {
        return range;
      }
      index = this.content.indexOf(term, index + 1);
    }
    return undefined;
  }

  private recordHistory({ entry, group }: { entry: HistoryEntry, group: EditorEditGroup | undefined }): void {
    const previous = this.undoStack.at(-1);
    const time = performance.now();
    const combined = previous !== undefined && group !== undefined && this.lastGroup?.kind === group
      && time - this.lastGroup.time <= typingGroupWindowMs && sameSelection({ first: previous.selectionAfter, second: entry.selectionBefore })
      ? this.joinHistory({ previous, entry, group })
      : undefined;

    if (combined !== undefined) {
      this.undoCost -= this.undoStack.pop()!.cost;
    }
    const recorded = combined ?? entry;
    this.undoStack.push(recorded);
    this.undoCost += recorded.cost;
    this.lastGroup = group === undefined ? undefined : { kind: group, time };
    // Keep the latest transaction reversible even when it alone exceeds the budget.
    while (this.undoCost > historyBudget && this.undoStack.length > 1) {
      this.undoCost -= this.undoStack.shift()!.cost;
    }
  }

  private joinHistory({ previous, entry, group }: {
    previous: HistoryEntry,
    entry: HistoryEntry,
    group: EditorEditGroup,
  }): HistoryEntry | undefined {
    if (previous.forward.length !== 1 || entry.forward.length !== 1
      || entry.selectionBefore.primary.start !== entry.selectionBefore.primary.end
      || previous.selectionBefore.secondary.length !== 0 || entry.selectionAfter.secondary.length !== 0) {
      return undefined;
    }
    const first = previous.forward[0]!;
    const second = entry.forward[0]!;
    let forward: EditorEdit[];
    let backward: EditorEdit[];
    switch (group) {
    case 'typing': {
      if (first.start !== first.end || second.start !== second.end || first.start + first.text.length !== second.start) {
        return undefined;
      }
      const text = first.text + second.text;
      if (text.length > typingGroupLength || text.includes('\n')) {
        return undefined;
      }
      forward = [{ start: first.start, end: first.start, text }];
      backward = [{ start: first.start, end: first.start + text.length, text: '' }];
      break;
    }
    case 'backspace': {
      if (first.text !== '' || second.text !== '' || second.end !== first.start) {
        return undefined;
      }
      const text = entry.backward[0]!.text + previous.backward[0]!.text;
      if (text.length > typingGroupLength || text.includes('\n')) {
        return undefined;
      }
      forward = [{ start: second.start, end: first.end, text: '' }];
      backward = [{ start: second.start, end: second.start, text }];
      break;
    }
    default: {
      group satisfies never;
      return undefined;
    }
    }
    const { selectionBefore, checkpointBefore } = previous;
    const { selectionAfter, checkpointAfter } = entry;
    return {
      forward,
      backward,
      selectionBefore,
      selectionAfter,
      checkpointBefore,
      checkpointAfter,
      cost: historyCost({ forward, backward, selectionBefore, selectionAfter }),
    };
  }
}

export const TEST_ONLY = {
};
