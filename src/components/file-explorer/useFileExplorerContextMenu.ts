import { ref } from 'vue';
import type { ContextMenuState, ContextMenuTarget } from './types';

export function useFileExplorerContextMenu() {
  const contextMenuState = ref<ContextMenuState>({
    visibility: 'hidden',
    x: 0,
    y: 0,
    target: { kind: 'background' },
  });

  function showContextMenu({
    event,
    target,
  }: {
    event: MouseEvent;
    target: ContextMenuTarget;
  }): void {
    event.preventDefault();
    event.stopPropagation();

    // Clamp position to viewport
    const MENU_WIDTH = 200;
    const MENU_HEIGHT = 300;
    const x = Math.min(event.clientX, window.innerWidth - MENU_WIDTH);
    const y = Math.min(event.clientY, window.innerHeight - MENU_HEIGHT);

    contextMenuState.value = {
      visibility: 'visible',
      x,
      y,
      target,
    };
  }

  function hideContextMenu(): void {
    contextMenuState.value = { ...contextMenuState.value, visibility: 'hidden' };
  }

  return {
    contextMenuState,
    showContextMenu,
    hideContextMenu,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
