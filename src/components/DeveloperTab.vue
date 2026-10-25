<script setup lang="ts">
import { useSampleChat } from '@/composables/useSampleChat';
import { computed } from 'vue';
import { usePWAUpdate } from '@/composables/usePWAUpdate';
import { CpuIcon, FlaskConicalIcon, RefreshCwIcon, ScrollTextIcon, SearchCheckIcon } from 'lucide-vue-next';
import FeatureFlagsSettings from './FeatureFlagsSettings.vue';
import ActionButton from './ActionButton.vue';
import DeveloperOpenStateLinks from './DeveloperOpenStateLinks.vue';
import DeveloperDataDeletionPanel from '@/features/data-deletion/components/DeveloperDataDeletionPanel.vue';
import DeveloperCspDiagnostics from './DeveloperCspDiagnostics.vue';
import { lazyStrings } from '@/strings';
import { isModelSupportInvestigationAvailable } from '@/features/transformers-js/model-support-investigation';

const props = defineProps<{
  storageType: string,
}>();

const emit = defineEmits<{
  (e: 'openModelSupportInvestigation', modelId: string): void,
}>();

const { createSampleChat, createLongSampleChat } = useSampleChat();
const canOpenModelSupportInvestigation = computed(() => isModelSupportInvestigationAvailable);
const { status: pwaStatus, setUpdateState } = usePWAUpdate();
const hasPWAUpdate = computed(() => {
  const status = pwaStatus.value;
  switch (status) {
  case 'idle': return false;
  case 'preparing':
  case 'ready':
  case 'applying': return true;
  default: {
    const exhaustive: never = status;
    return exhaustive;
  }
  }
});

function togglePWAUpdate(): void {
  const status = pwaStatus.value;
  switch (status) {
  case 'idle':
    setUpdateState({
      next: {
        kind: 'ready',
        handler: async () => {
          console.log('PWA Update triggered via Developer Tab');
          window.location.reload();
        },
      },
    });
    return;
  case 'preparing':
  case 'ready':
  case 'applying':
    setUpdateState({ next: { kind: 'idle' } });
    return;
  default: {
    const exhaustive: never = status;
    throw new Error(String(exhaustive));
  }
  }
}


function handleReload() {
  window.location.reload();
}

function openModelSupportInvestigation() {
  if (!canOpenModelSupportInvestigation.value) {
    return;
  }
  emit('openModelSupportInvestigation', '');
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div data-testid="developer-section" class="animate-in fade-in slide-in-from-bottom-2" tw-class="@container space-y-7 duration-300">
    <section tw-class="space-y-7">
      <div tw-class="flex items-center gap-2.5 border-b border-gray-200/70 pb-4 dark:border-gray-800">
        <CpuIcon aria-hidden="true" tw-class="h-5 w-5 shrink-0 text-blue-500 dark:text-blue-400" />
        <h2 tw-class="text-lg font-semibold tracking-tight text-gray-800 dark:text-gray-100">{{ lazyStrings.DeveloperTab__developer_tools() }}</h2>
      </div>

      <div tw-class="space-y-7">
        <section tw-class="space-y-3">
          <h3 tw-class="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200"><FlaskConicalIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-amber-500 dark:text-amber-400" />{{ lazyStrings.DeveloperTab__experimental_features() }}</h3>
          <FeatureFlagsSettings />
        </section>

        <section tw-class="space-y-3 border-t border-gray-200/70 pt-5 dark:border-gray-800">
          <h3 tw-class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.DeveloperTab__debug_and_testing() }}</h3>
          <div tw-class="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <ActionButton
              :icon-tone="undefined"
              :disabled="false"
              appearance="primary"
              @click="createSampleChat"
              tw-class="w-full sm:w-auto"
              data-testid="setting-create-sample-button"
            >
              <FlaskConicalIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />
              {{ lazyStrings.DeveloperTab__create_sample_chat() }}
            </ActionButton>
            <ActionButton
              :icon-tone="undefined"
              :disabled="false"
              appearance="primary"
              @click="createLongSampleChat"
              tw-class="w-full sm:w-auto"
              data-testid="setting-create-long-sample-button"
            >
              <ScrollTextIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />
              {{ lazyStrings.DeveloperTab__create_long_sample_chat() }}
            </ActionButton>
          </div>
          <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.DeveloperTab__sample_conversations_description() }}</p>
        </section>

        <section v-if="canOpenModelSupportInvestigation" tw-class="space-y-3 border-t border-gray-200/70 pt-5 dark:border-gray-800">
          <div>
            <h3 tw-class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.ModelSupportInvestigationModal__model_support_investigation() }}</h3>
            <p tw-class="mt-1.5 max-w-2xl text-xs leading-relaxed text-gray-500 dark:text-gray-400">
              {{ lazyStrings.ModelSupportInvestigationModal__full_model_download_is_disabled_during_investigation() }}
            </p>
          </div>
          <ActionButton
            :icon-tone="undefined"
            :disabled="false"
            appearance="primary"
            data-testid="open-model-support-investigation-button"
            tw-class="w-full sm:w-auto"
            @click="openModelSupportInvestigation"
          >
            <SearchCheckIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />
            {{ lazyStrings.ModelSupportInvestigationModal__model_support_investigation() }}
          </ActionButton>
        </section>

        <DeveloperOpenStateLinks />

        <DeveloperCspDiagnostics />

        <section tw-class="grid gap-4 border-t border-gray-200/70 pt-5 dark:border-gray-800 @2xl:grid-cols-2">
          <div tw-class="min-w-0 space-y-2">
            <ActionButton
              :icon-tone="undefined"
              :disabled="false"
              appearance="primary"
              :aria-pressed="hasPWAUpdate"
              @click="togglePWAUpdate"
              tw-class="w-full"
              data-testid="toggle-pwa-update-button"
            >
              <RefreshCwIcon :class="hasPWAUpdate ? 'animate-spin-slow' : ''" aria-hidden="true" tw-class="h-4 w-4 shrink-0" />
              <span tw-class="min-w-0 flex-1 text-left">{{ lazyStrings.DeveloperTab__simulate_pwa_update() }}</span>
              <span v-if="hasPWAUpdate" aria-hidden="true" tw-class="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500 dark:bg-emerald-400" />
            </ActionButton>
            <p tw-class="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.DeveloperTab__toggle_update_notification() }}</p>
          </div>

          <div tw-class="min-w-0 space-y-2">
            <ActionButton
              :icon-tone="undefined"
              :disabled="false"
              appearance="secondary"
              @click="handleReload"
              tw-class="w-full"
              data-testid="reload-app-button"
            >
              <RefreshCwIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />
              <span tw-class="min-w-0 flex-1 text-left">{{ lazyStrings.DeveloperTab__reload_application() }}</span>
            </ActionButton>
            <p tw-class="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.DeveloperTab__perform_window_reload() }}</p>
          </div>
        </section>

        <DeveloperDataDeletionPanel :storage-type="props.storageType" />
      </div>
    </section>
  </div>
</template>

<style scoped>
@keyframes spin-slow {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.animate-spin-slow {
  animation: spin-slow 8s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .animate-spin-slow {
    animation: none;
  }
}
</style>
