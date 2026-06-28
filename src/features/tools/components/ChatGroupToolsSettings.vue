<script setup lang="ts">
import { useChatGroupToolConfigs } from '@/features/tools/composables/useChatGroupToolConfigs';
import ToolConfigHierarchySettings from './ToolConfigHierarchySettings.vue';

const groupTools = useChatGroupToolConfigs();

defineExpose({ TEST_ONLY: {} });

</script>

<template>
  <ToolConfigHierarchySettings
    scope="chat_group"
    :tool-configs="groupTools.toolConfigs.value"
    :effective-tool-configs="groupTools.effectiveToolConfigs.value"
    :is-editable="groupTools.isEditable.value"
    @set-status="groupTools.setToolStatus($event)"
    @reset-tool="groupTools.resetTool($event)"
    @set-wesh-access-scope="groupTools.setWeshAccessScope($event)"
  />
</template>
