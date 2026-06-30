<script setup lang="ts">
import { ensureStrings, lazyStrings } from '@/strings';
import { computed, ref } from 'vue';
import { InfoIcon } from 'lucide-vue-next';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import {
  getActiveChatToolConfigs,
  getEffectiveToolConfigsForChat,
  useChatTools,
} from '@/features/tools/composables/useChatTools';
import { useChatWeshPreferences } from '@/features/tools/composables/useChatWeshPreferences';
import { useSettings } from '@/composables/useSettings';
import type { BuiltinToolKey, LmToolName } from '@/01-models/tool';
import ToolConfigHierarchySettings from './ToolConfigHierarchySettings.vue';

const { currentChat } = useCurrentChatState();
const { settings } = useSettings();
const chatTools = useChatTools();
const { setNaidanSysfsAccessScope } = useChatWeshPreferences();
const saveError = ref<string | undefined>(undefined);

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

async function runToolUpdate({
  update,
}: {
  update: () => Promise<void>,
}): Promise<void> {
  saveError.value = undefined;
  try {
    await update();
  } catch (cause: unknown) {
    saveError.value = cause instanceof Error
      ? cause.message
      : await ensureStrings.LmToolsSettings__failed_to_save_chat_tool_settings();
  }
}

async function setToolStatus({
  key,
  status,
}: {
  key: BuiltinToolKey,
  status: 'enabled' | 'disabled',
}): Promise<void> {
  await runToolUpdate({
    update: async () => await chatTools.setToolStatus({
      name: lmToolNameForKey({ key }),
      status,
    }),
  });
}

async function resetTool({ key }: { key: BuiltinToolKey }): Promise<void> {
  await runToolUpdate({
    update: async () => await chatTools.resetToolToInherited({
      name: lmToolNameForKey({ key }),
    }),
  });
}

async function setWeshAccessScope({
  accessScope,
}: {
  accessScope: Parameters<typeof setNaidanSysfsAccessScope>[0]['accessScope'],
}): Promise<void> {
  const chatId = currentChat.value?.id;
  await runToolUpdate({
    update: async () => await setNaidanSysfsAccessScope({
      chatId,
      accessScope,
    }),
  });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && {
  TEST_ONLY: {},
}) || {}) });

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
        {{ lazyStrings.LmToolsSettings__changes_apply_to_this_browser_session_only_while_tool_config_persistence_is_disabled() }}
      </p>
    </div>

    <div
      v-if="saveError !== undefined"
      class="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[9px] font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
      data-testid="chat-tool-save-error"
    >
      {{ saveError }}
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
      @set-wesh-access-scope="setWeshAccessScope($event)"
    />
  </div>
</template>
