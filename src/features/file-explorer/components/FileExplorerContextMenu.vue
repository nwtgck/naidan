<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { inject, computed, ref } from 'vue';
import { onClickOutside } from '@vueuse/core';
import {
  FolderOpenIcon, PencilIcon, Trash2Icon, CopyIcon, ScissorsIcon, ClipboardPasteIcon,
  DownloadIcon, InfoIcon, FilePlusIcon, FolderPlusIcon, CheckSquareIcon,
} from 'lucide-vue-next';
import { FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';
import type { ContextMenuAction } from '@/features/file-explorer/logic/types';

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
  | { type: 'action', action: ContextMenuAction, label: string, icon: unknown, danger?: boolean, disabled?: boolean, disabledReason?: string }
  | { type: 'divider' };

type MenuItemDraft =
  | { type: 'action', action: ContextMenuAction, label: string | undefined, icon: unknown, danger?: boolean, disabled?: boolean, disabledReason?: string }
  | { type: 'divider' };

function resolveMenuItems({ items }: { items: MenuItemDraft[] }): MenuItem[] {
  const resolved: MenuItem[] = [];
  for (const item of items) {
    switch (item.type) {
    case 'divider':
      resolved.push(item);
      break;
    case 'action':
      if (item.label === undefined) return [];
      resolved.push({ ...item, label: item.label });
      break;
    default: {
      const _ex: never = item;
      throw new Error(`Unhandled context menu item: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return resolved;
}

const menuItems = computed<MenuItem[]>(() => {
  const readOnly = ctx.readOnly;
  const lockedReason = readOnly ? lazyStrings.fileExplorer__unlock_to_enable() : undefined;

  switch (target.value.kind) {
  case 'entry': {
    const firstEntry = target.value.selectedEntries[0];
    const isSingleEntry =
      target.value.selectedEntries.length === 1 &&
      firstEntry !== undefined;

    const items: MenuItemDraft[] = [
      { type: 'action', action: 'open', label: lazyStrings.fileExplorer__open(), icon: FolderOpenIcon },
      { type: 'action', action: 'rename', label: lazyStrings.fileExplorer__rename(), icon: PencilIcon, disabled: readOnly, disabledReason: lockedReason },
    ];

    items.push({ type: 'divider' });
    items.push({ type: 'action', action: 'copy', label: lazyStrings.fileExplorer__copy(), icon: CopyIcon });
    items.push({ type: 'action', action: 'cut', label: lazyStrings.fileExplorer__cut(), icon: ScissorsIcon, disabled: readOnly, disabledReason: lockedReason });

    if (hasClipboard.value) {
      items.push({ type: 'action', action: 'paste', label: lazyStrings.fileExplorer__paste(), icon: ClipboardPasteIcon, disabled: readOnly, disabledReason: lockedReason });
    }

    items.push({ type: 'divider' });

    if (isSingleEntry) {
      items.push({ type: 'action', action: 'download', label: lazyStrings.fileExplorer__download(), icon: DownloadIcon });
    }

    items.push({ type: 'action', action: 'getInfo', label: lazyStrings.fileExplorer__get_info(), icon: InfoIcon });
    items.push({ type: 'divider' });
    items.push({ type: 'action', action: 'delete', label: lazyStrings.fileExplorer__delete(), icon: Trash2Icon, danger: true, disabled: readOnly, disabledReason: lockedReason });

    return resolveMenuItems({ items });
  }
  case 'background': {
    const items: MenuItemDraft[] = [
      { type: 'action', action: 'newFile', label: lazyStrings.fileExplorer__new_file(), icon: FilePlusIcon, disabled: readOnly, disabledReason: lockedReason },
      { type: 'action', action: 'newFolder', label: lazyStrings.fileExplorer__new_folder(), icon: FolderPlusIcon, disabled: readOnly, disabledReason: lockedReason },
    ];

    if (hasClipboard.value) {
      items.push({ type: 'divider' });
      items.push({ type: 'action', action: 'paste', label: lazyStrings.fileExplorer__paste(), icon: ClipboardPasteIcon, disabled: readOnly, disabledReason: lockedReason });
    }

    items.push({ type: 'divider' });
    items.push({ type: 'action', action: 'selectAll', label: lazyStrings.fileExplorer__select_all(), icon: CheckSquareIcon });

    return resolveMenuItems({ items });
  }
  default: {
    const _ex: never = target.value;
    throw new Error(`Unhandled context menu target: ${JSON.stringify(_ex)}`);
  }
  }
});


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
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
