<script setup lang="ts">
import { computed, defineAsyncComponent, markRaw, onScopeDispose, ref, shallowRef, watch, type Component } from 'vue';
import { Loader2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { createModuleLoader } from '@/utils/module-loader';
import { missingHostModelDirectoryApis } from '@/logic/host-model-directories';
import type { ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import LlamaCppBrowserLocalFiles from '@/features/llama-cpp-browser/components/LlamaCppBrowserLocalFiles.vue';
import LlamaCppBrowserModelImportModes from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelImportModes.vue';
import OnBoardingModalV2ModelSources from './OnBoardingModalV2ModelSources.vue';

const RepositorySaves = defineAsyncComponent(() => import('@/features/llama-cpp-browser/components/LlamaCppBrowserLocalRepositorySaves.vue'));
const copyProgressPrepared = ref(false);
const props = defineProps<{
  active: boolean,
  disabled: boolean,
  acceptLocalInput: ({ directories, controller, save, repositoryLayout }: { directories: Promise<ModelDirectoryInput[]>, controller: AbortController, save?: 'browser' | 'later', repositoryLayout?: 'confirmed' }) => void | Promise<void>,
}>();
const emit = defineEmits<{ busy: [value: boolean] }>();
const mode = ref<'temp' | 'host'>('temp');
const accepting = ref(false);
const linkBusy = ref(false);
const inputFailed = ref(false);
const linkLoadFailed = ref(false);
const loadingLinkedFolders = ref(false);
const LinkedFolders = shallowRef<Component>();
const linkedFoldersMounted = ref(false);
const linkedLoader = createModuleLoader({ importModule: () => import('@/features/llama-cpp-browser/components/LlamaCppBrowserModelImportLinkedFolders.vue'), onPrefetchError: () => {} });
const linkSupported = missingHostModelDirectoryApis().length === 0;
const busy = computed(() => accepting.value || linkBusy.value);
const disabled = computed(() => props.disabled || !props.active || busy.value);
const modes = computed(() => [
  { mode: 'temp' as const, label: lazyStrings.OnBoardingModalV2LocalModelInput__load_model(), availability: 'available' as const },
  { mode: 'host' as const, label: lazyStrings.SHARED__model_import_link_folder(), availability: linkSupported ? 'available' as const : 'unavailable' as const },
]);
let disposed = false;
watch(() => props.active && busy.value, value => emit('busy', value), { flush: 'sync' });
onScopeDispose(() => {
  disposed = true;
  // The modal owner owns accepted input and cancellation after handoff.
  // Removing this view must not cancel a model that is opening its chat.
  emit('busy', false);
});

async function loadLinkedFolders(): Promise<void> {
  if (disposed || props.disabled || !props.active || busy.value || loadingLinkedFolders.value) {
    return;
  }
  loadingLinkedFolders.value = true;
  linkLoadFailed.value = false;
  try {
    const module = await linkedLoader.load();
    if (!disposed) {
      LinkedFolders.value = markRaw(module.default);
    }
  } catch {
    if (!disposed) {
      linkLoadFailed.value = true;
    }
  } finally {
    if (!disposed) {
      loadingLinkedFolders.value = false;
    }
  }
}

function selectMode({ value }: { value: 'opfs' | 'temp' | 'host' }): void {
  if (disposed || disabled.value) {
    return;
  }
  switch (value) {
  case 'temp':
    mode.value = value;
    inputFailed.value = false;
    return;
  case 'host':
    mode.value = value;
    inputFailed.value = false;
    if (LinkedFolders.value === undefined) {
      // Linking UI and its storage dependencies are action-owned, not part
      // of the synchronous welcome screen or an implicit network fallback.
      void loadLinkedFolders();
    }
    return;
  case 'opfs': return;
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
}

async function handOff({ directories, controller, save, repositoryLayout }: { directories: Promise<ModelDirectoryInput[]>, controller: AbortController, save: 'browser' | 'later', repositoryLayout: 'confirmed' }): Promise<void> {
  void directories.catch(() => {});
  if (disposed || disabled.value || mode.value !== 'temp') {
    controller.abort();
    return;
  }
  accepting.value = true;
  inputFailed.value = false;
  copyProgressPrepared.value ||= save === 'browser';
  try {
    // Reserve the owner's action synchronously, before enumeration yields.
    await props.acceptLocalInput({ directories, controller, save, repositoryLayout });
  } catch {
    if (!disposed && !controller.signal.aborted) {
      inputFailed.value = true;
    }
  } finally {
    if (!disposed) {
      accepting.value = false;
    }
  }
}

function updateLinkBusy({ value }: { value: boolean }): void {
  if (!disposed) {
    linkBusy.value = value;
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="onboarding-local-model-input" :inert="!active || undefined" :aria-hidden="!active" tw-class="mx-auto w-full max-w-xl space-y-3 text-left">
    <LlamaCppBrowserModelImportModes :model-value="mode" :modes="modes" :disabled="disabled" tw-class="mx-auto w-full max-w-sm" @update:model-value="selectMode({ value: $event })" />
    <LlamaCppBrowserLocalFiles v-show="mode === 'temp'" :inert="mode !== 'temp' || undefined" :aria-hidden="mode !== 'temp'" :disabled="disabled || mode !== 'temp'" layout="expanded" @accept="handOff($event)" />
    <!-- Do not feed linkBusy back as disabled: the link operation owns it. -->
    <div v-show="mode === 'host'" :inert="mode !== 'host' || !active || undefined" :aria-hidden="mode !== 'host' || !active">
      <LinkedFolders v-if="LinkedFolders && (linkedFoldersMounted || (mode === 'host' && active))" :disabled="props.disabled || !active || accepting || mode !== 'host'" @busy="updateLinkBusy({ value: $event })" @vue:mounted="linkedFoldersMounted = true" />
      <p v-else-if="loadingLinkedFolders" role="status" tw-class="flex min-h-44 items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400"><Loader2Icon aria-hidden="true" tw-class="h-4 w-4 animate-spin motion-reduce:animate-none" />{{ lazyStrings.llamaCppBrowser__loading() }}</p>
      <div v-else-if="linkLoadFailed" role="alert" tw-class="space-y-2 rounded-xl border border-gray-200 p-4 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300"><p>{{ lazyStrings.OnBoardingModalV2LocalModelInput__could_not_open_local_model_files() }}</p><button type="button" :disabled="props.disabled || !active" tw-class="min-h-9 rounded-lg px-3 py-2 font-medium text-blue-600 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-blue-400 dark:hover:bg-gray-800 disabled:opacity-50" @click="loadLinkedFolders">{{ lazyStrings.LlamaCppBrowserModelLaunch__retry() }}</button></div>
    </div>
    <p v-if="inputFailed" role="alert" tw-class="text-sm text-red-600 dark:text-red-400">{{ lazyStrings.OnBoardingModalV2LocalModelInput__could_not_open_local_model_files() }}</p>
    <RepositorySaves v-if="copyProgressPrepared" offered-visibility="hidden" />
    <OnBoardingModalV2ModelSources />
  </div>
</template>
