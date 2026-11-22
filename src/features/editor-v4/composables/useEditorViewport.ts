import { nextTick, shallowRef, type Ref } from 'vue';
import type { EditorDocument, EditorRange } from '@/features/editor-v4/logic/document';

const LINE_HEIGHT = 20;
const BLOCK_PADDING = 8;
const OVERSCAN = 3;
const MAX_RENDERED_SELECTIONS = 800;

type LineMarker = { line: number, top: number };
type Decoration = EditorRange & { kind: 'selection' | 'match' | 'active-match' };
type Piece = { start: number, end: number, text: string, kind: Decoration['kind'] | 'plain' | 'caret' };

export function editorMirrorPieces({
  text, matches, selections,
}: { text: string, matches: readonly Decoration[], selections: readonly Decoration[] }): Piece[] {
  const selectionsInView = selections.slice(0, MAX_RENDERED_SELECTIONS);
  let selectionIndex = 0;
  const matchesInView = [...matches].sort((left, right) => left.start - right.start).filter(match => {
    while (selectionIndex < selectionsInView.length && (selectionsInView[selectionIndex]?.end ?? 0) < match.start) {
      selectionIndex++;
    }
    const selected = selectionsInView[selectionIndex];
    return selected === undefined || match.end < selected.start;
  });
  const decorations = [
    ...matchesInView,
    ...selectionsInView,
  ].sort((left, right) => left.start - right.start || left.end - right.end);
  const pieces: Piece[] = [];
  let offset = 0;
  for (const decoration of decorations) {
    const { start, end, kind } = decoration;
    if (start < offset || end > text.length) {
      continue;
    }
    if (offset < start) {
      pieces.push({ start: offset, end: start, text: text.slice(offset, start), kind: 'plain' });
    }
    pieces.push({ start, end, text: text.slice(start, end), kind: start === end ? 'caret' : kind });
    offset = end;
  }
  if (offset < text.length) {
    pieces.push({ start: offset, end: text.length, text: text.slice(offset), kind: 'plain' });
  }
  pieces.push({ start: text.length, end: text.length + 1, text: '\u200b', kind: 'plain' });
  return pieces;
}

export function useEditorViewport({
  document, textarea, mirror, wraps,
}: {
  document: EditorDocument,
  textarea: Readonly<Ref<HTMLTextAreaElement | undefined>>,
  mirror: Readonly<Ref<HTMLElement | undefined>>,
  wraps: () => boolean,
}) {
  const frame = shallowRef({ top: 0, left: 0, width: 0, height: 320 });
  const visible = shallowRef<LineMarker[]>([]);

  function createOffsetMeasure(): (({ offset }: { offset: number }) => { top: number, left: number } | undefined) | undefined {
    const element = mirror.value;
    if (element === undefined) {
      return undefined;
    }
    const range = element.ownerDocument.createRange();
    if (typeof range.getBoundingClientRect !== 'function') {
      return undefined;
    }
    const nodes = [...element.querySelectorAll<HTMLElement>('[data-offset]')];
    const base = element.getBoundingClientRect();
    return ({ offset }) => {
      let left = 0;
      let right = nodes.length;
      while (left < right) {
        const middle = Math.floor((left + right) / 2);
        const start = Number(nodes[middle]?.dataset.offset);
        if (start <= offset) {
          left = middle + 1;
        } else {
          right = middle;
        }
      }
      const node = nodes[left - 1];
      if (node?.firstChild === null || node?.firstChild === undefined) {
        return undefined;
      }
      const start = offset - Number(node.dataset.offset);
      const clamped = Math.max(0, Math.min(start, node.firstChild.textContent?.length ?? 0));
      range.setStart(node.firstChild, clamped);
      range.setEnd(node.firstChild, clamped);
      const position = range.getBoundingClientRect();
      return { top: position.top - base.top, left: position.left - base.left };
    };
  }

  async function measure(): Promise<void> {
    const element = textarea.value;
    if (element === undefined) {
      return;
    }
    const next = { top: element.scrollTop, left: element.scrollLeft, width: element.clientWidth, height: element.clientHeight || 320 };
    if (frame.value.width !== next.width || frame.value.height !== next.height || frame.value.top !== next.top || frame.value.left !== next.left) {
      frame.value = next;
    }
    if (wraps()) {
      // Range positions depend on the frame width applied to the mirror by Vue.
      await nextTick();
      if (textarea.value !== element) {
        return;
      }
    }
    const { top: scrollTop, height } = frame.value;
    const positionOf = wraps() ? createOffsetMeasure() : undefined;
    const firstGlyphTop = positionOf?.({ offset: 0 })?.top ?? BLOCK_PADDING;
    const lineTop = ({ line }: { line: number }): number => {
      const glyphTop = positionOf?.({ offset: document.getLineStart({ line }) })?.top;
      return glyphTop === undefined ? (line - 1) * LINE_HEIGHT + BLOCK_PADDING : glyphTop - firstGlyphTop + BLOCK_PADDING;
    };
    let low = 1;
    let high = document.lineCount;
    const before = scrollTop - OVERSCAN * LINE_HEIGHT;
    while (low < high) {
      const line = Math.ceil((low + high) / 2);
      if (lineTop({ line }) <= before) {
        low = line;
      } else {
        high = line - 1;
      }
    }
    const lines: LineMarker[] = [];
    const after = scrollTop + height + OVERSCAN * LINE_HEIGHT;
    for (let line = low; line <= document.lineCount; line++) {
      const top = lineTop({ line });
      if (top > after) {
        break;
      }
      lines.push({ line, top: top - scrollTop });
    }
    visible.value = lines;
  }

  function visibleRange(): EditorRange {
    const first = Math.min(visible.value[0]?.line ?? 1, document.lineCount);
    const last = visible.value.at(-1)?.line ?? Math.min(25, document.lineCount);
    return {
      start: document.getLineStart({ line: first }),
      end: last >= document.lineCount ? document.text.length : document.getLineStart({ line: last + 1 }),
    };
  }

  async function reveal({ offset }: { offset: number }): Promise<void> {
    const element = textarea.value;
    if (element === undefined) {
      return;
    }
    const line = document.getPosition({ offset }).line;
    const position = createOffsetMeasure()?.({ offset });
    const top = position?.top ?? (line - 1) * LINE_HEIGHT + BLOCK_PADDING;
    if (top < element.scrollTop || top + LINE_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - element.clientHeight / 3);
    }
    if (position !== undefined && (position.left < element.scrollLeft || position.left + BLOCK_PADDING > element.scrollLeft + element.clientWidth)) {
      element.scrollLeft = Math.max(0, position.left - element.clientWidth / 3);
    }
    await measure();
  }

  return {
    frame,
    visible,
    measure,
    visibleRange,
    reveal,
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
