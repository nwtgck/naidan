<script setup lang="ts">
import { inject, computed, ref } from 'vue';
import { onClickOutside } from '@vueuse/core';
import {
  FolderOpen, Pencil, Trash2, Copy, Scissors, ClipboardPaste,
  Download, Info, FilePlus, FolderPlus, CheckSquare,
} from 'lucide-vue-next';
import { FILE_EXPLORER_INJECTION_KEY } from './useFileExplorer';
import type { ContextMenuAction } from './types';

const ctx = inject(FILE_EXPLORER_INJECTION_KEY)!;

const menuRef = ref<HTMLElement | null>(null);

onClickOutside(menuRef, () => {
  ctx.hideContextMenu();
});

const isVisible = computed(() => ctx.contextMenuState.visibility === 'visible');
const target = computed(() => ctx.contextMenuState.target);

const hasClipboard = computed(() =>
  ctx.clipboardState.operation !== undefined && ctx.clipboardState.entries.length > 0,
);

type MenuItem =
  | { type: 'action'; action: ContextMenuAction; label: string; icon: unknown; danger?: boolean; disabled?: boolean; disabledReason?: string }
  | { type: 'divider' };

const menuItems = computed<MenuItem[]>(() => {
  const readOnly = ctx.readOnly;
  const lockedReason = readOnly ? 'Unlock to enable' : undefined;

  switch (target.value.kind) {
  case 'entry': {
    const firstEntry = target.value.selectedEntries[0];
    const isSingleFile =
      target.value.selectedEntries.length === 1 &&
      firstEntry?.kind === 'file';

    const items: MenuItem[] = [
      { type: 'action', action: 'open', label: 'Open', icon: FolderOpen },
      { type: 'action', action: 'rename', label: 'Rename', icon: Pencil, disabled: readOnly, disabledReason: lockedReason },
    ];

    items.push({ type: 'divider' });
    items.push({ type: 'action', action: 'copy', label: 'Copy', icon: Copy });
    items.push({ type: 'action', action: 'cut', label: 'Cut', icon: Scissors, disabled: readOnly, disabledReason: lockedReason });

    if (hasClipboard.value) {
      items.push({ type: 'action', action: 'paste', label: 'Paste', icon: ClipboardPaste, disabled: readOnly, disabledReason: lockedReason });
    }

    items.push({ type: 'divider' });

    if (isSingleFile) {
      items.push({ type: 'action', action: 'download', label: 'Download', icon: Download });
    }

    items.push({ type: 'action', action: 'getInfo', label: 'Get Info', icon: Info });
    items.push({ type: 'divider' });
    items.push({ type: 'action', action: 'delete', label: 'Delete', icon: Trash2, danger: true, disabled: readOnly, disabledReason: lockedReason });

    return items;
  }
  case 'background': {
    const items: MenuItem[] = [
      { type: 'action', action: 'newFile', label: 'New File', icon: FilePlus, disabled: readOnly, disabledReason: lockedReason },
      { type: 'action', action: 'newFolder', label: 'New Folder', icon: FolderPlus, disabled: readOnly, disabledReason: lockedReason },
    ];

    if (hasClipboard.value) {
      items.push({ type: 'divider' });
      items.push({ type: 'action', action: 'paste', label: 'Paste', icon: ClipboardPaste, disabled: readOnly, disabledReason: lockedReason });
    }

    items.push({ type: 'divider' });
    items.push({ type: 'action', action: 'selectAll', label: 'Select All', icon: CheckSquare });

    return items;
  }
  default: {
    const _ex: never = target.value;
    throw new Error(`Unhandled context menu target: ${JSON.stringify(_ex)}`);
  }
  }
});


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="isVisible"
      ref="menuRef"
      class="fixed z-[500] min-w-[180px] py-1 bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-700 rounded-xl shadow-2xl backdrop-blur-md"
      :style="{ left: `${ctx.contextMenuState.x}px`, top: `${ctx.contextMenuState.y}px` }"
      data-testid="context-menu"
    >
      <template v-for="(item, i) in menuItems" :key="i">
        <hr v-if="item.type === 'divider'" class="my-1 border-gray-100 dark:border-gray-700" />
        <button
          v-else-if="item.type === 'action'"
          class="flex items-center gap-2.5 w-full px-3 py-1.5 text-xs font-medium transition-colors text-left"
          :class="item.disabled
            ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
            : item.danger
              ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'"
          :disabled="item.disabled"
          :title="item.disabled && item.disabledReason ? item.disabledReason : undefined"
          @click="!item.disabled && ctx.executeContextAction({ action: item.action })"
        >
          <component :is="item.icon" class="w-4 h-4 shrink-0 opacity-70" />
          {{ item.label }}
        </button>
      </template>
    </div>
  </Teleport>
</template>
