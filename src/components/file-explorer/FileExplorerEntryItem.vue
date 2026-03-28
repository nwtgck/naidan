<script setup lang="ts">
import { ChevronRight, Lock } from 'lucide-vue-next';
import FileExplorerEntryIcon from './FileExplorerEntryIcon.vue';
import FileExplorerRenameInput from './FileExplorerRenameInput.vue';
import type { FileExplorerEntry } from './types';
import { formatSize, formatDate } from './utils';

const props = defineProps<{
  entry: FileExplorerEntry;
  isSelected: boolean;
  isFocused: boolean;
  isRenaming: boolean;
  isCut: boolean;
  isDragTarget: boolean;
  displayMode: 'icon' | 'list' | 'column';
}>();

const emit = defineEmits<{
  (e: 'click', payload: { event: MouseEvent }): void;
  (e: 'dblclick'): void;
  (e: 'contextmenu', payload: { event: MouseEvent }): void;
  (e: 'rename-confirm', payload: { newName: string }): void;
  (e: 'rename-cancel'): void;
  (e: 'dragstart', payload: { event: DragEvent }): void;
  (e: 'dragover', payload: { event: DragEvent }): void;
  (e: 'dragleave'): void;
  (e: 'drop', payload: { event: DragEvent }): void;
}>();


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <!-- LIST MODE ROW -->
  <div
    v-if="displayMode === 'list'"
    :data-testid="`entry-item-${entry.name}`"
    class="group flex items-center gap-3 px-3 py-0 h-9 cursor-pointer select-none rounded-md transition-all"
    :class="[
      isSelected
        ? 'bg-blue-500 text-white'
        : isFocused
          ? 'bg-gray-100 dark:bg-gray-800'
          : 'hover:bg-gray-50 dark:hover:bg-gray-800/60',
      isDragTarget ? 'ring-2 ring-blue-400 ring-inset' : '',
      isCut ? 'opacity-50' : '',
    ]"
    :draggable="!isRenaming"
    @click="emit('click', { event: $event })"
    @dblclick="emit('dblclick')"
    @contextmenu="emit('contextmenu', { event: $event })"
    @dragstart="emit('dragstart', { event: $event })"
    @dragover.prevent="emit('dragover', { event: $event })"
    @dragleave="emit('dragleave')"
    @drop.prevent="emit('drop', { event: $event })"
  >
    <FileExplorerEntryIcon
      :kind="entry.kind"
      :extension="entry.extension"
      :mime-category="entry.mimeCategory"
      size="sm"
    />
    <div class="flex-1 min-w-0">
      <FileExplorerRenameInput
        v-if="isRenaming"
        :current-name="entry.name"
        @confirm="emit('rename-confirm', { newName: $event })"
        @cancel="emit('rename-cancel')"
      />
      <span v-else class="text-xs truncate block" :class="isSelected ? 'text-white' : 'text-gray-800 dark:text-gray-200'">
        {{ entry.name }}
      </span>
    </div>
    <Lock
      v-if="entry.kind === 'directory' && entry.readOnly"
      class="w-2.5 h-2.5 shrink-0 opacity-50"
      :class="isSelected ? 'text-white' : 'text-gray-400 dark:text-gray-500'"
      data-testid="entry-lock-icon"
    />
    <span class="text-[10px] font-mono w-16 text-right shrink-0" :class="isSelected ? 'text-blue-100' : 'text-gray-400 dark:text-gray-500'">
      {{ entry.kind === 'file' ? formatSize({ bytes: entry.size }) : '' }}
    </span>
    <span class="text-[10px] w-28 text-right shrink-0 hidden md:block" :class="isSelected ? 'text-blue-100' : 'text-gray-400 dark:text-gray-500'">
      {{ entry.kind === 'file' ? formatDate({ timestamp: entry.lastModified }) : '' }}
    </span>
    <span class="text-[10px] w-16 text-right shrink-0 hidden lg:block uppercase" :class="isSelected ? 'text-blue-100' : 'text-gray-400 dark:text-gray-500'">
      {{ entry.kind === 'file' ? (entry.extension || '—') : 'Folder' }}
    </span>
  </div>

  <!-- ICON MODE CARD -->
  <div
    v-else-if="displayMode === 'icon'"
    :data-testid="`entry-item-${entry.name}`"
    class="group flex flex-col items-center gap-1.5 p-2 rounded-xl cursor-pointer select-none transition-all w-24"
    :class="[
      isSelected
        ? 'bg-blue-500 text-white'
        : isFocused
          ? 'bg-gray-100 dark:bg-gray-800'
          : 'hover:bg-gray-100 dark:hover:bg-gray-800',
      isDragTarget ? 'ring-2 ring-blue-400 ring-inset' : '',
      isCut ? 'opacity-50' : '',
    ]"
    :draggable="!isRenaming"
    @click="emit('click', { event: $event })"
    @dblclick="emit('dblclick')"
    @contextmenu="emit('contextmenu', { event: $event })"
    @dragstart="emit('dragstart', { event: $event })"
    @dragover.prevent="emit('dragover', { event: $event })"
    @dragleave="emit('dragleave')"
    @drop.prevent="emit('drop', { event: $event })"
  >
    <FileExplorerEntryIcon
      :kind="entry.kind"
      :extension="entry.extension"
      :mime-category="entry.mimeCategory"
      size="lg"
    />
    <FileExplorerRenameInput
      v-if="isRenaming"
      :current-name="entry.name"
      @confirm="emit('rename-confirm', { newName: $event })"
      @cancel="emit('rename-cancel')"
    />
    <span
      v-else
      class="text-[11px] text-center leading-tight break-all line-clamp-2 w-full px-1"
      :class="isSelected ? 'text-white' : 'text-gray-700 dark:text-gray-300'"
    >{{ entry.name }}</span>
    <Lock
      v-if="entry.kind === 'directory' && entry.readOnly"
      class="w-2.5 h-2.5 shrink-0 opacity-50 absolute top-1 right-1"
      :class="isSelected ? 'text-white' : 'text-gray-400 dark:text-gray-500'"
      data-testid="entry-lock-icon"
    />
  </div>

  <!-- COLUMN MODE ROW -->
  <div
    v-else-if="displayMode === 'column'"
    :data-testid="`entry-item-${entry.name}`"
    class="flex items-center gap-2 px-2 py-1.5 cursor-pointer select-none rounded-md transition-all"
    :class="[
      isSelected
        ? 'bg-blue-500 text-white'
        : isFocused
          ? 'bg-gray-100 dark:bg-gray-800'
          : 'hover:bg-gray-100 dark:hover:bg-gray-800',
      isCut ? 'opacity-50' : '',
    ]"
    @click="emit('click', { event: $event })"
    @dblclick="emit('dblclick')"
    @contextmenu="emit('contextmenu', { event: $event })"
  >
    <FileExplorerEntryIcon
      :kind="entry.kind"
      :extension="entry.extension"
      :mime-category="entry.mimeCategory"
      size="sm"
    />
    <FileExplorerRenameInput
      v-if="isRenaming"
      :current-name="entry.name"
      @confirm="emit('rename-confirm', { newName: $event })"
      @cancel="emit('rename-cancel')"
    />
    <span v-else class="text-xs flex-1 truncate" :class="isSelected ? 'text-white' : 'text-gray-700 dark:text-gray-300'">
      {{ entry.name }}
    </span>
    <Lock
      v-if="entry.kind === 'directory' && entry.readOnly"
      class="w-2.5 h-2.5 shrink-0 opacity-50"
      :class="isSelected ? 'text-white' : 'text-gray-400 dark:text-gray-500'"
      data-testid="entry-lock-icon"
    />
    <ChevronRight
      v-if="entry.kind === 'directory'"
      class="w-3 h-3 shrink-0"
      :class="isSelected ? 'text-blue-100' : 'text-gray-400'"
    />
  </div>
</template>
