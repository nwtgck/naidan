<script setup lang="ts">
import { computed, inject } from 'vue';
import {
  ArchiveIcon,
  Loader2Icon,
  UploadIcon,
  XIcon,
} from 'lucide-vue-next';

import { lazyStrings } from '@/strings';
import { FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';
import FileExplorerZipUploadPreview from './FileExplorerZipUploadPreview.vue';

const ctx = inject(FILE_EXPLORER_INJECTION_KEY)!;
const state = computed(() => ctx.upload.state);
const isBusy = computed(() => state.value.phase === 'analyzing' || state.value.phase === 'uploading');
const isLastZip = computed(() => state.value.currentZipIndex + 1 >= state.value.totalZipCount);

async function selectKeepArchive(): Promise<void> {
  await ctx.upload.setPlacement({ placement: { kind: 'keep_archive' } });
}

async function selectExtract(): Promise<void> {
  await ctx.upload.setPlacement({
    placement: {
      kind: 'extract',
      rootHandling: state.value.singleRootDirectoryName === undefined
        ? 'not_applicable'
        : 'preserve',
    },
  });
}

async function selectRootHandling({ rootHandling }: { rootHandling: 'preserve' | 'strip' }): Promise<void> {
  await ctx.upload.setPlacement({
    placement: {
      kind: 'extract',
      rootHandling,
    },
  });
}


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
    // ESLint-required for defineExpose.
  }
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="state.visibility === 'visible'"
      class="fixed inset-0 z-[600] flex items-center justify-center p-4 bg-black/55"
      data-testid="zip-upload-overlay"
      @click.self="!isBusy && ctx.upload.close()"
      @keydown.esc.stop.prevent="!isBusy && ctx.upload.close()"
    >
      <section
        class="w-full max-w-[980px] max-h-[calc(100vh-32px)] flex flex-col overflow-hidden bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-2xl"
        role="dialog"
        aria-modal="true"
        :aria-label="lazyStrings.fileExplorer__zip_file_upload()"
        data-testid="zip-upload-dialog"
      >
        <header class="flex items-center justify-between min-h-[52px] px-4 py-2.5 border-b border-gray-200 dark:border-gray-700">
          <div class="min-w-0 flex items-center gap-2">
            <h2 class="text-sm font-semibold text-gray-700 dark:text-gray-300">
              {{ lazyStrings.fileExplorer__zip_file_upload() }}
            </h2>
            <span v-if="state.totalZipCount > 1" class="text-[10px] text-gray-400">
              {{ state.currentZipIndex + 1 }} / {{ state.totalZipCount }}
            </span>
          </div>
          <button
            type="button"
            class="grid place-items-center w-7 h-7 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg disabled:opacity-40"
            :aria-label="lazyStrings.fileExplorer__close()"
            data-testid="zip-upload-close"
            :disabled="isBusy"
            @click="ctx.upload.close()"
          >
            <XIcon class="w-4 h-4" />
          </button>
        </header>

        <div class="min-h-0 grid grid-cols-[minmax(320px,410px)_minmax(380px,1fr)] max-[760px]:block flex-1 overflow-hidden max-[760px]:overflow-y-auto">
          <section class="grid content-start gap-5 p-[18px] overflow-y-auto border-r border-gray-200 dark:border-gray-700 max-[760px]:overflow-visible max-[760px]:border-r-0 max-[760px]:border-b">
            <div class="flex items-center gap-3 min-w-0 p-3 bg-gray-50 dark:bg-gray-950/30 border border-gray-200 dark:border-gray-700 rounded-lg">
              <span class="grid place-items-center w-9 h-9 shrink-0 text-amber-600 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 rounded-lg">
                <ArchiveIcon class="w-5 h-5" />
              </span>
              <span class="min-w-0">
                <span class="block truncate text-xs font-semibold text-gray-800 dark:text-gray-200">
                  {{ state.currentFileName }}
                </span>
                <span class="block mt-0.5 text-[10px] text-gray-400">
                  {{ lazyStrings.fileExplorer__zip_archive() }}
                </span>
              </span>
            </div>

            <div v-if="state.phase === 'analyzing'" class="flex items-center gap-2 text-xs text-gray-400">
              <Loader2Icon class="w-4 h-4 animate-spin" />
              {{ lazyStrings.fileExplorer__analyzing_zip() }}
            </div>

            <fieldset v-else class="grid gap-2" :disabled="isBusy">
              <legend class="mb-2 text-xs font-bold text-gray-700 dark:text-gray-300">
                {{ lazyStrings.fileExplorer__placement_method() }}
              </legend>

              <label
                class="grid grid-cols-[18px_minmax(0,1fr)] gap-2.5 p-3 border rounded-lg cursor-pointer"
                :class="state.placement.kind === 'keep_archive'
                  ? 'bg-blue-50 dark:bg-blue-950/25 border-blue-500 ring-1 ring-blue-500'
                  : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'"
              >
                <input
                  type="radio"
                  name="zip-placement"
                  class="mt-0.5 accent-blue-500"
                  :checked="state.placement.kind === 'keep_archive'"
                  data-testid="zip-placement-keep"
                  @change="selectKeepArchive()"
                />
                <span>
                  <span class="block text-[11px] font-bold text-gray-800 dark:text-gray-200">
                    {{ lazyStrings.fileExplorer__place_zip_file_as_is() }}
                  </span>
                  <span class="block mt-1 text-[10px] leading-4 text-gray-500">
                    {{ lazyStrings.fileExplorer__place_zip_file_as_is_description() }}
                  </span>
                </span>
              </label>

              <label
                class="grid grid-cols-[18px_minmax(0,1fr)] gap-2.5 p-3 border rounded-lg"
                :class="[
                  state.placement.kind === 'extract'
                    ? 'bg-blue-50 dark:bg-blue-950/25 border-blue-500 ring-1 ring-blue-500'
                    : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800',
                  state.extractability !== 'extractable' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
                ]"
              >
                <input
                  type="radio"
                  name="zip-placement"
                  class="mt-0.5 accent-blue-500"
                  :checked="state.placement.kind === 'extract'"
                  :disabled="state.extractability !== 'extractable'"
                  data-testid="zip-placement-extract"
                  @change="selectExtract()"
                />
                <span>
                  <span class="block text-[11px] font-bold text-gray-800 dark:text-gray-200">
                    {{ lazyStrings.fileExplorer__extract_and_place() }}
                  </span>
                  <span class="block mt-1 text-[10px] leading-4 text-gray-500">
                    {{ state.extractability === 'not_extractable'
                      ? lazyStrings.fileExplorer__zip_cannot_be_extracted()
                      : lazyStrings.fileExplorer__extract_and_place_description() }}
                  </span>
                </span>
              </label>

              <fieldset
                v-if="state.placement.kind === 'extract' && state.singleRootDirectoryName !== undefined"
                class="grid gap-2 ml-7 p-3 bg-gray-50 dark:bg-gray-950/30 border border-gray-200 dark:border-gray-700 rounded-lg"
              >
                <legend class="px-1 text-[11px] font-bold text-gray-700 dark:text-gray-300">
                  {{ lazyStrings.fileExplorer__root_directory_handling({ name: state.singleRootDirectoryName }) }}
                </legend>

                <label class="grid grid-cols-[18px_minmax(0,1fr)] gap-2 p-2.5 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg cursor-pointer">
                  <input
                    type="radio"
                    name="zip-root-handling"
                    class="mt-0.5 accent-blue-500"
                    :checked="state.placement.kind === 'extract' && state.placement.rootHandling === 'strip'"
                    data-testid="zip-root-strip"
                    @change="selectRootHandling({ rootHandling: 'strip' })"
                  />
                  <span>
                    <span class="block text-[11px] font-bold text-gray-800 dark:text-gray-200">
                      {{ lazyStrings.fileExplorer__place_contents_here() }}
                    </span>
                    <span class="block mt-1 text-[10px] leading-4 text-gray-500">
                      {{ lazyStrings.fileExplorer__place_contents_here_description({ name: state.singleRootDirectoryName }) }}
                    </span>
                  </span>
                </label>

                <label class="grid grid-cols-[18px_minmax(0,1fr)] gap-2 p-2.5 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg cursor-pointer">
                  <input
                    type="radio"
                    name="zip-root-handling"
                    class="mt-0.5 accent-blue-500"
                    :checked="state.placement.kind === 'extract' && state.placement.rootHandling === 'preserve'"
                    data-testid="zip-root-preserve"
                    @change="selectRootHandling({ rootHandling: 'preserve' })"
                  />
                  <span>
                    <span class="block text-[11px] font-bold text-gray-800 dark:text-gray-200">
                      {{ lazyStrings.fileExplorer__place_directory_itself() }}
                    </span>
                    <span class="block mt-1 text-[10px] leading-4 text-gray-500">
                      {{ lazyStrings.fileExplorer__place_directory_itself_description({ name: state.singleRootDirectoryName }) }}
                    </span>
                  </span>
                </label>
              </fieldset>
            </fieldset>

            <div v-if="state.errorMessage" class="px-3 py-2 text-[10px] leading-4 text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/30 rounded-lg" data-testid="zip-upload-error">
              {{ state.errorMessage }}
            </div>
          </section>

          <FileExplorerZipUploadPreview />
        </div>

        <footer class="flex items-center justify-end gap-2 min-h-[58px] px-4 py-2.5 bg-gray-50/80 dark:bg-gray-950/20 border-t border-gray-200 dark:border-gray-700">
          <button
            type="button"
            class="min-h-[34px] px-3.5 py-1.5 text-[11px] font-bold text-gray-700 dark:text-gray-300 bg-transparent border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
            data-testid="zip-upload-cancel"
            :disabled="isBusy"
            @click="ctx.upload.close()"
          >
            {{ lazyStrings.SHARED__cancel() }}
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-2 min-h-[34px] px-3.5 py-1.5 text-[11px] font-bold text-white bg-blue-500 border border-blue-500 rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="isBusy || state.phase !== 'configuring' || state.previewSummary.blockedCount > 0"
            data-testid="zip-upload-confirm"
            @click="ctx.upload.confirm()"
          >
            <Loader2Icon v-if="state.phase === 'uploading'" class="w-3.5 h-3.5 animate-spin" />
            <UploadIcon v-else class="w-3.5 h-3.5" />
            {{ state.phase === 'uploading'
              ? lazyStrings.fileExplorer__uploading()
              : isLastZip
                ? lazyStrings.fileExplorer__upload_files()
                : lazyStrings.fileExplorer__next_zip() }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
