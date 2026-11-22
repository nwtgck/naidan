<script setup lang="ts">
import { computed, shallowRef } from 'vue';
import { FileCodeIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { fileExplorerTextWrap } from '@/features/file-explorer/composables/file-explorer-text-wrap';
import type { FileExplorerBinaryPreview } from '@/features/file-explorer/logic/types';
import FileExplorerTextWrapButton from './FileExplorerTextWrapButton.vue';

const props = defineProps<{ preview: FileExplorerBinaryPreview }>();
const showText = shallowRef(false);
const bytesPerRow = 8;

const hexDump = computed(() => {
  const rows: string[] = [];
  for (let offset = 0; offset < props.preview.bytes.length; offset += bytesPerRow) {
    const bytes = [...props.preview.bytes.subarray(offset, offset + bytesPerRow)];
    const address = offset.toString(16).padStart(4, '0');
    const hex = bytes.map(byte => byte.toString(16).padStart(2, '0')).join(' ').padEnd(bytesPerRow * 3 - 1);
    const ascii = bytes.map(byte => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('');
    rows.push(`${address}  ${hex}  ${ascii}`);
  }
  return rows.join('\n');
});
const text = computed(() => new TextDecoder().decode(props.preview.bytes, { stream: props.preview.partial }));

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section tw-class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="file-explorer-binary-preview">
    <div tw-class="flex shrink-0 items-center justify-between gap-2 border-b border-gray-100 bg-gray-50 px-3 py-1.5 dark:border-gray-800 dark:bg-gray-900/50">
      <span tw-class="text-[10px] text-gray-500 dark:text-gray-400">
        <template v-if="preview.partial">{{ lazyStrings.FileExplorerBinaryPreview__first_bytes({ count: preview.bytes.length }) }}</template>
        <template v-else>{{ lazyStrings.fileExplorer__byte_count({ count: preview.bytes.length }) }}</template>
      </span>
      <div tw-class="flex items-center gap-1">
        <FileExplorerTextWrapButton v-if="showText" />
        <button
          type="button"
          data-testid="binary-toggle-text"
          :title="lazyStrings.FileExplorerBinaryPreview__show_as_text()"
          :aria-label="lazyStrings.FileExplorerBinaryPreview__show_as_text()"
          :aria-pressed="showText"
          :tw-class="['rounded-lg p-1.5 transition-colors', showText
            ? 'bg-blue-50 text-blue-500 dark:bg-blue-900/20'
            : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800']"
          @click="showText = !showText"
        >
          <FileCodeIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
    <div tw-class="min-h-0 flex-1 overflow-auto overscroll-contain">
      <pre
        v-if="showText"
        data-testid="binary-source-text"
        :tw-class="['m-0 p-3 font-mono text-xs leading-relaxed text-gray-700 dark:text-gray-300', fileExplorerTextWrap
          ? 'whitespace-pre-wrap wrap-anywhere'
          : 'min-w-max whitespace-pre']"
      >{{ text }}</pre>
      <pre v-else data-testid="binary-hex-dump" tw-class="m-0 min-w-max whitespace-pre p-3 font-mono text-[10px] leading-relaxed text-gray-700 tabular-nums dark:text-gray-300">{{ hexDump }}</pre>
    </div>
  </section>
</template>
