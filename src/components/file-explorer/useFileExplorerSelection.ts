import { ref } from 'vue';
import type { FileExplorerEntry, SelectionState, SelectionAction } from './types';

export function useFileExplorerSelection() {
  const selectionState = ref<SelectionState>({
    selectedNames: new Set(),
    anchorName: undefined,
    focusName: undefined,
  });

  function applySelection({ action }: { action: SelectionAction }): void {
    const state = selectionState.value;

    switch (action.type) {
    case 'single': {
      selectionState.value = {
        selectedNames: new Set([action.name]),
        anchorName: action.name,
        focusName: action.name,
      };
      break;
    }
    case 'toggle': {
      const next = new Set(state.selectedNames);
      if (next.has(action.name)) {
        next.delete(action.name);
      } else {
        next.add(action.name);
      }
      selectionState.value = {
        selectedNames: next,
        anchorName: action.name,
        focusName: action.name,
      };
      break;
    }
    case 'range': {
      const { name, allEntries } = action;
      const anchor = state.anchorName;
      if (!anchor) {
        selectionState.value = {
          selectedNames: new Set([name]),
          anchorName: name,
          focusName: name,
        };
        break;
      }
      const anchorIdx = allEntries.findIndex(e => e.name === anchor);
      const targetIdx = allEntries.findIndex(e => e.name === name);
      if (anchorIdx === -1 || targetIdx === -1) break;
      const from = Math.min(anchorIdx, targetIdx);
      const to = Math.max(anchorIdx, targetIdx);
      const rangeNames = allEntries.slice(from, to + 1).map(e => e.name);
      selectionState.value = {
        selectedNames: new Set(rangeNames),
        anchorName: anchor,
        focusName: name,
      };
      break;
    }
    case 'all': {
      const names = action.allEntries.map(e => e.name);
      const last = names[names.length - 1];
      selectionState.value = {
        selectedNames: new Set(names),
        anchorName: names[0],
        focusName: last,
      };
      break;
    }
    case 'clear': {
      selectionState.value = {
        selectedNames: new Set(),
        anchorName: undefined,
        focusName: undefined,
      };
      break;
    }
    default: {
      const _ex: never = action;
      throw new Error(`Unhandled selection action: ${JSON.stringify(_ex)}`);
    }
    }
  }

  function getSelectedEntries({ allEntries }: { allEntries: FileExplorerEntry[] }): FileExplorerEntry[] {
    const names = selectionState.value.selectedNames;
    return allEntries.filter(e => names.has(e.name));
  }

  function moveFocus({
    direction,
    allEntries,
    extend,
  }: {
    direction: 'prev' | 'next';
    allEntries: FileExplorerEntry[];
    extend: boolean;
  }): void {
    if (allEntries.length === 0) return;
    const focus = selectionState.value.focusName;
    const currentIdx = focus ? allEntries.findIndex(e => e.name === focus) : -1;

    let nextIdx: number;
    switch (direction) {
    case 'prev':
      nextIdx = currentIdx <= 0 ? 0 : currentIdx - 1;
      break;
    case 'next':
      nextIdx = currentIdx >= allEntries.length - 1 ? allEntries.length - 1 : currentIdx + 1;
      break;
    default: {
      const _ex: never = direction;
      throw new Error(`Unhandled direction: ${_ex}`);
    }
    }

    const nextEntry = allEntries[nextIdx];
    if (!nextEntry) return;

    if (extend) {
      applySelection({ action: { type: 'range', name: nextEntry.name, allEntries } });
    } else {
      applySelection({ action: { type: 'single', name: nextEntry.name } });
    }
  }

  function clearSelectionForNewDirectory(): void {
    selectionState.value = {
      selectedNames: new Set(),
      anchorName: undefined,
      focusName: undefined,
    };
  }

  return {
    selectionState,
    applySelection,
    getSelectedEntries,
    moveFocus,
    clearSelectionForNewDirectory,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
