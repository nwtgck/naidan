<script setup lang="ts">
import { onScopeDispose } from 'vue';
import { registerImageGenerationNavigation } from '@/features/image-generation/session/navigation';
import { lazyStrings } from '@/strings';
import type { ImageGenerationView } from '@/features/image-generation/use-image-generation-types';
import ImageGenerationEditor from './ImageGenerationEditor.vue';
import ImageGenerationResults from './ImageGenerationResults.vue';
const props = defineProps<{ generation: ImageGenerationView, active: boolean }>();
const emit = defineEmits<{ models: [], diagnostics: [], workspace: [] }>();
const unregister = registerImageGenerationNavigation({ navigation: { view: undefined, openModels: () => emit('models'), openDiagnostics: () => emit('diagnostics'), openGeneration: () => emit('workspace') } });
onScopeDispose(unregister);
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="h-full overflow-y-auto p-4 sm:px-6 sm:py-5 space-y-4" data-testid="image-generation-unavailable">
    <div tw-class="flex flex-wrap items-center gap-3"><h2 tw-class="text-sm font-semibold">{{ lazyStrings.stableDiffusionCppBrowser__generate() }}</h2><button type="button" disabled tw-class="rounded-xl border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs opacity-40">{{ lazyStrings.imageGeneration__new_session() }}</button></div>
    <p role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__hosted_build_required() }}</p>
    <div tw-class="grid lg:grid-cols-2 items-start gap-6"><ImageGenerationEditor :view="props.generation" :active="active" @manage-models="emit('models')" /><ImageGenerationResults :view="props.generation" :active="active" @prepare="emit('models')" /></div>
  </section>
</template>
