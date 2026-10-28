<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { computed, nextTick, onBeforeUnmount, onErrorCaptured, onMounted, ref, useId, useTemplateRef } from 'vue';
import { AlertTriangleIcon, FileArchiveIcon, FolderOpenIcon, XIcon } from 'lucide-vue-next';
import { useFileExplorerModal, mapFileExplorerModalOptionsToRootDescriptor } from '@/features/file-explorer/composables/useFileExplorerModal';
import FileExplorer from './FileExplorer.vue';

const { closeFileExplorer, fileExplorerOptions } = useFileExplorerModal();
const panel = useTemplateRef<HTMLElement>('panel');
const titleId = useId();
const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
const initializationError = ref<string>();

onErrorCaptured(error => {
  initializationError.value = error instanceof Error ? error.message : String(error);
  return false;
});

onMounted(() => panel.value?.focus());
onBeforeUnmount(() => {
  if (opener?.isConnected && (document.activeElement === document.body || (document.activeElement instanceof Node && panel.value?.contains(document.activeElement)))) {
    opener.focus();
  }
});

async function focusExplorer(): Promise<void> {
  await nextTick();
  if (document.activeElement === panel.value) {
    panel.value?.querySelector<HTMLElement>('[data-testid="file-explorer"]')?.focus();
  }
}

function trapFocus({ event }: { event: KeyboardEvent }): void {
  const controls = [...(panel.value?.querySelectorAll<HTMLElement>(':is(button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]))') ?? [])]
    .filter(control => !control.closest('[inert], [hidden]'));
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

const initialLocked = computed(() => {
  switch (fileExplorerOptions.value.kind) {
  case 'opfs-root':
    return true;
  case 'archive-root':
    return false;
  case 'native-directory':
  case 'wesh-mounts':
    return false;
  default: {
    const _exhaustiveCheck: never = fileExplorerOptions.value;
    throw new Error(`Unhandled file explorer modal options: ${JSON.stringify(_exhaustiveCheck)}`);
  }
  }
});

const title = computed(() => {
  const options = fileExplorerOptions.value;
  switch (options.kind) {
  case 'opfs-root':
    return lazyStrings.fileExplorer__file_explorer_opfs();
  case 'native-directory':
  case 'wesh-mounts':
  case 'archive-root':
    return options.title;
  default: {
    const _exhaustiveCheck: never = options;
    throw new Error(`Unhandled file explorer modal options: ${JSON.stringify(_exhaustiveCheck)}`);
  }
  }
});

const initialPath = computed(() => {
  const options = fileExplorerOptions.value;
  switch (options.kind) {
  case 'opfs-root':
  case 'archive-root':
    return undefined;
  case 'native-directory':
  case 'wesh-mounts':
    return options.initialPath;
  default: {
    const _exhaustiveCheck: never = options;
    throw new Error(`Unhandled file explorer modal options: ${JSON.stringify(_exhaustiveCheck)}`);
  }
  }
});

const root = computed(() => mapFileExplorerModalOptionsToRootDescriptor({
  options: fileExplorerOptions.value,
}));


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <Teleport to="body">
    <!--
      File Explorer can be launched from layered modals such as Settings (100),
      Import/Export (110), and secondary content modals (120). Keep this layer
      above those callers while leaving global dialogs (200) above File Explorer.
    -->
    <div
      tw-class="fixed inset-0 z-[130] flex items-center justify-center bg-black/40 p-2 backdrop-blur-[2px] sm:p-4"
      data-testid="file-explorer-modal"
      @click.self="closeFileExplorer()"
    >
      <div ref="panel" role="dialog" aria-modal="true" :aria-labelledby="titleId" tabindex="-1" data-testid="file-explorer-modal-panel" tw-class="flex h-[95dvh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-gray-200/90 bg-white shadow-2xl shadow-gray-950/10 outline-none dark:border-gray-700/80 dark:bg-gray-900 dark:shadow-black/35 md:h-[90dvh]" @keydown.stop @keydown.tab="trapFocus({ event: $event })">
        <div tw-class="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200/60 bg-gray-50/70 px-4 py-3 dark:border-gray-700/50 dark:bg-gray-800/30">
          <div tw-class="flex min-w-0 items-center gap-2.5">
            <component :is="fileExplorerOptions.kind === 'archive-root' ? FileArchiveIcon : FolderOpenIcon" aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" />
            <h2 :id="titleId" tw-class="min-w-0 truncate text-sm font-semibold text-gray-800 dark:text-gray-100" :title="title">{{ title }}</h2>
          </div>
          <button
            type="button"
            tw-class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            :title="lazyStrings.fileExplorer__close()"
            :aria-label="lazyStrings.fileExplorer__close()"
            data-testid="file-explorer-modal-close"
            @click="closeFileExplorer()"
          >
            <XIcon aria-hidden="true" tw-class="h-4 w-4" />
          </button>
        </div>

        <div tw-class="flex-1 overflow-hidden">
          <div
            v-if="initializationError !== undefined"
            role="alert"
            data-testid="file-explorer-initialization-error"
            tw-class="flex h-full items-start justify-center gap-2 overflow-y-auto p-6 text-sm text-red-600 dark:text-red-400"
          >
            <AlertTriangleIcon aria-hidden="true" tw-class="mt-0.5 h-4 w-4 shrink-0" />
            <p tw-class="min-w-0 break-words">{{ lazyStrings.fileExplorer__failed_to_load_directory({ errorMessage: initializationError }) }}</p>
          </div>
          <Suspense v-else @resolve="focusExplorer">
            <FileExplorer
              :root="root"
              :initial-path="initialPath"
              :initial-locked="initialLocked"
              initial-view-mode="list"
              initial-preview-visibility="visible"
              tw-class="h-full"
            />
          </Suspense>
        </div>
      </div>
    </div>
  </Teleport>
</template>
