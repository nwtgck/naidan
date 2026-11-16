<script setup lang="ts">
import { computed, onScopeDispose, ref, useId, type Component } from 'vue';
import { isNavigationFailure, NavigationFailureType, useRouter } from 'vue-router';
import { ArrowRightIcon, AudioLinesIcon, CpuIcon, FileTextIcon, FlaskConicalIcon, ImageIcon, Loader2Icon, SearchCheckIcon, Settings2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { requestAppSettings, useAppEntry } from '@/composables/useAppEntry';
import { isAppInteractionEnabled, useAppPresentation } from '@/composables/useAppPresentation';
import { useLauncher } from '@/composables/useLauncher';
import { isModelSupportInvestigationAvailable } from '@/features/transformers-js/model-support-investigation';

const emit = defineEmits<{ openModelSupportInvestigation: [], navigate: [focus: 'restore' | 'handoff'] }>();
const id = useId();
const router = useRouter();
const appEntry = useAppEntry();
const { appInteraction } = useAppPresentation();
const { opener: launcherOpener } = useLauncher();
const interactive = computed(() => appEntry.interaction.value === 'ready' && isAppInteractionEnabled({ interaction: appInteraction.value }));
type ToolAction =
  | { kind: 'route', path: '/llama-cpp-browser/diagnostics' | '/debug/standalone' | '/image-generation/diagnostics' | '/live-conversation/diagnostics' | '/live-conversation/diagnostics/transcription' }
  | { kind: 'model-support' }
  | { kind: 'settings' };
type ToolEntry = {
  id: string, section: 'investigation' | 'settings', icon: Component,
  title: () => string | undefined, description: () => string | undefined,
  availability: 'available' | 'hosted-only' | 'standalone-only', action: ToolAction,
};
const entries: readonly ToolEntry[] = [
  { id: 'llama-diagnostics', section: 'investigation', icon: CpuIcon, title: () => lazyStrings.DeveloperToolsPanel__llama_cpp_inference_diagnostics(), description: () => lazyStrings.DeveloperToolsPanel__measure_saved_lm_models(), availability: 'available', action: { kind: 'route', path: '/llama-cpp-browser/diagnostics' } },
  { id: 'standalone-verification', section: 'investigation', icon: FlaskConicalIcon, title: () => lazyStrings.DeveloperToolsPanel__standalone_verification(), description: () => lazyStrings.DeveloperToolsPanel__check_the_standalone_runtime(), availability: __BUILD_MODE_IS_STANDALONE__ ? 'available' : 'standalone-only', action: { kind: 'route', path: '/debug/standalone' } },
  { id: 'transformers-model-support', section: 'investigation', icon: SearchCheckIcon, title: () => lazyStrings.DeveloperToolsPanel__transformers_model_support_investigation(), description: () => lazyStrings.DeveloperToolsPanel__check_transformers_model_compatibility(), availability: isModelSupportInvestigationAvailable ? 'available' : 'hosted-only', action: { kind: 'model-support' } },
  { id: 'image-diagnostics', section: 'investigation', icon: ImageIcon, title: () => lazyStrings.DeveloperToolsPanel__image_generation_investigation(), description: () => lazyStrings.DeveloperToolsPanel__measure_image_generation(), availability: __BUILD_MODE_IS_HOSTED__ ? 'available' : 'hosted-only', action: { kind: 'route', path: '/image-generation/diagnostics' } },
  { id: 'audio-response', section: 'investigation', icon: AudioLinesIcon, title: () => lazyStrings.DeveloperToolsPanel__audio_response_investigation(), description: () => lazyStrings.DeveloperToolsPanel__compare_audio_responses(), availability: __BUILD_MODE_IS_HOSTED__ ? 'available' : 'hosted-only', action: { kind: 'route', path: '/live-conversation/diagnostics' } },
  { id: 'transcription', section: 'investigation', icon: FileTextIcon, title: () => lazyStrings.DeveloperToolsPanel__transcription_investigation(), description: () => lazyStrings.DeveloperToolsPanel__measure_audio_transcription(), availability: __BUILD_MODE_IS_HOSTED__ ? 'available' : 'hosted-only', action: { kind: 'route', path: '/live-conversation/diagnostics/transcription' } },
  { id: 'developer-settings', section: 'settings', icon: Settings2Icon, title: () => lazyStrings.DeveloperToolsPanel__developer_settings(), description: () => lazyStrings.DeveloperToolsPanel__open_advanced_settings(), availability: 'available', action: { kind: 'settings' } },
];
const sections = [
  { id: 'investigation', title: () => lazyStrings.DeveloperToolsPanel__investigations() },
  { id: 'settings', title: () => lazyStrings.DeveloperToolsPanel__settings() },
] as const;
const opening = ref<string>();
const navigationError = ref<string>();
let disposed = false;
onScopeDispose(() => {
  disposed = true;
});

function available({ entry }: { entry: ToolEntry }): boolean {
  const value = entry.availability;
  switch (value) {
  case 'available': return true;
  case 'hosted-only': case 'standalone-only': return false;
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
}

function unavailableReason({ entry }: { entry: ToolEntry }): string | undefined {
  const value = entry.availability;
  switch (value) {
  case 'available': return undefined;
  case 'hosted-only': return lazyStrings.DeveloperToolsPanel__hosted_version_only();
  case 'standalone-only': return lazyStrings.DeveloperToolsPanel__standalone_version_only();
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
}

async function open({ entry, opener }: { entry: ToolEntry, opener: EventTarget | undefined }): Promise<void> {
  if (disposed || !interactive.value || opening.value !== undefined || !available({ entry })) {
    return;
  }
  navigationError.value = undefined;
  const action = entry.action;
  switch (action.kind) {
  case 'model-support': emit('openModelSupportInvestigation');
    return;
  case 'settings': {
    const originalOpener = launcherOpener.value;
    requestAppSettings({ tab: 'developer', opener: originalOpener?.isConnected ? originalOpener : opener instanceof HTMLElement ? opener : undefined });
    emit('navigate', 'handoff');
    return;
  }
  case 'route': break;
  default: {
    const exhaustive: never = action;
    throw new Error(String(exhaustive));
  }
  }
  opening.value = entry.id;
  try {
    // Reopening this page must retain any existing diagnostic URL settings.
    const failure = router.currentRoute.value.path.replace(/\/+$/, '') === action.path ? undefined : await router.push(action.path);
    if (disposed) {
      return;
    }
    if (failure) {
      const message = failure.message;
      if (!isNavigationFailure(failure, NavigationFailureType.duplicated)) {
        navigationError.value = message;
        return;
      }
    }
    emit('navigate', 'restore');
  } catch (error) {
    if (!disposed) {
      navigationError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (!disposed) {
      opening.value = undefined;
    }
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div tw-class="space-y-6" data-testid="developer-tools-panel">
    <section v-for="section in sections" :key="section.id" :aria-labelledby="`${id}-developer-tools-${section.id}`" tw-class="space-y-2">
      <h3 :id="`${id}-developer-tools-${section.id}`" tw-class="px-3 text-xs font-medium text-gray-500 dark:text-gray-400">{{ section.title() }}</h3>
      <div tw-class="grid grid-cols-1 gap-1 sm:grid-cols-2">
        <button v-for="entry in entries.filter(item => item.section === section.id)" :key="entry.id" type="button" :disabled="!interactive || opening !== undefined || !available({ entry })" :aria-busy="opening === entry.id" :data-testid="`developer-tool-${entry.id}`" tw-class="group flex min-h-20 min-w-0 items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent dark:hover:bg-gray-800 dark:disabled:hover:bg-transparent" @click="open({ entry, opener: $event.currentTarget ?? undefined })">
          <span tw-class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"><component :is="entry.icon" aria-hidden="true" tw-class="h-4 w-4" /></span>
          <span tw-class="min-w-0 flex-1 space-y-1"><span tw-class="block break-words text-sm font-medium leading-5 text-gray-700 dark:text-gray-200">{{ entry.title() }}</span><span tw-class="block text-xs leading-5 text-gray-500 dark:text-gray-400">{{ entry.description() }}</span><span v-if="!available({ entry })" tw-class="block text-[11px] leading-4 text-gray-500 dark:text-gray-400">{{ unavailableReason({ entry }) }}</span></span>
          <Loader2Icon v-if="opening === entry.id" aria-hidden="true" tw-class="h-4 w-4 shrink-0 animate-spin text-gray-400 motion-reduce:animate-none" /><ArrowRightIcon v-else-if="available({ entry })" aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-gray-400 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        </button>
      </div>
    </section>
    <p v-if="navigationError" role="alert" tw-class="break-words px-3 text-xs text-red-600 dark:text-red-400" data-testid="developer-tools-navigation-error">{{ navigationError }}</p>
  </div>
</template>
