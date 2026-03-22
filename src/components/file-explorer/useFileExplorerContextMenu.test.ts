import { describe, it, expect } from 'vitest';
import { useFileExplorerContextMenu } from './useFileExplorerContextMenu';
import type { ContextMenuTarget } from './types';

function makeMouseEvent(x: number, y: number): MouseEvent {
  return {
    clientX: x,
    clientY: y,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  } as unknown as MouseEvent;
}

const entryTarget: ContextMenuTarget = {
  kind: 'entry',
  entry: {
    name: 'file.txt',
    kind: 'file',
    handle: {} as FileSystemHandle,
    size: 100,
    lastModified: Date.now(),
    extension: '.txt',
    mimeCategory: 'text',
  },
  selectedEntries: [],
};

describe('useFileExplorerContextMenu', () => {
  it('starts hidden', () => {
    const { contextMenuState } = useFileExplorerContextMenu();
    expect(contextMenuState.value.visibility).toBe('hidden');
  });

  it('showContextMenu sets visibility to visible', () => {
    const { contextMenuState, showContextMenu } = useFileExplorerContextMenu();
    showContextMenu({ event: makeMouseEvent(100, 200), target: entryTarget });
    expect(contextMenuState.value.visibility).toBe('visible');
  });

  it('showContextMenu stores the target', () => {
    const { contextMenuState, showContextMenu } = useFileExplorerContextMenu();
    showContextMenu({ event: makeMouseEvent(50, 80), target: entryTarget });
    expect(contextMenuState.value.target).toEqual(entryTarget);
  });

  it('showContextMenu stores clamped position', () => {
    const { contextMenuState, showContextMenu } = useFileExplorerContextMenu();
    showContextMenu({ event: makeMouseEvent(50, 80), target: { kind: 'background' } });
    // Position should be <= click coordinates (clamping to viewport)
    expect(contextMenuState.value.x).toBeLessThanOrEqual(50);
    expect(contextMenuState.value.y).toBeLessThanOrEqual(80);
  });

  it('showContextMenu clamps x when near right edge', () => {
    const { contextMenuState, showContextMenu } = useFileExplorerContextMenu();
    // Far right of viewport — should be clamped
    showContextMenu({ event: makeMouseEvent(99999, 100), target: { kind: 'background' } });
    expect(contextMenuState.value.x).toBeLessThan(99999);
  });

  it('showContextMenu clamps y when near bottom edge', () => {
    const { contextMenuState, showContextMenu } = useFileExplorerContextMenu();
    showContextMenu({ event: makeMouseEvent(100, 99999), target: { kind: 'background' } });
    expect(contextMenuState.value.y).toBeLessThan(99999);
  });

  it('hideContextMenu sets visibility to hidden', () => {
    const { contextMenuState, showContextMenu, hideContextMenu } = useFileExplorerContextMenu();
    showContextMenu({ event: makeMouseEvent(10, 10), target: { kind: 'background' } });
    expect(contextMenuState.value.visibility).toBe('visible');
    hideContextMenu();
    expect(contextMenuState.value.visibility).toBe('hidden');
  });

  it('hideContextMenu preserves x, y, and target', () => {
    const { contextMenuState, showContextMenu, hideContextMenu } = useFileExplorerContextMenu();
    showContextMenu({ event: makeMouseEvent(50, 60), target: entryTarget });
    const xBefore = contextMenuState.value.x;
    const yBefore = contextMenuState.value.y;
    hideContextMenu();
    expect(contextMenuState.value.x).toBe(xBefore);
    expect(contextMenuState.value.y).toBe(yBefore);
    expect(contextMenuState.value.target).toEqual(entryTarget);
  });

  it('background target is stored correctly', () => {
    const { contextMenuState, showContextMenu } = useFileExplorerContextMenu();
    showContextMenu({ event: makeMouseEvent(10, 10), target: { kind: 'background' } });
    expect(contextMenuState.value.target.kind).toBe('background');
  });
});
