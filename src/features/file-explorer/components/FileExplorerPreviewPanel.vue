<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { inject, computed, defineAsyncComponent, shallowRef, useId, useTemplateRef } from 'vue';
import { BracesIcon, DownloadIcon, FileTextIcon, Loader2Icon, AlertCircleIcon, FileCodeIcon, PencilIcon, XIcon } from 'lucide-vue-next';
import AllowedHtmlView from '@/components/common/AllowedHtmlView.vue';
import FileExplorerEntryIcon from './FileExplorerEntryIcon.vue';
import FileExplorerTextWrapButton from './FileExplorerTextWrapButton.vue';
import FileExplorerPaneResizeHandle from './FileExplorerPaneResizeHandle.vue';
import { FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';
import { FILE_EXPLORER_FILE_VIEW_KEY } from '@/features/file-explorer/composables/file-explorer-file-view-context';
import { fileExplorerTextWrap } from '@/features/file-explorer/composables/file-explorer-text-wrap';
import { useFileExplorerPaneWidth } from '@/features/file-explorer/composables/useFileExplorerPaneWidth';
import { formatSize, formatDate } from '@/features/file-explorer/logic/utils';
import { getDelimitedFormat, getFileViewKind, getFileViewMediaType } from '@/features/file-explorer/logic/file-view';
import { TEXT_PREVIEW_SIZE_LIMIT } from '@/features/file-explorer/logic/constants';

const ctx = inject(FILE_EXPLORER_INJECTION_KEY)!;
const fileView = inject(FILE_EXPLORER_FILE_VIEW_KEY, undefined);
const FileExplorerDelimitedView = defineAsyncComponent(() => import('./FileExplorerDelimitedView.vue'));
const FileExplorerModelView = defineAsyncComponent(() => import('./FileExplorerModelView.vue'));
const FileExplorerPatchView = defineAsyncComponent(() => import('./FileExplorerPatchView.vue'));
const FileExplorerImageView = defineAsyncComponent(() => import('./FileExplorerImageView.vue'));
const FileExplorerBinaryPreview = defineAsyncComponent(() => import('./FileExplorerBinaryPreview.vue'));
const BlockMarkdownRenderer = defineAsyncComponent(() => import('@/components/block-markdown/BlockMarkdownRenderer.vue'));

const MARKDOWN_PREVIEW_MAX_LINES = 200;
const MARKDOWN_PREVIEW_MAX_CODE_UNITS = 32 * 1024;

const s = computed(() => ctx.previewState);
const entry = computed(() => s.value.entry);
const delimitedFormat = computed(() => getDelimitedFormat({ extension: entry.value?.extension ?? '' }));
const kind = computed(() => entry.value === undefined ? undefined : getFileViewKind({ entry: entry.value }));
const emptyPreview = computed(() => s.value.loadingState === 'loaded'
  && ((s.value.rawTextContent === '' && !s.value.partial)
    || (s.value.binaryPreview?.bytes.length === 0 && !s.value.binaryPreview.partial)));
const editAsText = computed(() => kind.value === 'binary' || (emptyPreview.value
  && (kind.value === 'image' || kind.value === 'model' || kind.value === 'audio' || kind.value === 'video')));
const showEditSource = computed(() => {
  const selected = entry.value;
  if (selected === undefined || fileView?.access === undefined || ctx.isLocked || selected.readOnly || !selected.canMutate
    || ctx.isDeletionOnly({ path: selected.path }) || s.value.oversized
    || (!emptyPreview.value && selected.size !== undefined && selected.size > TEXT_PREVIEW_SIZE_LIMIT)) {
    return false;
  }
  switch (kind.value) {
  case 'text': case 'markdown': case 'delimited': case 'patch': return true;
  case 'binary': return s.value.binaryPreview !== undefined;
  case 'image': case 'model': case 'audio': case 'video': return emptyPreview.value;
  case undefined: return false;
  default: {
    const exhaustive: never = kind.value;
    throw new Error(`Unhandled editable preview kind: ${String(exhaustive)}`);
  }
  }
});
const markdownSource = shallowRef(false);
const markdownPreview = computed(() => {
  const source = s.value.rawTextContent;
  if (kind.value !== 'markdown' || markdownSource.value || source === undefined) {
    return undefined;
  }

  let end = Math.min(source.length, MARKDOWN_PREVIEW_MAX_CODE_UNITS);
  const lastCodeUnit = source.charCodeAt(end - 1);
  if (end < source.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    end--;
  }

  const prefix = source.slice(0, end);
  const lineBreak = /\r\n?|\n/g;
  let remainingLines = MARKDOWN_PREVIEW_MAX_LINES;
  while (remainingLines > 0 && lineBreak.exec(prefix)) {
    remainingLines--;
  }
  if (remainingLines === 0) {
    end = lineBreak.lastIndex;
  }

  return { text: source.slice(0, end), partial: end < source.length || s.value.partial === true };
});
const panel = useTemplateRef<HTMLElement>('panel');
const panelBodyId = useId();
const previewSize = useFileExplorerPaneWidth({ panel, preference: 'previewWidthPx' });


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div
    v-if="!fileView?.isActive.value"
    ref="panel"
    :style="{ width: previewSize.width.value + 'px' }"
    tw-class="relative max-w-[70%] shrink-0 border-l border-gray-100 dark:border-gray-800 flex flex-col overflow-hidden bg-gray-50/30 dark:bg-black/20"
    data-testid="preview-panel"
  >
    <FileExplorerPaneResizeHandle
      edge="left"
      :controls="panelBodyId"
      :label="lazyStrings.FileExplorerPreviewPanel__resize_preview()"
      :resize="previewSize"
      data-testid="preview-resize-handle"
    />
    <!-- Header -->
    <div tw-class="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-gray-800 shrink-0">
      <div tw-class="flex items-center gap-2 min-w-0">
        <FileExplorerEntryIcon
          v-if="entry"
          :kind="entry.kind"
          :extension="entry.extension"
          :mime-category="entry.mimeCategory"
          size="sm"
        />
        <span tw-class="text-xs font-bold text-gray-700 dark:text-gray-300 truncate">
          {{ entry?.name ?? lazyStrings.fileExplorer__preview() }}
        </span>
      </div>
      <div tw-class="ml-1 flex shrink-0 items-center gap-1">
        <button
          v-if="fileView && entry?.kind === 'file' && showEditSource"
          type="button"
          :title="editAsText ? lazyStrings.fileExplorer__edit_as_text() : lazyStrings.fileExplorer__edit_source()"
          :aria-label="editAsText ? lazyStrings.fileExplorer__edit_as_text() : lazyStrings.fileExplorer__edit_source()"
          data-testid="file-view-edit-preview"
          tw-class="p-1 rounded-lg text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          @click="fileView.open({ entry, startEditing: true, forceText: editAsText })"
        >
          <PencilIcon aria-hidden="true" tw-class="w-3.5 h-3.5" />
        </button>
        <button
          v-if="fileView && entry?.kind === 'file'"
          type="button"
          :title="lazyStrings.fileExplorer__open()"
          :aria-label="lazyStrings.fileExplorer__open()"
          data-testid="file-view-open-preview"
          tw-class="p-1 rounded-lg text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          @click="fileView.open({ entry })"
        >
          <FileTextIcon aria-hidden="true" tw-class="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          tw-class="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors"
          :title="lazyStrings.fileExplorer__close_preview()"
          :aria-label="lazyStrings.fileExplorer__close_preview()"
          @click="ctx.togglePreviewVisibility()"
        >
          <XIcon aria-hidden="true" tw-class="w-3.5 h-3.5 text-gray-400" />
        </button>
      </div>
    </div>

    <!-- Content -->
    <div :id="panelBodyId" tw-class="flex-1 overflow-hidden flex flex-col">
      <!-- Loading -->
      <div v-if="s.loadingState === 'loading'" tw-class="flex items-center justify-center flex-1">
        <Loader2Icon tw-class="w-5 h-5 text-gray-400 animate-spin" />
      </div>

      <!-- Error -->
      <div v-else-if="s.loadingState === 'error'" tw-class="flex flex-col items-center justify-center flex-1 p-4 text-center gap-2">
        <AlertCircleIcon tw-class="w-6 h-6 text-red-400" />
        <p tw-class="text-xs text-red-500 dark:text-red-400">{{ s.errorMessage }}</p>
      </div>

      <!-- No entry selected -->
      <div v-else-if="!entry" tw-class="flex flex-col items-center justify-center flex-1 text-gray-300 dark:text-gray-700">
        <FileTextIcon tw-class="w-10 h-10 mb-3 opacity-20" />
        <p tw-class="text-[10px] uppercase tracking-widest font-bold opacity-50">{{ lazyStrings.fileExplorer__select_a_file() }}</p>
      </div>

      <!-- Directory info -->
      <div v-else-if="entry.kind === 'directory'" tw-class="p-4 space-y-3">
        <div tw-class="flex flex-col items-center py-6 gap-3 text-gray-400">
          <FileExplorerEntryIcon :kind="entry.kind" :extension="entry.extension" :mime-category="entry.mimeCategory" size="lg" />
          <p tw-class="text-sm font-bold text-gray-700 dark:text-gray-300 text-center">{{ entry.name }}</p>
          <p tw-class="text-[10px] uppercase tracking-widest text-gray-400">{{ lazyStrings.fileExplorer__folder() }}</p>
        </div>
      </div>

      <!-- Oversized warning -->
      <div v-else-if="s.oversized" tw-class="flex flex-col items-center justify-center flex-1 p-4 text-center gap-3">
        <FileTextIcon tw-class="w-8 h-8 text-gray-300 dark:text-gray-600" />
        <p tw-class="text-xs font-bold text-gray-600 dark:text-gray-400">{{ lazyStrings.fileExplorer__file_is_too_large_to_preview() }}</p>
        <p tw-class="text-[10px] text-gray-400">{{ formatSize({ bytes: entry.size }) }}</p>
        <button
          tw-class="px-3 py-1.5 text-xs font-bold bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors text-gray-700 dark:text-gray-300"
          @click="ctx.loadPreviewForced({ entry })"
        >
          {{ lazyStrings.fileExplorer__load_anyway() }}
        </button>
      </div>

      <div v-else-if="emptyPreview || s.binaryPreview" tw-class="flex min-h-0 flex-1 flex-col">
        <p v-if="emptyPreview" data-testid="preview-empty-file" tw-class="flex flex-1 items-center justify-center p-4 text-center text-xs text-gray-500 dark:text-gray-400">
          {{ lazyStrings.fileExplorer__file_is_empty() }}
        </p>
        <FileExplorerBinaryPreview v-else-if="s.binaryPreview" :key="entry.path" :preview="s.binaryPreview" />
        <button
          type="button"
          data-testid="file-explorer-preview-download"
          tw-class="mx-3 mb-2 flex shrink-0 items-center gap-1.5 self-start rounded-lg px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          @click="ctx.downloadEntry({ entry })"
        >
          <DownloadIcon aria-hidden="true" tw-class="w-3.5 h-3.5" />
          {{ lazyStrings.fileExplorer__download() }}
        </button>
      </div>

      <FileExplorerDelimitedView
        v-else-if="delimitedFormat && s.loadingState === 'loaded' && s.rawTextContent !== undefined"
        :text="s.rawTextContent"
        :format="delimitedFormat"
        mode="preview"
        :partial="s.partial === true"
        :editable="false"
      />

      <FileExplorerModelView
        v-else-if="s.modelFile !== undefined && fileView?.access"
        :file="s.modelFile"
        :access="fileView.access"
        :can-save="false"
        compact
      />

      <!-- Text preview -->
      <div v-else-if="entry.mimeCategory === 'text' && s.loadingState === 'loaded'" tw-class="flex flex-col flex-1 overflow-hidden">
        <div tw-class="flex items-center justify-between px-3 py-1.5 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 shrink-0">
          <span tw-class="text-[10px] text-gray-400 font-bold uppercase tracking-widest">{{ entry.extension || 'text' }}</span>
          <div tw-class="flex items-center gap-1">
            <button
              v-if="entry.extension === '.json'"
              :tw-class="['flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded transition-colors', s.jsonFormatMode === 'formatted'
                ? 'bg-blue-500 text-white'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700']"
              @click="ctx.toggleJsonFormat()"
            >
              <BracesIcon tw-class="w-3 h-3" />
              {{ lazyStrings.fileExplorer__format() }}
            </button>
            <button
              v-if="kind === 'markdown'"
              type="button"
              data-testid="file-explorer-markdown-source-toggle"
              :title="lazyStrings.fileExplorer__view_source()"
              :aria-label="lazyStrings.fileExplorer__view_source()"
              :aria-pressed="markdownSource"
              :tw-class="['p-1.5 rounded-lg transition-colors', markdownSource
                ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20'
                : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800']"
              @click="markdownSource = !markdownSource"
            >
              <FileCodeIcon aria-hidden="true" tw-class="w-3.5 h-3.5" />
            </button>
            <FileExplorerTextWrapButton v-if="kind !== 'markdown' || markdownSource" data-testid="file-explorer-text-wrap-toggle" />
            <button
              tw-class="flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              @click="ctx.downloadEntry({ entry })"
            >
              <DownloadIcon tw-class="w-3 h-3" />
            </button>
          </div>
        </div>
        <div tw-class="flex-1 overflow-auto overscroll-contain">
          <template v-if="markdownPreview">
            <p
              v-if="markdownPreview.partial"
              data-testid="file-explorer-markdown-partial"
              tw-class="px-3 pt-2 text-xs text-gray-600 dark:text-gray-400"
            >
              {{ lazyStrings.FileExplorerPreviewPanel__showing_the_beginning_of_this_file() }}
            </p>
            <BlockMarkdownRenderer :content="markdownPreview.text" tw-class="p-3" />
          </template>
          <FileExplorerPatchView v-else-if="kind === 'patch' && s.rawTextContent !== undefined" :text="s.rawTextContent" />
          <AllowedHtmlView
            v-else-if="s.highlightedHtml"
            as="pre"
            :html="s.highlightedHtml"
            :tw-class="['p-3 text-[10px] leading-relaxed', fileExplorerTextWrap
              ? 'whitespace-pre-wrap wrap-anywhere'
              : 'whitespace-pre min-w-max']"
            data-testid="file-explorer-preview-text"
          />
          <!-- Plain text fallback -->
          <pre
            v-else
            :tw-class="['p-3 text-[10px] leading-relaxed text-gray-700 dark:text-gray-300', fileExplorerTextWrap
              ? 'whitespace-pre-wrap wrap-anywhere'
              : 'whitespace-pre min-w-max']"
            data-testid="file-explorer-preview-text"
          >{{ s.textContent }}</pre>
        </div>
      </div>

      <!-- Image preview -->
      <FileExplorerImageView
        v-else-if="entry.mimeCategory === 'image' && s.objectUrl"
        :url="s.objectUrl"
        :file-name="entry.name"
        :mime-type="getFileViewMediaType({ kind: 'image', blobType: '', extension: entry.extension })"
        :can-save="false"
        compact
      />

      <!-- Video preview -->
      <div v-else-if="entry.mimeCategory === 'video' && s.objectUrl" tw-class="flex-1 flex items-center justify-center p-3">
        <video
          :src="s.objectUrl"
          controls
          tw-class="max-w-full max-h-full rounded shadow-sm"
          preload="metadata"
        />
      </div>

      <!-- Audio preview -->
      <div v-else-if="entry.mimeCategory === 'audio' && s.objectUrl" tw-class="flex-1 flex items-center justify-center p-4">
        <audio :src="s.objectUrl" controls preload="metadata" tw-class="w-full" />
      </div>

      <!-- Binary file -->
      <div v-else-if="entry.mimeCategory === 'binary' && s.loadingState === 'loaded'" tw-class="flex flex-col items-center justify-center flex-1 p-4 text-center gap-3">
        <FileExplorerEntryIcon :kind="entry.kind" :extension="entry.extension" :mime-category="entry.mimeCategory" size="lg" />
        <div tw-class="space-y-1">
          <p tw-class="text-xs font-bold text-gray-600 dark:text-gray-400">{{ lazyStrings.fileExplorer__binary_file() }}</p>
          <p tw-class="text-[10px] text-gray-400">{{ formatSize({ bytes: entry.size }) }}</p>
          <p v-if="entry.lastModified" tw-class="text-[10px] text-gray-400">{{ formatDate({ timestamp: entry.lastModified }) }}</p>
        </div>
        <button
          tw-class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors text-gray-700 dark:text-gray-300"
          @click="ctx.downloadEntry({ entry })"
        >
          <DownloadIcon tw-class="w-3.5 h-3.5" />
          {{ lazyStrings.fileExplorer__download() }}
        </button>
      </div>

      <!-- File info footer -->
      <div
        v-if="entry && entry.kind === 'file' && s.loadingState === 'loaded' && !s.oversized"
        tw-class="px-3 py-2 border-t border-gray-100 dark:border-gray-800 shrink-0 space-y-0.5"
      >
        <p tw-class="text-[10px] text-gray-400">
          <span tw-class="font-bold">{{ lazyStrings.fileExplorer__size_label() }}</span> {{ formatSize({ bytes: entry.size }) }}
        </p>
        <p v-if="entry.lastModified" tw-class="text-[10px] text-gray-400">
          <span tw-class="font-bold">{{ lazyStrings.fileExplorer__modified_label() }}</span> {{ formatDate({ timestamp: entry.lastModified }) }}
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
