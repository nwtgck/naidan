<script setup lang="ts">
import { inject, computed } from 'vue';
import { Braces, Download, FileText, Loader2, AlertCircle, X } from 'lucide-vue-next';
import FileExplorerEntryIcon from './FileExplorerEntryIcon.vue';
import { FILE_EXPLORER_INJECTION_KEY } from './useFileExplorer';
import { formatSize, formatDate } from './utils';

const ctx = inject(FILE_EXPLORER_INJECTION_KEY)!;

const s = computed(() => ctx.previewState);
const entry = computed(() => s.value.entry);


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="w-72 shrink-0 border-l border-gray-100 dark:border-gray-800 flex flex-col overflow-hidden bg-gray-50/30 dark:bg-black/20" data-testid="preview-panel">
    <!-- Header -->
    <div class="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-gray-800 shrink-0">
      <div class="flex items-center gap-2 min-w-0">
        <FileExplorerEntryIcon
          v-if="entry"
          :kind="entry.kind"
          :extension="entry.extension"
          :mime-category="entry.mimeCategory"
          size="sm"
        />
        <span class="text-xs font-bold text-gray-700 dark:text-gray-300 truncate">
          {{ entry?.name ?? 'Preview' }}
        </span>
      </div>
      <button
        class="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors shrink-0 ml-1"
        title="Close preview"
        @click="ctx.togglePreviewVisibility()"
      >
        <X class="w-3.5 h-3.5 text-gray-400" />
      </button>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-hidden flex flex-col">
      <!-- Loading -->
      <div v-if="s.loadingState === 'loading'" class="flex items-center justify-center flex-1">
        <Loader2 class="w-5 h-5 text-gray-400 animate-spin" />
      </div>

      <!-- Error -->
      <div v-else-if="s.loadingState === 'error'" class="flex flex-col items-center justify-center flex-1 p-4 text-center gap-2">
        <AlertCircle class="w-6 h-6 text-red-400" />
        <p class="text-xs text-red-500 dark:text-red-400">{{ s.errorMessage }}</p>
      </div>

      <!-- No entry selected -->
      <div v-else-if="!entry" class="flex flex-col items-center justify-center flex-1 text-gray-300 dark:text-gray-700">
        <FileText class="w-10 h-10 mb-3 opacity-20" />
        <p class="text-[10px] uppercase tracking-widest font-bold opacity-50">Select a file</p>
      </div>

      <!-- Directory info -->
      <div v-else-if="entry.kind === 'directory'" class="p-4 space-y-3">
        <div class="flex flex-col items-center py-6 gap-3 text-gray-400">
          <FileExplorerEntryIcon :kind="entry.kind" :extension="entry.extension" :mime-category="entry.mimeCategory" size="lg" />
          <p class="text-sm font-bold text-gray-700 dark:text-gray-300 text-center">{{ entry.name }}</p>
          <p class="text-[10px] uppercase tracking-widest text-gray-400">Folder</p>
        </div>
      </div>

      <!-- Oversized warning -->
      <div v-else-if="s.oversized" class="flex flex-col items-center justify-center flex-1 p-4 text-center gap-3">
        <FileText class="w-8 h-8 text-gray-300 dark:text-gray-600" />
        <p class="text-xs font-bold text-gray-600 dark:text-gray-400">File is too large to preview</p>
        <p class="text-[10px] text-gray-400">{{ formatSize({ bytes: entry.size }) }}</p>
        <button
          class="px-3 py-1.5 text-xs font-bold bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors text-gray-700 dark:text-gray-300"
          @click="ctx.loadPreviewForced({ entry })"
        >
          Load anyway
        </button>
      </div>

      <!-- Text preview -->
      <div v-else-if="entry.mimeCategory === 'text' && s.loadingState === 'loaded'" class="flex flex-col flex-1 overflow-hidden">
        <div class="flex items-center justify-between px-3 py-1.5 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 shrink-0">
          <span class="text-[10px] text-gray-400 font-bold uppercase tracking-widest">{{ entry.extension || 'text' }}</span>
          <div class="flex items-center gap-1">
            <button
              v-if="entry.extension === '.json'"
              class="flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded transition-colors"
              :class="s.jsonFormatMode === 'formatted'
                ? 'bg-blue-500 text-white'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'"
              @click="ctx.toggleJsonFormat()"
            >
              <Braces class="w-3 h-3" />
              Format
            </button>
            <button
              class="flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              @click="ctx.downloadEntry({ entry })"
            >
              <Download class="w-3 h-3" />
            </button>
          </div>
        </div>
        <div class="flex-1 overflow-auto overscroll-contain">
          <!-- Syntax highlighted -->
          <pre
            v-if="s.highlightedHtml"
            class="p-3 text-[10px] leading-relaxed min-w-max"
            v-html="s.highlightedHtml"
          />
          <!-- Plain text fallback -->
          <pre v-else class="p-3 text-[10px] leading-relaxed text-gray-700 dark:text-gray-300 whitespace-pre min-w-max">{{ s.textContent }}</pre>
        </div>
      </div>

      <!-- Image preview -->
      <div v-else-if="entry.mimeCategory === 'image' && s.objectUrl" class="flex-1 overflow-auto flex items-center justify-center p-4 bg-checker">
        <img
          :src="s.objectUrl"
          :alt="entry.name"
          class="max-w-full max-h-full object-contain rounded shadow-sm"
          loading="lazy"
        />
      </div>

      <!-- Video preview -->
      <div v-else-if="entry.mimeCategory === 'video' && s.objectUrl" class="flex-1 flex items-center justify-center p-3">
        <video
          :src="s.objectUrl"
          controls
          class="max-w-full max-h-full rounded shadow-sm"
          preload="metadata"
        />
      </div>

      <!-- Audio preview -->
      <div v-else-if="entry.mimeCategory === 'audio' && s.objectUrl" class="flex-1 flex items-center justify-center p-4">
        <audio :src="s.objectUrl" controls class="w-full" />
      </div>

      <!-- Binary file -->
      <div v-else-if="entry.mimeCategory === 'binary' && s.loadingState === 'loaded'" class="flex flex-col items-center justify-center flex-1 p-4 text-center gap-3">
        <FileExplorerEntryIcon :kind="entry.kind" :extension="entry.extension" :mime-category="entry.mimeCategory" size="lg" />
        <div class="space-y-1">
          <p class="text-xs font-bold text-gray-600 dark:text-gray-400">Binary File</p>
          <p class="text-[10px] text-gray-400">{{ formatSize({ bytes: entry.size }) }}</p>
          <p v-if="entry.lastModified" class="text-[10px] text-gray-400">{{ formatDate({ timestamp: entry.lastModified }) }}</p>
        </div>
        <button
          class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors text-gray-700 dark:text-gray-300"
          @click="ctx.downloadEntry({ entry })"
        >
          <Download class="w-3.5 h-3.5" />
          Download
        </button>
      </div>

      <!-- File info footer -->
      <div
        v-if="entry && entry.kind === 'file' && s.loadingState === 'loaded' && !s.oversized"
        class="px-3 py-2 border-t border-gray-100 dark:border-gray-800 shrink-0 space-y-0.5"
      >
        <p class="text-[10px] text-gray-400">
          <span class="font-bold">Size:</span> {{ formatSize({ bytes: entry.size }) }}
        </p>
        <p v-if="entry.lastModified" class="text-[10px] text-gray-400">
          <span class="font-bold">Modified:</span> {{ formatDate({ timestamp: entry.lastModified }) }}
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bg-checker {
  background-color: #f5f5f5;
  background-image: linear-gradient(45deg, #e0e0e0 25%, transparent 25%),
    linear-gradient(-45deg, #e0e0e0 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #e0e0e0 75%),
    linear-gradient(-45deg, transparent 75%, #e0e0e0 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0px;
}

.dark .bg-checker {
  background-color: #1a1a1a;
  background-image: linear-gradient(45deg, #2a2a2a 25%, transparent 25%),
    linear-gradient(-45deg, #2a2a2a 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #2a2a2a 75%),
    linear-gradient(-45deg, transparent 75%, #2a2a2a 75%);
}
</style>
