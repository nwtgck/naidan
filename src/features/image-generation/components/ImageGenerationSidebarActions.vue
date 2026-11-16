<script setup lang="ts">
import { SquarePenIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { ImageGenerationNavigation } from '@/features/image-generation/session/navigation';

const props = defineProps<{ navigation: ImageGenerationNavigation, expanded: boolean }>();

async function create(): Promise<void> {
  await props.navigation.view?.newSession({ preserveDraft: false });
  props.navigation.openGeneration();
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <button type="button" @click="create" :disabled="navigation.view?.busy.value || !navigation.view?.available.value" :title="lazyStrings.imageGeneration__new_session()" :aria-label="lazyStrings.imageGeneration__new_session()" data-testid="workspace-new-session" :tw-class="['flex min-h-9 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-gray-50/70 font-medium text-gray-700 transition-colors hover:border-blue-200 hover:bg-blue-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/50 dark:text-gray-200 dark:hover:border-blue-500/30 dark:hover:bg-blue-500/10', expanded ? 'w-full px-3 py-2.5 text-xs' : 'h-9 w-9']"><SquarePenIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" /><span v-if="expanded" tw-class="truncate">{{ lazyStrings.imageGeneration__new_session() }}</span></button>
</template>
