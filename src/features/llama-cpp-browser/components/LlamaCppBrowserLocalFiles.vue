<script setup lang="ts">
import { onScopeDispose, ref, shallowRef } from 'vue';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import { lazyStrings } from '@/strings';
import { LlamaCppBrowserError, type ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import { captureDroppedLocalModels, localModelDirectoriesFromFiles } from '@/features/llama-cpp-browser/logic/local-model-input';
import { useLlamaCppBrowserSettingsTypography } from '@/features/llama-cpp-browser/composables/useLlamaCppBrowserSettingsTypography';
import LlamaCppBrowserModelFileInput from './LlamaCppBrowserModelFileInput.vue';
import LlamaCppBrowserRepositoryLayout from './LlamaCppBrowserRepositoryLayout.vue';
import type { LocalRepositoryLayoutChoice } from '@/features/llama-cpp-browser/runtime/local-repository-layout';

const props = defineProps<{ disabled: boolean, layout: 'compact' | 'expanded' | 'fill' }>();
const emit = defineEmits<{
  accept: [input: { directories: Promise<ModelDirectoryInput[]>, controller: AbortController, save: 'browser' | 'later', repositoryLayout: 'confirmed' }],
  'drag-active': [state: 'active' | 'idle'],
  'layout-pending': [pending: boolean],
}>();
const save = ref<'browser' | 'later'>('later');
const question = shallowRef<{ rootName: string, choices: LocalRepositoryLayoutChoice[], choose({ layout }: { layout: LocalRepositoryLayoutChoice['layout'] }): void, cancel(): void }>();
const controllers = new Set<AbortController>();
const isSettingsTypography = useLlamaCppBrowserSettingsTypography();

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

function handOff({ collect }: { collect({ controller }: { controller: AbortController }): Promise<ModelDirectoryInput[]> }): void {
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
  const directories = captured.then(directories => confirmLayouts({ directories, controller })).finally(() => {
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
  handOff({ collect: async () => localModelDirectoriesFromFiles({ files, selection }) });
}

function dropFiles({ event }: { event: DragEvent }): void {
  const transfer = event.dataTransfer;
  if (!transfer) {
    return;
  }
  // The adapter must run before any import awaits, while drag data is readable.
  handOff({ collect: ({ controller }) => captureDroppedLocalModels({ transfer, signal: controller.signal }) });
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
    <LlamaCppBrowserModelFileInput v-else :class="{ 'local-files-picker-fill': layout === 'fill' }" :disabled="disabled" mode="temp" :layout="layout" :description="save === 'browser' ? lazyStrings.LlamaCppBrowserLocalFiles__start_now_and_save_in_background() : lazyStrings.LlamaCppBrowserLocalFiles__start_without_copying_and_save_later()" @files="chooseFiles({ event: $event, selection: 'files' })" @directory="chooseFiles({ event: $event, selection: 'directory' })" @drop-files="dropFiles({ event: $event })" @drag-active="emit('drag-active', $event)" />
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
