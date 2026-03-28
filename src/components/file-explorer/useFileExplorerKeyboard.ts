import type { FileExplorerContext } from './types';

export function useFileExplorerKeyboard({ ctx }: { ctx: FileExplorerContext }) {
  async function handleKeyDown({ event }: { event: KeyboardEvent }): Promise<void> {
    const isCtrlOrCmd = event.ctrlKey || event.metaKey;

    // Escape: clear selection, close context menu, cancel rename
    if (event.key === 'Escape') {
      switch (ctx.contextMenuState.visibility) {
      case 'visible':
        ctx.hideContextMenu();
        return;
      case 'hidden':
        break;
      default: {
        const _ex: never = ctx.contextMenuState.visibility;
        void _ex;
      }
      }
      if (ctx.renamingEntryName !== undefined) {
        ctx.cancelRename();
        return;
      }
      ctx.applySelection({ action: { type: 'clear' } });
      return;
    }

    // Don't intercept when renaming
    if (ctx.renamingEntryName !== undefined) return;

    // Ctrl/Cmd+A: select all
    if (isCtrlOrCmd && event.key === 'a') {
      event.preventDefault();
      ctx.applySelection({ action: { type: 'all', allEntries: ctx.sortedFilteredEntries } });
      return;
    }

    // Ctrl/Cmd+C: copy
    if (isCtrlOrCmd && event.key === 'c') {
      event.preventDefault();
      if (ctx.selectedEntries.length > 0) {
        ctx.clipboardCopy({ entries: ctx.selectedEntries });
      }
      return;
    }

    // Ctrl/Cmd+X: cut
    if (isCtrlOrCmd && event.key === 'x') {
      event.preventDefault();
      if (ctx.selectedEntries.length > 0) {
        ctx.clipboardCut({ entries: ctx.selectedEntries });
      }
      return;
    }

    // Ctrl/Cmd+V: paste
    if (isCtrlOrCmd && event.key === 'v') {
      event.preventDefault();
      await ctx.clipboardPaste();
      return;
    }

    // Delete / Backspace: delete selected
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (ctx.selectedEntries.length > 0) {
        event.preventDefault();
        await ctx.deleteEntries({ entries: ctx.selectedEntries });
        ctx.applySelection({ action: { type: 'clear' } });
      }
      return;
    }

    // F2: rename focused entry
    if (event.key === 'F2') {
      const focused = ctx.sortedFilteredEntries.find(
        e => e.name === ctx.selectionState.focusName,
      );
      if (focused) {
        event.preventDefault();
        ctx.startRename({ entry: focused });
      }
      return;
    }

    // Enter: open focused entry
    if (event.key === 'Enter') {
      const focused = ctx.sortedFilteredEntries.find(
        e => e.name === ctx.selectionState.focusName,
      );
      if (focused) {
        event.preventDefault();
        switch (focused.kind) {
        case 'directory':
          await ctx.navigateToDirectory({ directory: focused.directory! });
          ctx.applySelection({ action: { type: 'clear' } });
          break;
        case 'file':
          await ctx.loadPreview({ entry: focused });
          break;
        default: {
          const _ex: never = focused.kind;
          throw new Error(`Unhandled kind: ${_ex}`);
        }
        }
      }
      return;
    }

    // Space: Quick Look — toggle preview for focused entry
    if (event.key === ' ' && !isCtrlOrCmd) {
      const focused = ctx.sortedFilteredEntries.find(
        e => e.name === ctx.selectionState.focusName,
      );
      if (focused) {
        switch (focused.kind) {
        case 'file': {
          event.preventDefault();
          switch (ctx.previewState.visibility) {
          case 'visible':
            if (ctx.previewState.entry?.name === focused.name) {
              ctx.togglePreviewVisibility();
            } else {
              await ctx.loadPreview({ entry: focused });
            }
            break;
          case 'hidden':
            ctx.togglePreviewVisibility();
            await ctx.loadPreview({ entry: focused });
            break;
          default: {
            const _ex: never = ctx.previewState.visibility;
            void _ex;
          }
          }
          break;
        }
        case 'directory':
          break;
        default: {
          const _ex: never = focused.kind;
          throw new Error(`Unhandled kind: ${_ex}`);
        }
        }
      }
      return;
    }

    // Arrow navigation
    if (ctx.sortedFilteredEntries.length === 0) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      ctx.moveFocus({ direction: 'next', extend: event.shiftKey });
      return;
    }

    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      ctx.moveFocus({ direction: 'prev', extend: event.shiftKey });
      return;
    }
  }

  return { handleKeyDown,
    __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
    }, };
}
