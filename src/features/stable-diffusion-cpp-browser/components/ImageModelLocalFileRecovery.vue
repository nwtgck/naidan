<script setup lang="ts">
import { computed, onErrorCaptured, ref } from 'vue';
import { lazyStrings } from '@/strings';
import { rawConfiguration, useImageLibrary } from '@/features/image-generation/providers/local-environment';
import { configurationSchema } from '@/features/stable-diffusion-cpp-browser/types';
import type { ImageLibraryView } from '@/features/stable-diffusion-cpp-browser/library-view';
import ImageRepositoryImport from './ImageRepositoryImport.vue';

const props = defineProps<{ view: ImageLibraryView | undefined, disabled: boolean }>();
const configuration = configurationSchema.safeParse(rawConfiguration);
const unavailable = !configuration.success || configuration.data.kind === 'unavailable';
const disabled = computed(() => props.disabled || unavailable);
const viewFailed = ref(false);
onErrorCaptured(() => {
  viewFailed.value = true;
  return false;
});
// A supplied view retains its existing import ownership. The download manager
// has no editor view, so create only its local model-management state here.
// Setup never refreshes, imports, requests permission, or starts a download.
const view = (() => {
  try {
    return props.view ?? useImageLibrary({
      blocked: () => disabled.value,
      downloadsBlocked: () => true,
      onSelection() {},
      dependencies: undefined,
    });
  } catch {
    viewFailed.value = true;
    return undefined;
  }
})();
const failure = computed(() => view !== props.view ? view?.failure.value : undefined);

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="image-local-file-recovery" tw-class="min-w-0 space-y-2">
    <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageModelLocalFileRecovery__add_image_model_files_then_select_the_model() }}</p>
    <ImageRepositoryImport v-if="view !== undefined && !viewFailed" :view="view" :disabled="disabled" />
    <p v-if="viewFailed" role="status" data-testid="image-local-file-recovery-error" tw-class="break-words text-xs text-red-600 dark:text-red-400">{{ lazyStrings.ImageModelLocalFileRecovery__could_not_open_local_image_model_files() }}</p>
    <p v-else-if="failure" role="status" data-testid="image-local-file-recovery-error" tw-class="break-words text-xs text-red-600 dark:text-red-400">{{ failure }}</p>
  </div>
</template>
