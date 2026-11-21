<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import { lazyStrings, ensureStrings } from '@/strings';
import { LlamaCppBrowserError, type ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import { type LocalModelImportRequest, captureDroppedLocalModels, filterModelFilesForAddition, localModelDirectoriesFromFiles } from '@/features/llama-cpp-browser/logic/local-model-input';
import { useLlamaCppBrowserSettingsTypography } from '@/features/llama-cpp-browser/composables/useLlamaCppBrowserSettingsTypography';
import { droppedModels } from '@/features/llama-cpp-browser/runtime/directory-input';
import LlamaCppBrowserModelFileInput from './LlamaCppBrowserModelFileInput.vue';
import LlamaCppBrowserRepositoryLayout from './LlamaCppBrowserRepositoryLayout.vue';
import type { LocalRepositoryLayoutChoice } from '@/features/llama-cpp-browser/runtime/local-repository-layout';

const props = defineProps<{ disabled: boolean, layout: 'compact' | 'expanded' | 'fill', intent?: 'add' }>();
const emit = defineEmits<{
  accept: [request: LocalModelImportRequest],
  'drag-active': [state: 'active' | 'idle'],
  'layout-pending': [pending: boolean],
  skipped: [files: string[]],
}>();
const save = ref<'browser' | 'later'>('later');
const question = shallowRef<{ rootName: string, choices: LocalRepositoryLayoutChoice[], choose({ layout }: { layout: LocalRepositoryLayoutChoice['layout'] }): void, cancel(): void }>();
const controllers = new Set<AbortController>();
const isSettingsTypography = useLlamaCppBrowserSettingsTypography();

const addingFiles = computed(() => {
  switch (props.intent) {
  case 'add': return true;
  case undefined: return false;
  default: throw new Error(String(props.intent satisfies never));
  }
});
const fileDescription = computed(() => {
  switch (save.value) {
  case 'browser': return addingFiles.value ? lazyStrings.LlamaCppBrowserLocalFiles__save_in_browser() : lazyStrings.LlamaCppBrowserLocalFiles__start_now_and_save_in_background();
  case 'later': return addingFiles.value ? lazyStrings.LlamaCppBrowserLocalFiles__use_until_page_closes() : lazyStrings.LlamaCppBrowserLocalFiles__start_without_copying_and_save_later();
  default: throw new Error(String(save.value satisfies never));
  }
});

async function confirmLayouts({ directories, controller }: { directories: ModelDirectoryInput[], controller: AbortController }): Promise<ModelDirectoryInput[]> {
  const result: ModelDirectoryInput[] = [];
  for (const directory of directories) {
    controller.signal.throwIfAborted();
    if (!directory.files.some(file => /\.gguf$/i.test(file.relativePath) && file.relativePath.includes('/'))) {
      result.push(directory);
      continue;
    }
    const { localRepositoryLayoutChoices } = await import('@/features/llama-cpp-browser/runtime/local-repository-layout');
    controller.signal.throwIfAborted();
    const choices = localRepositoryLayoutChoices({ directory });
    if (!choices.length) {
      throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    }
    if (choices.length === 1 && choices[0]) {
      result.push(...choices[0].directories);
      continue;
    }
    const selected = await new Promise<ModelDirectoryInput[]>((resolve, reject) => {
      const cancel = () => {
        question.value = undefined;
        emit('layout-pending', false);
        reject(controller.signal.reason);
      };
      controller.signal.addEventListener('abort', cancel, { once: true });
      question.value = {
        rootName: directory.rootName,
        choices,
        choose: ({ layout }) => {
          const choice = choices.find(choice => choice.layout === layout);
          if (!choice) {
            return;
          }
          controller.signal.removeEventListener('abort', cancel);
          question.value = undefined;
          emit('layout-pending', false);
          resolve(choice.directories);
        },
        cancel: () => controller.abort(),
      };
      emit('layout-pending', true);
    });
    result.push(...selected);
  }
  return result;
}

function handOff({ collect, skipped }: { collect({ controller }: { controller: AbortController }): Promise<ModelDirectoryInput[]>, skipped?: string[] }): void {
  if (props.disabled || question.value !== undefined) {
    return;
  }
  const controller = new AbortController();
  controllers.add(controller);
  // collect captures DataTransfer entries synchronously. Admission is emitted
  // during the same dispatch, before enumeration or layout confirmation yields.
  let captured: Promise<ModelDirectoryInput[]>;
  try {
    captured = collect({ controller });
  } catch (error) {
    captured = Promise.reject(error);
  }
  const directories = captured.then(async directories => {
    if (!addingFiles.value) {
      return confirmLayouts({ directories, controller });
    }
    const result = await filterModelFilesForAddition({ directories, signal: controller.signal });
    emit('skipped', [...skipped ?? [], ...result.skipped]);
    if (!result.directories.length) {
      throw new LlamaCppBrowserError({ code: 'unsupported-input', details: await ensureStrings.LlamaCppBrowserLocalFiles__no_gguf_files() });
    }
    return confirmLayouts({ directories: result.directories, controller });
  }).finally(() => {
    controllers.delete(controller);
  });
  void directories.catch(() => {});
  // The tagged promise fulfills only after repository boundaries are confirmed.
  emit('accept', { directories, controller, save: save.value, repositoryLayout: 'confirmed' });
}

function chooseFiles({ event, selection }: { event: Event, selection: 'files' | 'directory' }): void {
  if (!(event.target instanceof HTMLInputElement)) {
    return;
  }
  const files = Array.from(event.target.files ?? []);
  event.target.value = '';
  if (!files.length) {
    return;
  }
  if (addingFiles.value && selection === 'files') {
    const modelFiles = files.filter(file => /\.gguf$/i.test(file.name));
    handOff({
      skipped: files.filter(file => !/\.gguf$/i.test(file.name)).map(file => file.name),
      collect: async () => localModelDirectoriesFromFiles({ files: modelFiles, selection }),
    });
    return;
  }
  handOff({ collect: async () => localModelDirectoriesFromFiles({ files, selection }) });
}

function dropFiles({ event }: { event: DragEvent }): void {
  const transfer = event.dataTransfer;
  if (!transfer) {
    return;
  }
  // The adapter must run before any import awaits, while drag data is readable.
  if (!addingFiles.value) {
    handOff({ collect: ({ controller }) => captureDroppedLocalModels({ transfer, signal: controller.signal }) });
    return;
  }
  const skipped: string[] = [];
  handOff({
    skipped,
    collect: ({ controller }) => droppedModels({ transfer, signal: controller.signal, allowOtherFiles: true }).then(({ directories, files }) => {
      const models: File[] = [];
      for (const file of files) {
        if (/\.gguf$/i.test(file.name)) {
          models.push(file);
        } else {
          skipped.push(file.name);
        }
      }
      if (models.length && models.every(file => /mmproj/i.test(file.name))) {
        skipped.push(...models.map(file => file.name));
        return directories;
      }
      return [...directories, ...localModelDirectoriesFromFiles({ files: models, selection: 'files' })];
    }),
  });
}

onScopeDispose(() => {
  for (const controller of controllers) {
    controller.abort();
  }
  emit('layout-pending', false);
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div :class="{ 'local-files-fill': layout === 'fill' }" tw-class="flex min-h-0 flex-col gap-3 text-left">
    <label tw-class="flex shrink-0 cursor-pointer items-center justify-between gap-4 rounded-xl border border-gray-200/80 bg-gray-50/60 px-3 py-2.5 dark:border-gray-700/70 dark:bg-gray-800/30">
      <span :tw-class="['min-w-0 font-medium text-gray-700', isSettingsTypography ? 'text-sm dark:text-gray-300' : 'text-xs dark:text-gray-200']">{{ lazyStrings.LlamaCppBrowserLocalFiles__copy_model_files_into_the_browser() }}</span>
      <ToggleSwitch><input type="checkbox" :checked="save === 'browser'" :disabled="disabled || question !== undefined" data-testid="local-model-save-in-browser" @change="save = ($event.target as HTMLInputElement).checked ? 'browser' : 'later'" /></ToggleSwitch>
    </label>
    <LlamaCppBrowserRepositoryLayout v-if="question" :root-name="question.rootName" :choices="question.choices" heading="visible" @choose="question.choose({ layout: $event })" @cancel="question.cancel" />
    <LlamaCppBrowserModelFileInput v-else :class="{ 'local-files-picker-fill': layout === 'fill' }" :disabled="disabled" mode="temp" :layout="layout" :description="fileDescription" @files="chooseFiles({ event: $event, selection: 'files' })" @directory="chooseFiles({ event: $event, selection: 'directory' })" @drop-files="dropFiles({ event: $event })" @drag-active="emit('drag-active', $event)" />
  </div>
</template>

<style scoped>
.local-files-fill {
  height: 100%;
}
.local-files-fill > .local-files-picker-fill {
  flex: 1 1 0;
  min-height: 0;
  height: auto;
}
</style>
