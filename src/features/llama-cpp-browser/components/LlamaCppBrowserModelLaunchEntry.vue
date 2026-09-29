<script setup lang="ts">
import { computed, useId } from 'vue';
import { Loader2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import WelcomeScreen from '@/components/WelcomeScreen.vue';
import LlamaCppBrowserModelLaunchPrivacy from './LlamaCppBrowserModelLaunchPrivacy.vue';
import LlamaCppBrowserModelLaunchHeading from './LlamaCppBrowserModelLaunchHeading.vue';
import { modelLaunchPresentation } from '@/features/llama-cpp-browser/model-launch/presentation';
import { modelLaunchEntryState, retryModelLaunch } from '@/features/llama-cpp-browser/model-launch/entry-state';
const headingId = useId();
const props = defineProps<{ input?: string | (string | null)[] | null }>();
// Render the link's name immediately, including before app initialization. Do
// not wait for the remote catalog, invent a file size, or enable an early Start.
const presentation = computed(() => {
  if (props.input !== undefined) return modelLaunchPresentation({ input: props.input });
  const state = modelLaunchEntryState.value;
  switch (state.status) {
  case 'idle': return undefined;
  case 'checking': case 'failed': return modelLaunchPresentation({ input: state.input });
  default: { const exhaustive: never = state; throw new Error(String(exhaustive)); }
  }
});
const statusText = computed(() => modelLaunchEntryState.value.status === 'checking' && modelLaunchEntryState.value.phase === 'opening-chat'
  ? lazyStrings.LlamaCppBrowserModelLaunch__opening_chat()
  : lazyStrings.llamaCppBrowserDownloads__checking_hugging_face());
const errorText = computed(() => {
  switch (modelLaunchEntryState.value.status) {
  case 'idle': case 'checking': return undefined;
  case 'failed': break;
  default: { const exhaustive: never = modelLaunchEntryState.value; throw new Error(String(exhaustive)); }
  }
  switch (modelLaunchEntryState.value.problem) {
  case 'invalid-input': case 'failed': return lazyStrings.LlamaCppBrowserModelLaunch__model_link_could_not_be_opened();
  case 'variant-unavailable': return lazyStrings.LlamaCppBrowserModelLaunch__variant_not_found();
  case 'companion-required': return lazyStrings.LlamaCppBrowserModelLaunch__companion_needs_selection();
  default: { const exhaustive: never = modelLaunchEntryState.value.problem; throw new Error(String(exhaustive)); }
  }
});

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="flex-1 min-h-0 overflow-auto">
    <WelcomeScreen :has-input="true" suggestions-visibility="hidden">
      <template #primary>
        <section :aria-labelledby="presentation ? headingId : undefined" data-testid="model-launch-entry" tw-class="w-full max-w-xl mx-auto space-y-6 sm:space-y-7 pointer-events-auto text-left">
          <LlamaCppBrowserModelLaunchPrivacy />
          <LlamaCppBrowserModelLaunchHeading v-if="presentation" :repository="presentation.repository" :heading-id="headingId" />
          <p v-if="presentation?.requestedVariant" data-testid="model-launch-requested-variant" tw-class="text-center text-xs text-gray-500 dark:text-gray-400 min-h-11 flex items-center justify-center break-all">{{ presentation.requestedVariant }}</p>
          <template v-if="modelLaunchEntryState.status === 'failed'">
            <p role="alert" tw-class="text-sm text-red-600 dark:text-red-400">{{ errorText }}</p>
            <div tw-class="flex flex-wrap gap-4">
              <button type="button" data-testid="model-launch-retry" @click="retryModelLaunch" tw-class="w-full min-h-14 px-5 py-3 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-semibold">{{ lazyStrings.LlamaCppBrowserModelLaunch__retry() }}</button>
            </div>
          </template>
          <p v-else role="status" tw-class="min-h-14 flex items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400"><Loader2Icon tw-class="w-5 h-5 animate-spin motion-reduce:animate-none" />{{ statusText }}</p>
        </section>
      </template>
    </WelcomeScreen>
  </div>
</template>
