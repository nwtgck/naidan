<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, shallowRef, useId, useTemplateRef } from 'vue';
import { FilePlusIcon, XIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';

const props = defineProps<{ directoryPath: string }>();
const ctx = inject(FILE_EXPLORER_INJECTION_KEY)!;
const titleId = useId();
const nameInput = useTemplateRef<HTMLInputElement>('nameInput');
const panel = useTemplateRef<HTMLElement>('panel');
const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
const name = shallowRef('');
const text = shallowRef('');
const attachment = shallowRef<File>();
const multipleFiles = shallowRef(false);
const saving = shallowRef(false);
const failedName = shallowRef<string>();
const failedNameExistsAsEmptyFile = computed(() => failedName.value !== undefined && failedName.value === name.value.trim()
  && ctx.currentDirectoryPath === props.directoryPath && ctx.entries.some(entry => entry.name === failedName.value && entry.size === 0));
const canCreate = computed(() => name.value.trim() !== '' && !ctx.readOnly && ctx.currentDirectoryPath === props.directoryPath && !saving.value && !multipleFiles.value);

onMounted(() => nameInput.value?.focus());
onBeforeUnmount(() => {
  if (panel.value?.contains(document.activeElement) && opener?.isConnected) {
    queueMicrotask(() => {
      if (opener.isConnected) {
        opener.focus();
      }
    });
  }
});

function handleContentPaste({ event }: { event: ClipboardEvent }): void {
  const data = event.clipboardData;
  if (!data || saving.value) {
    return;
  }
  const files = Array.from(data.files);
  if (files.length === 0) {
    for (const item of data.items) {
      const file = item.getAsFile();
      if (file) {
        files.push(file);
      }
    }
  }
  const file = files[0];
  if (file === undefined) {
    return;
  }
  event.preventDefault();
  multipleFiles.value = files.length > 1;
  if (multipleFiles.value) {
    return;
  }
  if (name.value.trim() === '' || name.value === attachment.value?.name) {
    name.value = file.name;
  }
  attachment.value = file;
  text.value = '';
}

function clearAttachment(): void {
  attachment.value = undefined;
  multipleFiles.value = false;
}

function trapFocus({ event }: { event: KeyboardEvent }): void {
  const controls = panel.value?.querySelectorAll<HTMLElement>('input:not(:disabled), textarea:not(:disabled), button:not(:disabled)');
  const first = controls?.[0];
  const last = controls?.[controls.length - 1];
  const target = event.shiftKey && document.activeElement === first ? last : !event.shiftKey && document.activeElement === last ? first : undefined;
  if (target) {
    event.preventDefault();
    target.focus();
  }
}

function close(): void {
  if (!saving.value) {
    ctx.closeNewFile();
  }
}

async function create(): Promise<void> {
  if (!canCreate.value) {
    return;
  }
  const requestedName = name.value.trim();
  failedName.value = undefined;
  saving.value = true;
  try {
    if (await ctx.createFile({ name: requestedName, blob: attachment.value ?? new Blob([text.value], { type: 'text/plain;charset=utf-8' }) })) {
      ctx.closeNewFile();
    } else {
      failedName.value = requestedName;
    }
  } finally {
    saving.value = false;
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div tw-class="fixed inset-0 z-[140] flex items-center justify-center bg-black/40 p-4" @click.self="close()">
    <form
      ref="panel"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      :aria-busy="saving"
      tabindex="-1"
      data-testid="new-file-dialog"
      tw-class="w-full max-w-md overflow-auto rounded-2xl border border-gray-200/90 bg-white shadow-2xl dark:border-gray-700/80 dark:bg-gray-900 max-h-[90dvh]"
      @submit.prevent="create()"
      @keydown.stop
      @keydown.esc.prevent="close()"
      @keydown.tab="trapFocus({ event: $event })"
    >
      <h3 :id="titleId" tw-class="flex items-center gap-2.5 border-b border-gray-200/60 bg-gray-50/70 px-5 py-3.5 text-sm font-semibold text-gray-900 dark:border-gray-700/60 dark:bg-gray-800/30 dark:text-gray-100">
        <FilePlusIcon aria-hidden="true" tw-class="h-4 w-4 text-blue-500" />
        {{ lazyStrings.fileExplorer__new_file() }}
      </h3>
      <div tw-class="space-y-3 px-5 py-4">
        <label tw-class="block text-xs font-medium text-gray-700 dark:text-gray-200">
          {{ lazyStrings.fileExplorer__name() }}
          <input
            ref="nameInput" v-model="name" :readonly="saving" type="text" data-testid="new-file-name"
            tw-class="mt-1 block w-full rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-2 text-sm outline-none focus:border-blue-400 dark:border-gray-700 dark:bg-gray-800"
          />
        </label>
        <textarea
          v-model="text" :readonly="saving" rows="4" :aria-label="lazyStrings.FileExplorerNewFileDialog__paste_text_or_a_file()"
          :placeholder="lazyStrings.FileExplorerNewFileDialog__paste_text_or_a_file()" data-testid="new-file-content"
          tw-class="block w-full resize-y rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-2 text-sm text-gray-900 outline-none focus:border-blue-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          @input="clearAttachment()"
          @paste="handleContentPaste({ event: $event })"
        />
        <div v-if="attachment" tw-class="flex items-center gap-2 rounded-lg bg-gray-100 px-2.5 py-1.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-200" data-testid="new-file-attachment">
          <span :title="attachment.name" tw-class="min-w-0 flex-1 truncate">{{ attachment.name }}</span>
          <span tw-class="shrink-0 text-gray-500 dark:text-gray-400">{{ lazyStrings.fileExplorer__byte_count({ count: attachment.size }) }}</span>
          <button type="button" :disabled="saving" :aria-label="lazyStrings.FileExplorerNewFileDialog__remove_attachment()" tw-class="rounded-sm p-1 hover:bg-gray-200 focus-visible:outline-2 focus-visible:outline-blue-400 dark:hover:bg-gray-700" @click="clearAttachment()">
            <XIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />
          </button>
        </div>
        <p v-if="multipleFiles" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.FileExplorerNewFileDialog__paste_one_file_at_a_time() }}</p>
        <p v-if="failedNameExistsAsEmptyFile" role="status" data-testid="new-file-empty-name-conflict" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.FileExplorerNewFileDialog__an_empty_file_with_this_name_exists() }}</p>
      </div>
      <div tw-class="flex justify-end gap-2 border-t border-gray-200/60 bg-gray-50/70 px-5 py-3 dark:border-gray-700/60 dark:bg-gray-800/30">
        <button type="button" :disabled="saving" tw-class="rounded-lg px-3 py-2 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" @click="close()">{{ lazyStrings.SHARED__cancel() }}</button>
        <button type="submit" :disabled="!canCreate" tw-class="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40" data-testid="new-file-create">{{ lazyStrings.fileExplorer__create() }}</button>
      </div>
    </form>
  </div>
</template>
