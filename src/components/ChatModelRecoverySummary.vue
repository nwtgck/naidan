<script lang="ts">
export type ChatModelRecoveryNotice = {
  reason: 'missing-files' | 'unreadable' | 'unconfigured',
  connection: 'browser' | 'server',
  modelId: string | undefined,
};
</script>
<script setup lang="ts">
import { computed, ref } from 'vue';
import { ChevronDownIcon, ChevronUpIcon, CpuIcon, LayersIcon, RotateCwIcon, ServerIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';

const props = defineProps<{
  notice: ChatModelRecoveryNotice | undefined,
  expansion: 'closed' | 'open',
  semantics: 'interactive' | 'measurement',
  headingId: string | undefined,
  panelId: string | undefined,
  committing: boolean,
}>();
const emit = defineEmits<{ toggle: [], recheck: [] }>();
const element = ref<HTMLElement>();
const sourceTabsHost = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const heading = computed(() => {
  switch (props.expansion) {
  case 'open': return lazyStrings.ChatModelRecovery__model_for_this_chat();
  case 'closed': break;
  default: {
    const exhaustive: never = props.expansion;
    return exhaustive;
  }
  }
  const reason = props.notice?.reason;
  switch (reason) {
  case undefined: return lazyStrings.ChatModelRecovery__preparing_the_model();
  case 'unreadable': return lazyStrings.ChatModelRecovery__could_not_check_model();
  case 'unconfigured': case 'missing-files': return lazyStrings.ChatModelRecovery__model_not_found();
  default: {
    const exhaustive: never = reason;
    return exhaustive;
  }
  }
});
const hint = computed(() => {
  const reason = props.notice?.reason;
  switch (reason) {
  case undefined: case 'unconfigured': return undefined;
  case 'missing-files': return lazyStrings.ChatModelRecovery__open_original_files_or_choose_another_model();
  case 'unreadable': return lazyStrings.ChatModelRecovery__check_storage_or_choose_another_model();
  default: {
    const exhaustive: never = reason;
    return exhaustive;
  }
  }
});
const canRecheck = computed(() => props.notice?.connection === 'browser' && props.notice.reason !== 'unconfigured');
defineExpose({ element, sourceTabsHost, trigger, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div ref="element" class="recovery-header" :class="{ 'recovery-header-expanded': expansion === 'open' }">
    <span class="recovery-icon" :tw-class="['transition-colors duration-350 motion-reduce:transition-none', expansion === 'open' ? 'bg-blue-50 text-blue-500 dark:bg-blue-500/10 dark:text-blue-400' : 'bg-gray-100 text-gray-400 dark:bg-gray-700/50 dark:text-gray-400']">
      <LayersIcon v-if="expansion === 'open' || notice === undefined" aria-hidden="true" tw-class="h-3.5 w-3.5" />
      <CpuIcon v-else-if="notice.connection === 'browser'" aria-hidden="true" tw-class="h-3.5 w-3.5" />
      <ServerIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5" />
    </span>
    <h3 :id="headingId" class="recovery-heading" tw-class="text-gray-700 dark:text-gray-200">{{ heading }}</h3>
    <div class="recovery-actions">
      <button v-if="canRecheck && semantics === 'interactive'" type="button" :title="lazyStrings.ChatModelRecovery__check_again()" :aria-label="lazyStrings.ChatModelRecovery__check_again()" data-testid="model-recovery-recheck" tw-class="hidden h-8 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-2 focus-visible:outline-blue-500 sm:inline-flex dark:hover:bg-gray-700 dark:hover:text-gray-200" @click="emit('recheck')"><RotateCwIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></button>
      <span v-else-if="canRecheck" tw-class="hidden h-8 w-7 shrink-0 sm:inline-block" />
      <button v-if="semantics === 'interactive'" ref="trigger" type="button" data-testid="model-recovery-select" :aria-expanded="expansion === 'open'" :aria-controls="panelId" :disabled="committing" class="recovery-action" tw-class="group rounded-lg text-gray-600 transition-colors duration-250 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-gray-100" @click="emit('toggle')">
        {{ expansion === 'open' ? lazyStrings.ChatModelRecovery__close() : lazyStrings.ChatModelRecovery__choose_model() }}
        <ChevronDownIcon v-if="expansion === 'open'" aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400" />
        <ChevronUpIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" />
      </button>
      <span v-else class="recovery-action">{{ lazyStrings.ChatModelRecovery__choose_model() }}<span tw-class="h-3.5 w-3.5" /></span>
    </div>
    <!-- The docking host stays mounted across expansion and responsive layout. -->
    <div v-if="semantics === 'interactive'" v-show="expansion === 'open'" ref="sourceTabsHost" class="recovery-source-tabs" />
    <p v-if="notice?.modelId && expansion === 'closed'" class="recovery-model-id" :data-testid="semantics === 'interactive' ? 'model-recovery-name' : undefined" tw-class="text-gray-500 dark:text-gray-400">{{ notice.modelId }}</p>
    <p v-if="hint && expansion === 'closed'" class="recovery-hint" tw-class="text-gray-400 dark:text-gray-500">{{ hint }}</p>
  </div>
</template>

<style scoped>
.recovery-header {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  align-items: center;
  gap: 3px 12px;
  padding: 12px 16px;
}
.recovery-icon {
  display: inline-flex;
  grid-column: 1;
  grid-row: 1;
  align-items: center;
  justify-content: center;
  height: 28px;
  width: 28px;
  border-radius: 8px;
}
.recovery-heading {
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 22px;
}
.recovery-actions {
  display: flex;
  grid-column: 3;
  grid-row: 1 / 4;
  align-self: center;
  align-items: center;
  justify-content: end;
}
.recovery-action {
  display: inline-flex;
  min-height: 36px;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  padding-inline: 10px;
  font-size: 13px;
  font-weight: 500;
  line-height: 16px;
}
.recovery-model-id {
  grid-column: 2;
  grid-row: 2;
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 18px;
}
.recovery-hint {
  grid-column: 2;
  grid-row: 3;
  font-size: 12px;
  line-height: 18px;
}
.recovery-source-tabs {
  grid-column: 1 / -1;
  grid-row: 2;
  min-width: 0;
  padding-top: 8px;
}
@container (max-width: 640px) {
  .recovery-header {
    grid-template-columns: 24px minmax(0, 1fr);
    gap: 5px 10px;
    padding: 12px;
  }
  .recovery-icon {
    width: 24px;
    height: 24px;
  }
  .recovery-actions {
    grid-column: 2;
    grid-row: 4;
    justify-content: start;
    margin-left: -10px;
  }
}
.recovery-header-expanded {
  grid-template-columns: 28px minmax(0, 1fr) auto;
  gap: 0 12px;
  padding: 10px 16px 8px;
}
.recovery-header-expanded .recovery-actions {
  grid-column: 3;
  grid-row: 1;
  justify-content: end;
  margin-left: 0;
}
@container (min-width: 680px) {
  .recovery-header-expanded {
    grid-template-columns: 28px auto minmax(0, 1fr) auto;
    padding-top: 8px;
    padding-bottom: 10px;
  }
  .recovery-header-expanded .recovery-actions {
    grid-column: 4;
  }
  .recovery-header-expanded .recovery-source-tabs {
    grid-column: 3;
    grid-row: 1;
    padding: 0 8px;
  }
}
</style>
