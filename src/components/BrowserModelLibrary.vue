<script setup lang="ts">
import { useSettings } from '@/composables/useSettings';
import { computed, watch } from 'vue';
import { useAppEntry } from '@/composables/useAppEntry';
import { lazyStrings } from '@/strings';
import { ArrowRightIcon } from 'lucide-vue-next';
import LlamaCppBrowserModelActionButton from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelActionButton.vue';
import { useLocalModelStart } from '@/composables/useLocalModelStart';
import LlamaCppBrowserModelLibrary from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelLibrary.vue';
import type { ApplyDefaultModel } from '@/features/llama-cpp-browser/default-model';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { useRecentModelImports } from '@/features/llama-cpp-browser/composables/useRecentModelImports';
import type { ModelInventorySource } from '@/features/llama-cpp-browser/composables/model-inventory';

const props = defineProps<{ suspended: boolean, inventory: ModelInventorySource }>();
const { settings, updateGlobalModelAndEndpoint } = useSettings();
const { startLocalModel } = useLocalModelStart();
const { prune } = useRecentModelImports();
watch(settings, prune);

const entry = useAppEntry();
const chatTarget = computed(() => {
  const target = entry.modelSelection.value?.target;
  if (target === undefined) {
    return undefined;
  }
  switch (target.kind) {
  case 'chat': return target;
  case 'home': return undefined;
  default: {
    const exhaustive: never = target;
    throw new Error(String(exhaustive));
  }
  }
});

function useInChat({ model }: { model: LocalModel }): void {
  if (!props.suspended && chatTarget.value !== undefined) {
    chatTarget.value.useModel({ model });
    entry.closeDiscovery();
    entry.closeModelSelection();
  }
}

const applyDefaultModel: ApplyDefaultModel = ({ model, previous }) => updateGlobalModelAndEndpoint({ endpoint: { type: 'llama_cpp_browser' }, modelId: model.modelId, expected: previous });

async function createChatGroup({ model, signal }: { model: LocalModel, signal: AbortSignal }): Promise<void> {
  if (props.suspended) {
    return;
  }
  await startLocalModel({ model, signal });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <LlamaCppBrowserModelLibrary :suspended="suspended" :inventory="inventory" :default-model="{ endpoint: settings.endpoint, modelId: settings.defaultModelId }" :apply-default-model="applyDefaultModel" :create-chat-group="createChatGroup">
    <template v-if="chatTarget" #model-actions="{ model, disabled }"><LlamaCppBrowserModelActionButton :data-testid="'discovery-use-model-' + model.modelId" :disabled="disabled" @click="useInChat({ model })">{{ lazyStrings.SHARED__use_model_in_this_chat() }}<ArrowRightIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></LlamaCppBrowserModelActionButton></template>
  </LlamaCppBrowserModelLibrary>
</template>
