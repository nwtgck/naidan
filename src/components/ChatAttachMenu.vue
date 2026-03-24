<script setup lang="ts">
import { ref } from 'vue';
import { onClickOutside } from '@vueuse/core';
import { Plus, Files, FolderSymlink, FolderDown, Info } from 'lucide-vue-next';

const props = defineProps<{
  hasFileSystemAccess: boolean;
}>();

const emit = defineEmits<{
  (e: 'files-selected', files: File[]): void;
  (e: 'folder-copy', folderName: string, files: File[]): void;
  (e: 'folder-link'): void;
}>();

const fileInputRef = ref<HTMLInputElement | null>(null);
const folderInputRef = ref<HTMLInputElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);
const isOpen = ref(false);
const isFolderLinkInfoOpen = ref(false);
const isFolderCopyInfoOpen = ref(false);

onClickOutside(menuRef, () => {
  isOpen.value = false;
  isFolderLinkInfoOpen.value = false;
  isFolderCopyInfoOpen.value = false;
});

function handleFileInputChange(event: Event) {
  const target = event.target as HTMLInputElement;
  const files = Array.from(target.files ?? []);
  target.value = '';
  if (files.length > 0) emit('files-selected', files);
}

function handleFolderInputChange(event: Event) {
  const target = event.target as HTMLInputElement;
  const files = Array.from(target.files ?? []);
  target.value = '';
  if (files.length === 0) return;
  const folderName = files[0]!.webkitRelativePath.split('/')[0] ?? 'folder';
  emit('folder-copy', folderName, files);
}

function handleFolderLink() {
  isOpen.value = false;
  isFolderLinkInfoOpen.value = false;
  isFolderCopyInfoOpen.value = false;
  emit('folder-link');
}

defineExpose({
  __testOnly: {},
});
</script>

<template>
  <div class="relative" ref="menuRef">
    <input ref="fileInputRef" type="file" multiple class="hidden" @change="handleFileInputChange" data-testid="attach-file-input" />
    <input ref="folderInputRef" type="file" webkitdirectory class="hidden" @change="handleFolderInputChange" data-testid="attach-folder-input" />

    <button
      @click="isOpen = !isOpen"
      class="p-2 rounded-xl text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      title="Attach files or folder"
      data-testid="attach-button"
    >
      <Plus class="w-5 h-5" />
    </button>

    <div
      v-if="isOpen"
      class="absolute bottom-full mb-2 left-0 z-50 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl shadow-2xl overflow-hidden w-56"
    >
      <!-- Files -->
      <button
        @click="fileInputRef?.click(); isOpen = false"
        class="flex items-center gap-2.5 w-full px-3 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors text-left"
        data-testid="attach-files-button"
      >
        <Files class="w-4 h-4 shrink-0 text-gray-400 dark:text-gray-500" />
        Files
      </button>

      <!-- Folder (link) -->
      <div class="border-t border-gray-100 dark:border-gray-700">
        <!-- Available -->
        <div v-if="props.hasFileSystemAccess" class="flex items-stretch">
          <button
            @click="handleFolderLink"
            class="flex items-center gap-2.5 flex-1 px-3 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors text-left"
            data-testid="attach-folder-link-button"
          >
            <FolderSymlink class="w-4 h-4 shrink-0 text-gray-400 dark:text-gray-500" />
            Folder (link)
          </button>
          <button
            @click.stop="isFolderLinkInfoOpen = !isFolderLinkInfoOpen; isFolderCopyInfoOpen = false"
            class="flex items-center px-2.5 transition-colors border-l border-gray-100 dark:border-gray-700"
            :class="isFolderLinkInfoOpen ? 'text-blue-500' : 'text-gray-400 dark:text-gray-500 hover:text-blue-500'"
            title="What is Folder (link)?"
          >
            <Info class="w-3.5 h-3.5" />
          </button>
        </div>
        <!-- Unavailable -->
        <div v-else class="flex items-stretch">
          <button
            disabled
            class="flex items-center gap-2.5 flex-1 px-3 py-2.5 text-sm font-medium text-gray-300 dark:text-gray-600 cursor-not-allowed text-left"
          >
            <FolderSymlink class="w-4 h-4 shrink-0" />
            Folder (link)
          </button>
          <button
            @click.stop="isFolderLinkInfoOpen = !isFolderLinkInfoOpen; isFolderCopyInfoOpen = false"
            class="flex items-center px-2.5 transition-colors border-l border-gray-100 dark:border-gray-700"
            :class="isFolderLinkInfoOpen ? 'text-blue-500' : 'text-gray-300 dark:text-gray-600 hover:text-blue-500'"
            title="Why is Folder (link) unavailable?"
          >
            <Info class="w-3.5 h-3.5" />
          </button>
        </div>
        <!-- Info panel for link -->
        <div v-if="isFolderLinkInfoOpen" class="px-3 py-2.5 bg-blue-50 dark:bg-blue-950/30 border-t border-blue-100 dark:border-blue-900/40 space-y-1">
          <p class="text-[11px] font-bold text-blue-700 dark:text-blue-400">Requires a Chromium-based browser</p>
          <p class="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">Chrome, Edge, Brave, Opera — over HTTPS. Links your folder directly without copying.</p>
        </div>
      </div>

      <!-- Folder (copy) -->
      <div class="border-t border-gray-100 dark:border-gray-700">
        <div class="flex items-stretch">
          <button
            @click="folderInputRef?.click(); isOpen = false"
            class="flex items-center gap-2.5 flex-1 px-3 py-2.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200 transition-colors text-left"
            data-testid="attach-folder-copy-button"
          >
            <FolderDown class="w-4 h-4 shrink-0 text-gray-400 dark:text-gray-500" />
            Folder (copy)
          </button>
          <button
            @click.stop="isFolderCopyInfoOpen = !isFolderCopyInfoOpen; isFolderLinkInfoOpen = false"
            class="flex items-center px-2.5 transition-colors border-l border-gray-100 dark:border-gray-700"
            :class="isFolderCopyInfoOpen ? 'text-blue-500' : 'text-gray-400 dark:text-gray-500 hover:text-blue-500'"
            title="What is Folder (copy)?"
          >
            <Info class="w-3.5 h-3.5" />
          </button>
        </div>
        <!-- Info panel for copy -->
        <div v-if="isFolderCopyInfoOpen" class="px-3 py-2.5 bg-blue-50 dark:bg-blue-950/30 border-t border-blue-100 dark:border-blue-900/40 space-y-1">
          <p class="text-[11px] font-bold text-blue-700 dark:text-blue-400">A private copy is saved in your browser</p>
          <p class="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">Naidan works from the copy — your original files on disk stay safe and intact.</p>
        </div>
      </div>
    </div>
  </div>
</template>
