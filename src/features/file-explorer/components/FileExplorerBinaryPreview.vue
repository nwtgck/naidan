<script setup lang="ts">
import { computed, onScopeDispose, shallowRef, watch } from 'vue';
import { FileCodeIcon } from 'lucide-vue-next';
import { ensureStrings, lazyStrings } from '@/strings';
import { useFileExplorerTextWrap } from '@/features/file-explorer/composables/useFileExplorerEditorPreferences';
import type { FileExplorerBinaryPreview } from '@/features/file-explorer/logic/types';
import { BINARY_PREVIEW_BYTES } from '@/features/file-explorer/logic/file-view';
import { FILE_VIEW_MAX_DISPLAY_BYTES, type FileExplorerFileAccess } from '@/features/file-explorer/worker/types';
import FileExplorerTextWrapButton from './FileExplorerTextWrapButton.vue';

const fileExplorerTextWrap = useFileExplorerTextWrap();

const props = defineProps<{
  preview: FileExplorerBinaryPreview,
  path?: string,
  access?: FileExplorerFileAccess | undefined,
  allowJump?: boolean,
}>();
const showText = shallowRef(false);
const bytes = shallowRef(props.preview.bytes);
const partial = shallowRef(props.preview.partial);
const offset = shallowRef(0);
const jumpInput = shallowRef('');
const busy = shallowRef(false);
const errorMessage = shallowRef<string>();
let controller: AbortController | undefined;
const bytesPerRow = 8;

watch(() => props.preview, preview => {
  controller?.abort();
  bytes.value = preview.bytes;
  partial.value = preview.partial;
  offset.value = 0;
  jumpInput.value = '';
  errorMessage.value = undefined;
});
onScopeDispose(() => controller?.abort());

const canMore = computed(() => props.access !== undefined && props.path !== undefined && partial.value
  && (props.preview.rangeReadable || bytes.value.length < FILE_VIEW_MAX_DISPLAY_BYTES));
const jumpOffset = computed(() => {
  const input = jumpInput.value.trim();
  const position = /^(\d+|0x[0-9a-f]+)$/iu.test(input) ? Number(input) : NaN;
  return Number.isSafeInteger(position) && (props.preview.size === undefined || position < props.preview.size) ? position : undefined;
});

async function readBytes({ start, append }: { start: number, append: boolean }): Promise<void> {
  const { access, path, preview } = props;
  if (!access || path === undefined || busy.value) {
    return;
  }
  const read = new AbortController();
  controller = read;
  busy.value = true;
  errorMessage.value = undefined;
  try {
    const signal = read.signal;
    const result = preview.rangeReadable
      ? await access.read({ path, mode: 'range', offset: start, maxBytes: BINARY_PREVIEW_BYTES, signal })
      : await access.read({ path, mode: 'prefix', maxBytes: Math.min(start + BINARY_PREVIEW_BYTES, FILE_VIEW_MAX_DISPLAY_BYTES), signal });
    if (signal.aborted) {
      return;
    }
    switch (result.kind) {
    case 'file': break;
    case 'too-large': case 'unsupported':
      throw new Error(await ensureStrings.fileExplorer__no_file_preview());
    default: {
      const exhaustive: never = result;
      throw new Error(`Unexpected byte read: ${String(exhaustive)}`);
    }
    }
    if ((preview.size !== undefined && result.size !== undefined && preview.size !== result.size)
      || (preview.lastModified !== undefined && result.lastModified !== undefined && preview.lastModified !== result.lastModified)) {
      throw new Error(await ensureStrings.FileExplorerBinaryPreview__file_changed());
    }
    const data = new Uint8Array(await result.blob.arrayBuffer());
    if (signal.aborted) {
      return;
    }
    if (append && preview.rangeReadable && bytes.value.length + data.length <= FILE_VIEW_MAX_DISPLAY_BYTES) {
      const joined = new Uint8Array(bytes.value.length + data.length);
      joined.set(bytes.value);
      joined.set(data, bytes.value.length);
      bytes.value = joined;
    } else {
      bytes.value = data;
      offset.value = preview.rangeReadable ? start : 0;
    }
    partial.value = result.partial;
  } catch (error) {
    if (!read.signal.aborted) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    busy.value = false;
  }
}

const hexDump = computed(() => {
  const rows: string[] = [];
  for (let index = 0; index < bytes.value.length; index += bytesPerRow) {
    const row = [...bytes.value.subarray(index, index + bytesPerRow)];
    const address = (offset.value + index).toString(16).padStart(4, '0');
    const hex = row.map(byte => byte.toString(16).padStart(2, '0')).join(' ').padEnd(bytesPerRow * 3 - 1);
    const ascii = row.map(byte => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('');
    rows.push(`${address}  ${hex}  ${ascii}`);
  }
  return rows.join('\n');
});
const text = computed(() => new TextDecoder().decode(bytes.value, { stream: partial.value }));

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section tw-class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="file-explorer-binary-preview">
    <div tw-class="flex shrink-0 items-center justify-between gap-2 border-b border-gray-100 bg-gray-50 px-3 py-1.5 dark:border-gray-800 dark:bg-gray-900/50">
      <span tw-class="text-[10px] text-gray-500 dark:text-gray-400">
        <template v-if="offset > 0">{{ lazyStrings.FileExplorerBinaryPreview__byte_range({ start: offset, end: offset + bytes.length - 1 }) }}</template>
        <template v-else-if="partial">{{ lazyStrings.FileExplorerBinaryPreview__first_bytes({ count: bytes.length }) }}</template>
        <template v-else>{{ lazyStrings.fileExplorer__byte_count({ count: bytes.length }) }}</template>
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
    <p v-if="errorMessage" role="alert" tw-class="px-3 py-1.5 text-xs text-red-600 dark:text-red-400">{{ errorMessage }}</p>
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
    <div v-if="canMore || (allowJump && preview.rangeReadable && access && path)" tw-class="flex shrink-0 flex-wrap items-center gap-2 border-t border-gray-100 px-3 py-1.5 dark:border-gray-800">
      <button v-if="canMore" type="button" :disabled="busy" data-testid="binary-show-more" tw-class="rounded-lg px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-40 dark:text-blue-300 dark:hover:bg-blue-900/20" @click="readBytes({ start: offset + bytes.length, append: true })">
        {{ lazyStrings.FileExplorerBinaryPreview__show_more() }}
      </button>
      <form v-if="allowJump && preview.rangeReadable && access && path" tw-class="ml-auto flex items-center gap-1" @submit.prevent="jumpOffset !== undefined && readBytes({ start: jumpOffset, append: false })">
        <input v-model="jumpInput" type="text" spellcheck="false" :aria-label="lazyStrings.FileExplorerBinaryPreview__byte_offset()" :placeholder="lazyStrings.FileExplorerBinaryPreview__byte_offset()" data-testid="binary-offset" tw-class="w-28 rounded-md border border-gray-200 bg-transparent px-2 py-1 font-mono text-xs dark:border-gray-700" />
        <button type="submit" :disabled="busy || jumpOffset === undefined" data-testid="binary-jump" tw-class="rounded-lg px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-40 dark:text-blue-300 dark:hover:bg-blue-900/20">
          {{ lazyStrings.FileExplorerBinaryPreview__go_to_offset() }}
        </button>
      </form>
    </div>
  </section>
</template>
