<script setup lang="ts">
import { WrenchIcon } from 'lucide-vue-next';
import { useGlobalToolConfigs } from '@/composables/useGlobalToolConfigs';
import ToolConfigHierarchySettings from './ToolConfigHierarchySettings.vue';

const globalTools = useGlobalToolConfigs();

defineExpose({ TEST_ONLY: {} });

</script>

<template>
  <section class="space-y-6" data-testid="global-tools-settings">
    <header class="space-y-2">
      <div class="flex items-center gap-2 text-blue-600 dark:text-blue-400">
        <WrenchIcon class="h-4 w-4" />
        <span class="text-[10px] font-black uppercase tracking-[0.18em]">Global Settings</span>
      </div>
      <h2 class="text-xl font-black tracking-tight text-gray-900 dark:text-white">Tools</h2>
      <p class="max-w-2xl text-xs leading-relaxed text-gray-500 dark:text-gray-400">
        Set the defaults for every chat. Chat groups and individual chats can override each tool independently.
      </p>
    </header>

    <ToolConfigHierarchySettings
      scope="global"
      :tool-configs="globalTools.toolConfigs.value"
      :effective-tool-configs="globalTools.effectiveToolConfigs.value"
      :is-editable="globalTools.isEditable.value"
      @set-status="globalTools.setToolStatus($event)"
      @set-wesh-access-scope="globalTools.setWeshAccessScope($event)"
      @reset-all="globalTools.resetAllTools()"
    />
  </section>
</template>
