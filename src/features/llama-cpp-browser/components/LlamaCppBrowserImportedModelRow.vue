<script setup lang="ts">
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import type { DefaultModelContext } from '@/features/llama-cpp-browser/default-model';
import LlamaCppBrowserModelRow from './LlamaCppBrowserModelRow.vue';
import LlamaCppBrowserModelAction from './LlamaCppBrowserModelAction.vue';
import LlamaCppBrowserDefaultModelAction from './LlamaCppBrowserDefaultModelAction.vue';

defineProps<{ model: LocalModel, defaultModel: DefaultModelContext | undefined, disabled: boolean, removalDisabled: boolean, defaultActionDisabled: boolean, chatGroupAction: 'available' | 'unavailable', creating: boolean }>();
defineSlots<{ actions({ disabled }: { disabled: boolean }): unknown }>();
const emit = defineEmits<{ createChatGroup: [], selectDefault: [model: LocalModel], remove: [] }>();


defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <LlamaCppBrowserModelRow :model="model" :removal-disabled="removalDisabled" @remove="emit('remove')">
    <template #actions>
      <slot name="actions" :disabled="disabled">
        <LlamaCppBrowserModelAction v-if="chatGroupAction === 'available'" :model="model" :current="defaultModel" :disabled="disabled" :default-action-disabled="defaultActionDisabled" :creating="creating" @create-chat-group="emit('createChatGroup')" @select-default="emit('selectDefault', $event)" />
        <LlamaCppBrowserDefaultModelAction v-else :model="model" :current="defaultModel" :disabled="disabled || defaultActionDisabled" @select="emit('selectDefault', $event)" />
      </slot>
    </template>
  </LlamaCppBrowserModelRow>
</template>
