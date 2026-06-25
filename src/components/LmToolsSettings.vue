<script setup lang="ts">
import { computed } from 'vue';
import { InfoIcon } from 'lucide-vue-next';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import {
  getActiveChatToolConfigs,
  getEffectiveToolConfigsForChat,
  useChatTools,
} from '@/composables/useChatTools';
import { useChatWeshPreferences } from '@/composables/useChatWeshPreferences';
import { useSettings } from '@/composables/useSettings';
import type { BuiltinToolKey, LmToolName } from '@/services/tools/types';
import ToolConfigHierarchySettings from './ToolConfigHierarchySettings.vue';

const { currentChat } = useCurrentChatState();
const { settings } = useSettings();
const chatTools = useChatTools();
const { setNaidanSysfsAccessScope } = useChatWeshPreferences();

function lmToolNameForKey({ key }: { key: BuiltinToolKey }): LmToolName {
  switch (key) {
  case 'builtin.calculator':
    return 'calculator';
  case 'builtin.choices':
    return 'choices';
  case 'builtin.wikipedia':
    return 'wikipedia_search';
  case 'builtin.wesh':
    return 'shell_execute';
  default: {
    const _ex: never = key;
    throw new Error(`Unhandled builtin tool key: ${_ex}`);
  }
  }
}

const toolConfigs = computed(() => {
  const chat = currentChat.value;
  if (chat === null) return undefined;
  return getActiveChatToolConfigs({
    chatId: chat.id,
    persistedToolConfigs: chat.toolConfigs,
  });
});

const effectiveToolConfigs = computed(() => {
  const chat = currentChat.value;
  if (chat === null) return [];
  return getEffectiveToolConfigsForChat({ chat });
});

const inheritanceLabelByKey = computed(() => ({
  'builtin.calculator': chatTools.getToolInheritanceLabel({ name: 'calculator' }),
  'builtin.choices': chatTools.getToolInheritanceLabel({ name: 'choices' }),
  'builtin.wikipedia': chatTools.getToolInheritanceLabel({ name: 'wikipedia_search' }),
  'builtin.wesh': chatTools.getToolInheritanceLabel({ name: 'shell_execute' }),
} as const));

function setToolStatus({
  key,
  status,
}: {
  key: BuiltinToolKey;
  status: 'enabled' | 'disabled';
}): void {
  chatTools.setToolStatus({
    name: lmToolNameForKey({ key }),
    status,
  });
}

function resetTool({ key }: { key: BuiltinToolKey }): void {
  chatTools.resetToolToInherited({
    name: lmToolNameForKey({ key }),
  });
}

defineExpose({ TEST_ONLY: {} });

</script>

<template>
  <div class="space-y-3">
    <div
      v-if="settings.experimental?.toolConfigPersistence !== 'enabled'"
      class="flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50/40 px-3 py-2 text-blue-900 dark:border-blue-500/20 dark:bg-blue-500/5 dark:text-blue-200"
      data-testid="chat-tool-runtime-note"
    >
      <InfoIcon class="mt-0.5 h-3 w-3 shrink-0" />
      <p class="text-[9px] leading-relaxed">
        Changes apply to this browser session only while Tool config persistence is disabled.
      </p>
    </div>

    <ToolConfigHierarchySettings
      v-if="currentChat"
      scope="chat"
      :tool-configs="toolConfigs"
      :effective-tool-configs="effectiveToolConfigs"
      :inheritance-label-by-key="inheritanceLabelByKey"
      :is-editable="true"
      @set-status="setToolStatus($event)"
      @reset-tool="resetTool($event)"
      @set-wesh-access-scope="setNaidanSysfsAccessScope({ chatId: currentChat.id, accessScope: $event.accessScope })"
    />
  </div>
</template>
