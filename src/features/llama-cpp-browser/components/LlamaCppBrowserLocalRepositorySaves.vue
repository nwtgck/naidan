<script setup lang="ts">
import { computed, onScopeDispose, shallowRef } from 'vue';
import TemporaryModelSaveNotice from '@/components/TemporaryModelSaveNotice.vue';
import { cancelLocalRepositorySave, localRepositorySaveEntries, saveLocalRepository, subscribeLocalRepositorySaves } from '@/features/llama-cpp-browser/model-files';
import { idToRaw } from '@/01-models/ids';
import { localRepositoryReference } from '@/01-models/llama-cpp-browser-model-id';

const props = defineProps<{ offeredVisibility: 'visible' | 'hidden' }>();
const entries = shallowRef(localRepositorySaveEntries());
const dismissed = shallowRef(new Set<string>());
onScopeDispose(subscribeLocalRepositorySaves({
  listener: () => {
    entries.value = localRepositorySaveEntries();
  },
}));
const visible = computed(() => entries.value.filter(entry => entry.state.phase !== 'saved' && (props.offeredVisibility === 'visible' || entry.state.phase !== 'offered') && !dismissed.value.has(idToRaw({ id: entry.source.sourceId }))).flatMap(({ source, state }) => {
  const configuration = source.configurations[0];
  if (!configuration) {
    return [];
  }
  // The copy size includes the complete repository. Its displayed ID remains
  // a real selectable variant, without exposing the internal source ID.
  const model = { modelId: localRepositoryReference({ storage: 'pending', rootName: source.rootName, selector: configuration.selector }), size: source.root.files.reduce((sum, file) => sum + file.file.size, 0), importedAt: source.root.files.reduce((latest, file) => Math.max(latest, file.file.lastModified), 0) };
  return [{ source, state: { ...state, model, sourceModel: model } }];
}));

function dismiss({ sourceId }: { sourceId: string }): void {
  dismissed.value = new Set(dismissed.value).add(sourceId);
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div v-if="visible.length" data-testid="local-repository-saves" tw-class="space-y-2">
    <TemporaryModelSaveNotice v-for="entry in visible" :key="idToRaw({ id: entry.source.sourceId })" :state="entry.state" @save="saveLocalRepository({ source: entry.source })" @retry="saveLocalRepository({ source: entry.source })" @cancel="cancelLocalRepositorySave({ source: entry.source })" @dismiss="dismiss({ sourceId: idToRaw({ id: entry.source.sourceId }) })" />
  </div>
</template>
