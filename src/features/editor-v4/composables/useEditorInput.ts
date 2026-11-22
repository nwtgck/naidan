import type { Ref } from 'vue';
import {
  findInputEdit,
  type EditorChange,
  type EditorDocument,
  type EditorSelection,
  type EditorSelectionSet,
} from '@/features/editor-v4/logic/document';

function nativeSelection({ textarea }: { textarea: HTMLTextAreaElement }): EditorSelection {
  const { selectionStart: start, selectionEnd: end, selectionDirection } = textarea;
  const direction = start !== end && selectionDirection === 'backward' ? selectionDirection : undefined;
  return direction === undefined ? { start, end } : { start, end, direction };
}

function deletionDirection({ inputType }: { inputType: string }): 'backward' | 'forward' | undefined {
  switch (inputType) {
  case 'deleteContentBackward': return 'backward';
  case 'deleteContentForward': return 'forward';
  default: return undefined;
  }
}

function wordDeletionDirection({ inputType }: { inputType: string }): 'backward' | 'forward' | undefined {
  switch (inputType) {
  case 'deleteWordBackward': return 'backward';
  case 'deleteWordForward': return 'forward';
  default: return undefined;
  }
}

function historyDirection({ inputType }: { inputType: string }): 'undo' | 'redo' | undefined {
  switch (inputType) {
  case 'historyUndo': return 'undo';
  case 'historyRedo': return 'redo';
  default: return undefined;
  }
}

export function useEditorInput({
  document, textarea, isReadOnly, publish,
}: {
  document: EditorDocument,
  textarea: Readonly<Ref<HTMLTextAreaElement | undefined>>,
  isReadOnly: () => boolean,
  publish: ({ change }: { change: EditorChange | undefined }) => void,
}) {
  let beforeInput: EditorSelectionSet | undefined;
  let composition: { before: EditorSelectionSet, state: 'composing' | 'ended' } | undefined;

  function reconcileNativeSelection(): void {
    const element = textarea.value;
    if (element === undefined || composition !== undefined || beforeInput !== undefined || element.value !== document.text) {
      return;
    }
    const native = nativeSelection({ textarea: element });
    const { primary } = document.selection;
    if (native.start !== primary.start || native.end !== primary.end || native.direction !== primary.direction) {
      document.setSelection({ selection: { primary: native, secondary: [] } });
      publish({ change: undefined });
    }
  }

  function synchronizeElement(): void {
    const element = textarea.value;
    if (element === undefined || composition?.state === 'composing') {
      return;
    }
    const top = element.scrollTop;
    const left = element.scrollLeft;
    if (element.value !== document.text) {
      element.value = document.text;
    }
    const { start, end, direction } = document.selection.primary;
    const native = nativeSelection({ textarea: element });
    if (native.start !== start || native.end !== end || native.direction !== direction) {
      element.setSelectionRange(start, end, direction);
    }
    element.scrollTop = top;
    element.scrollLeft = left;
  }

  function editText({
    previous, inputType,
  }: { previous: EditorSelectionSet, inputType: string }): void {
    const element = textarea.value;
    if (element === undefined) {
      return;
    }
    if (isReadOnly()) {
      synchronizeElement();
      return;
    }
    const after = nativeSelection({ textarea: element });
    const text = element.value;
    const group = inputType === 'insertText' ? 'typing' : inputType === 'deleteContentBackward' ? 'backspace' : undefined;
    const direction = deletionDirection({ inputType });
    const wordDirection = wordDeletionDirection({ inputType });
    let change: EditorChange | undefined;
    if (previous.secondary.length === 0) {
      change = document.applyInput({ text, selectionBefore: previous.primary, selectionAfter: after, group });
    } else if (direction !== undefined) {
      change = document.deleteAtSelections({ direction });
    } else if (wordDirection !== undefined) {
      change = document.deleteWordsAtSelections({ direction: wordDirection });
    } else {
      const edit = findInputEdit({
        before: document.text,
        after: text,
        selectionBefore: previous.primary,
        selectionAfter: after,
      });
      if (edit === undefined) {
        if (after.start !== previous.primary.start || after.end !== previous.primary.end) {
          document.setSelection({ selection: { primary: after, secondary: [] } });
        }
      } else if (edit.start === previous.primary.start && edit.end === previous.primary.end) {
        change = document.replaceSelections({ text: edit.text, group });
      } else {
        // Autocorrect and paste gestures can edit outside the native selection.
        // Keep the browser's actual change there without duplicating it elsewhere.
        change = document.applyInput({ text, selectionBefore: previous.primary, selectionAfter: after, group: undefined });
      }
    }
    synchronizeElement();
    publish({ change });
  }

  function finishComposition(): void {
    const current = composition;
    if (current === undefined) {
      return;
    }
    switch (current.state) {
    case 'ended':
      composition = undefined;
      beforeInput = undefined;
      editText({ previous: current.before, inputType: 'insertCompositionText' });
      return;
    case 'composing':
      return;
    default: {
      const exhaustive: never = current.state;
      throw new Error('Unexpected composition state ' + String(exhaustive));
    }
    }
  }

  function handleCompositionStart(): void {
    finishComposition();
    reconcileNativeSelection();
    beforeInput = undefined;
    composition = { before: document.selection, state: 'composing' };
  }

  function handleCompositionEnd(): void {
    if (composition !== undefined) {
      composition.state = 'ended';
      queueMicrotask(finishComposition);
    }
  }

  function applyHistory({ direction }: { direction: 'undo' | 'redo' }): void {
    finishComposition();
    if (!isReadOnly() && composition === undefined) {
      const actions = { undo: () => document.undo(), redo: () => document.redo() };
      const change = actions[direction]();
      synchronizeElement();
      publish({ change });
    }
  }

  function handleBeforeInput({ event }: { event: InputEvent }): void {
    if (composition !== undefined || event.isComposing) {
      return;
    }
    reconcileNativeSelection();
    const direction = historyDirection({ inputType: event.inputType });
    if (direction !== undefined && event.cancelable) {
      event.preventDefault();
      applyHistory({ direction });
      return;
    }
    const previous = document.selection;
    if (previous.secondary.length > 0 && wordDeletionDirection({ inputType: event.inputType }) !== undefined
      && event.cancelable && !event.defaultPrevented && !isReadOnly()) {
      event.preventDefault();
      beforeInput = undefined;
      editText({ previous, inputType: event.inputType });
      return;
    }
    beforeInput = previous;
    // A canceled beforeinput may have no input event of its own.
    queueMicrotask(() => {
      if (beforeInput === previous) {
        beforeInput = undefined;
      }
    });
  }

  function handleInput({ event }: { event: InputEvent }): void {
    const state = composition?.state;
    switch (state) {
    case 'ended':
      finishComposition();
      return;
    case 'composing':
      return;
    case undefined:
      break;
    default: {
      const exhaustive: never = state;
      throw new Error('Unexpected composition state ' + String(exhaustive));
    }
    }
    if (event.isComposing) {
      return;
    }
    const previous = beforeInput ?? document.selection;
    beforeInput = undefined;
    const direction = historyDirection({ inputType: event.inputType });
    if (direction !== undefined) {
      synchronizeElement();
      applyHistory({ direction });
      return;
    }
    editText({ previous, inputType: event.inputType });
  }

  return {
    get isComposing() {
      return composition !== undefined;
    },
    finishComposition,
    synchronizeElement,
    reconcileNativeSelection,
    applyHistory,
    handleCompositionStart,
    handleCompositionEnd,
    handleBeforeInput,
    handleInput,
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
