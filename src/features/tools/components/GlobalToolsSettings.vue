<script setup lang="ts">
import { WrenchIcon } from 'lucide-vue-next';
import { useGlobalToolConfigs } from '@/features/tools/composables/useGlobalToolConfigs';
import ToolConfigHierarchySettings from './ToolConfigHierarchySettings.vue';
import { lazyStrings } from '@/strings';

const globalTools = useGlobalToolConfigs();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && {
  TEST_ONLY: {},
}) || {}) });

</script>

<template>
  <section class="space-y-6" data-testid="global-tools-settings">
    <header class="space-y-2">
      <div class="flex items-center gap-2 text-blue-600 dark:text-blue-400">
        <WrenchIcon class="h-4 w-4" />
        <span class="text-[10px] font-black uppercase tracking-[0.18em]">{{ lazyStrings.GlobalToolsSettings__global_settings() }}</span>
      </div>
      <h2 class="text-xl font-black tracking-tight text-gray-900 dark:text-white">{{ lazyStrings.GlobalToolsSettings__tools() }}</h2>
      <p class="max-w-2xl text-xs leading-relaxed text-gray-500 dark:text-gray-400">
        {{ lazyStrings.GlobalToolsSettings__tool_defaults_can_be_overridden() }}
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
