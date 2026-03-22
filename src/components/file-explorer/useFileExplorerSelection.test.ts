import { describe, it, expect } from 'vitest';
import { useFileExplorerSelection } from './useFileExplorerSelection';
import type { FileExplorerEntry } from './types';

function makeEntry(name: string): FileExplorerEntry {
  return {
    name,
    kind: 'file',
    handle: {} as FileSystemHandle,
    size: undefined,
    lastModified: undefined,
    extension: '.txt',
    mimeCategory: 'text',
  };
}

const entries = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map(makeEntry);

describe('useFileExplorerSelection', () => {
  // ---- initial state ----

  it('starts with empty selection', () => {
    const { selectionState } = useFileExplorerSelection();
    expect(selectionState.value.selectedNames.size).toBe(0);
    expect(selectionState.value.anchorName).toBeUndefined();
    expect(selectionState.value.focusName).toBeUndefined();
  });

  // ---- single ----

  it('single action selects one entry and sets anchor/focus', () => {
    const { selectionState, applySelection } = useFileExplorerSelection();
    applySelection({ action: { type: 'single', name: 'bravo' } });
    expect(selectionState.value.selectedNames).toEqual(new Set(['bravo']));
    expect(selectionState.value.anchorName).toBe('bravo');
    expect(selectionState.value.focusName).toBe('bravo');
  });

  it('single action replaces previous selection', () => {
    const { selectionState, applySelection } = useFileExplorerSelection();
    applySelection({ action: { type: 'single', name: 'alpha' } });
    applySelection({ action: { type: 'single', name: 'charlie' } });
    expect(selectionState.value.selectedNames).toEqual(new Set(['charlie']));
  });

  // ---- toggle ----

  it('toggle action adds an entry when not selected', () => {
    const { selectionState, applySelection } = useFileExplorerSelection();
    applySelection({ action: { type: 'toggle', name: 'alpha' } });
    applySelection({ action: { type: 'toggle', name: 'charlie' } });
    expect(selectionState.value.selectedNames).toEqual(new Set(['alpha', 'charlie']));
  });

  it('toggle action removes an entry when already selected', () => {
    const { selectionState, applySelection } = useFileExplorerSelection();
    applySelection({ action: { type: 'toggle', name: 'alpha' } });
    applySelection({ action: { type: 'toggle', name: 'alpha' } });
    expect(selectionState.value.selectedNames.size).toBe(0);
  });

  // ---- range ----

  it('range action selects entries between anchor and target (forward)', () => {
    const { selectionState, applySelection } = useFileExplorerSelection();
    applySelection({ action: { type: 'single', name: 'bravo' } }); // sets anchor
    applySelection({ action: { type: 'range', name: 'delta', allEntries: entries } });
    expect(selectionState.value.selectedNames).toEqual(new Set(['bravo', 'charlie', 'delta']));
    expect(selectionState.value.focusName).toBe('delta');
    expect(selectionState.value.anchorName).toBe('bravo'); // anchor preserved
  });

  it('range action selects entries between anchor and target (backward)', () => {
    const { selectionState, applySelection } = useFileExplorerSelection();
    applySelection({ action: { type: 'single', name: 'delta' } });
    applySelection({ action: { type: 'range', name: 'alpha', allEntries: entries } });
    expect(selectionState.value.selectedNames).toEqual(new Set(['alpha', 'bravo', 'charlie', 'delta']));
  });

  it('range without anchor falls back to single selection', () => {
    const { selectionState, applySelection } = useFileExplorerSelection();
    applySelection({ action: { type: 'range', name: 'charlie', allEntries: entries } });
    expect(selectionState.value.selectedNames).toEqual(new Set(['charlie']));
  });

  it('range with same anchor and target selects single entry', () => {
    const { selectionState, applySelection } = useFileExplorerSelection();
    applySelection({ action: { type: 'single', name: 'bravo' } });
    applySelection({ action: { type: 'range', name: 'bravo', allEntries: entries } });
    expect(selectionState.value.selectedNames).toEqual(new Set(['bravo']));
  });

  // ---- all ----

  it('all action selects all entries', () => {
    const { selectionState, applySelection } = useFileExplorerSelection();
    applySelection({ action: { type: 'all', allEntries: entries } });
    expect(selectionState.value.selectedNames).toEqual(new Set(entries.map(e => e.name)));
    expect(selectionState.value.anchorName).toBe('alpha');
    expect(selectionState.value.focusName).toBe('echo');
  });

  // ---- clear ----

  it('clear action resets selection', () => {
    const { selectionState, applySelection } = useFileExplorerSelection();
    applySelection({ action: { type: 'all', allEntries: entries } });
    applySelection({ action: { type: 'clear' } });
    expect(selectionState.value.selectedNames.size).toBe(0);
    expect(selectionState.value.anchorName).toBeUndefined();
    expect(selectionState.value.focusName).toBeUndefined();
  });

  // ---- getSelectedEntries ----

  it('getSelectedEntries returns matching entries from allEntries', () => {
    const { applySelection, getSelectedEntries } = useFileExplorerSelection();
    applySelection({ action: { type: 'single', name: 'charlie' } });
    const selected = getSelectedEntries({ allEntries: entries });
    expect(selected).toHaveLength(1);
    expect(selected[0]!.name).toBe('charlie');
  });

  it('getSelectedEntries returns empty array when no selection', () => {
    const { getSelectedEntries } = useFileExplorerSelection();
    expect(getSelectedEntries({ allEntries: entries })).toHaveLength(0);
  });

  // ---- moveFocus ----

  it('moveFocus next moves to next entry', () => {
    const { selectionState, applySelection, moveFocus } = useFileExplorerSelection();
    applySelection({ action: { type: 'single', name: 'bravo' } });
    moveFocus({ direction: 'next', allEntries: entries, extend: false });
    expect(selectionState.value.focusName).toBe('charlie');
    expect(selectionState.value.selectedNames).toEqual(new Set(['charlie']));
  });

  it('moveFocus prev moves to previous entry', () => {
    const { selectionState, applySelection, moveFocus } = useFileExplorerSelection();
    applySelection({ action: { type: 'single', name: 'charlie' } });
    moveFocus({ direction: 'prev', allEntries: entries, extend: false });
    expect(selectionState.value.focusName).toBe('bravo');
  });

  it('moveFocus next clamps at last entry', () => {
    const { selectionState, applySelection, moveFocus } = useFileExplorerSelection();
    applySelection({ action: { type: 'single', name: 'echo' } });
    moveFocus({ direction: 'next', allEntries: entries, extend: false });
    expect(selectionState.value.focusName).toBe('echo');
  });

  it('moveFocus prev clamps at first entry', () => {
    const { selectionState, applySelection, moveFocus } = useFileExplorerSelection();
    applySelection({ action: { type: 'single', name: 'alpha' } });
    moveFocus({ direction: 'prev', allEntries: entries, extend: false });
    expect(selectionState.value.focusName).toBe('alpha');
  });

  it('moveFocus with extend=true extends range selection', () => {
    const { selectionState, applySelection, moveFocus } = useFileExplorerSelection();
    applySelection({ action: { type: 'single', name: 'bravo' } }); // anchor = bravo
    moveFocus({ direction: 'next', allEntries: entries, extend: true });
    expect(selectionState.value.selectedNames).toEqual(new Set(['bravo', 'charlie']));
  });

  it('moveFocus does nothing on empty entries', () => {
    const { selectionState, moveFocus } = useFileExplorerSelection();
    moveFocus({ direction: 'next', allEntries: [], extend: false });
    expect(selectionState.value.focusName).toBeUndefined();
  });

  // ---- clearSelectionForNewDirectory ----

  it('clearSelectionForNewDirectory resets state', () => {
    const { selectionState, applySelection, clearSelectionForNewDirectory } = useFileExplorerSelection();
    applySelection({ action: { type: 'all', allEntries: entries } });
    clearSelectionForNewDirectory();
    expect(selectionState.value.selectedNames.size).toBe(0);
    expect(selectionState.value.anchorName).toBeUndefined();
    expect(selectionState.value.focusName).toBeUndefined();
  });
});
