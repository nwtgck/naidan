<script setup lang="ts">
import { useChatGroupToolConfigs } from '@/features/tools/composables/useChatGroupToolConfigs';
import { computed, ref, watch } from 'vue';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import type { ChatGroupId } from '@/01-models/ids';
import { ensureStrings } from '@/strings';
import ToolConfigHierarchySettings from './ToolConfigHierarchySettings.vue';

const groupTools = useChatGroupToolConfigs();
const { currentChatGroup } = useCurrentChatState();
const errorsByOwner = ref(new Map<ChatGroupId, string | undefined>());
const pendingByOwner = ref(new Map<ChatGroupId, number>());
const error = computed(() => {
  const id = currentChatGroup.value?.id;
  return id === undefined ? undefined : errorsByOwner.value.get(id);
});
const pending = computed(() => {
  const id = currentChatGroup.value?.id;
  return id === undefined ? 0 : pendingByOwner.value.get(id) ?? 0;
});
const emit = defineEmits<{ (event: 'status', status: { pending: boolean, error: string | undefined, enabledCount: number }): void }>();
watch([error, pending, groupTools.effectiveToolConfigs], () => emit('status', { pending: pending.value > 0, error: error.value, enabledCount: groupTools.effectiveToolConfigs.value.filter(config => config.status === 'enabled').length }), { immediate: true });

async function update({ operation }: { operation: () => Promise<void> }) {
  const ownerId = currentChatGroup.value?.id;
  if (ownerId === undefined) {
    return;
  }
  errorsByOwner.value.set(ownerId, undefined);
  pendingByOwner.value.set(ownerId, (pendingByOwner.value.get(ownerId) ?? 0) + 1);
  try {
    await operation();
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : await ensureStrings.ChatGroupToolsSettings__failed_to_save_chat_group_tool_settings();
    errorsByOwner.value.set(ownerId, message);
  } finally {
    pendingByOwner.value.set(ownerId, Math.max(0, (pendingByOwner.value.get(ownerId) ?? 1) - 1));
  }
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {},
  }) || {}),
});

</script>

<template>
  <div tw-class="space-y-3"><p v-if="error" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ error }}</p><ToolConfigHierarchySettings
    scope="chat_group"
    :tool-configs="groupTools.toolConfigs.value"
    :effective-tool-configs="groupTools.effectiveToolConfigs.value"
    :is-editable="groupTools.isEditable.value"
    @set-status="event => update({ operation: () => groupTools.setToolStatus(event) })"
    @reset-tool="event => update({ operation: () => groupTools.resetTool(event) })"
    @set-wesh-access-scope="event => update({ operation: () => groupTools.setWeshAccessScope(event) })"
  /></div>
</template>
