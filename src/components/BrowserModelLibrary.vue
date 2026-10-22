<script setup lang="ts">
import { useSettings } from '@/composables/useSettings';
import { watch } from 'vue';
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
  <LlamaCppBrowserModelLibrary :suspended="suspended" :inventory="inventory" :default-model="{ endpoint: settings.endpoint, modelId: settings.defaultModelId }" :apply-default-model="applyDefaultModel" :create-chat-group="createChatGroup" />
</template>
