<script setup lang="ts">
import { computed } from 'vue';
import { AlertTriangleIcon, FlaskConicalIcon, FolderIcon, ListRestartIcon, TerminalIcon } from 'lucide-vue-next';
import { useConfirm } from '@/composables/useConfirm';
import { useFeatureFlags } from '@/composables/useFeatureFlags';
import { useSettings } from '@/composables/useSettings';
import {
  FAKE_LM_ENDPOINT_URL,
  preloadFakeLmLanguagePacks,
  useFakeLmDebugMode,
  type FakeLmDebugModeStatus,
} from '@/services/fake-lm';
import ExperimentalFeatureRow from './ExperimentalFeatureRow.vue';

const { isFeatureEnabled, setFeatureEnabled } = useFeatureFlags();
const { showConfirm } = useConfirm();
const { settings, save, setFakeLmDebugModeStatus } = useSettings();
const { fakeLmDebugModeAvailability } = useFakeLmDebugMode();

const sidebarSendMessageReorder = computed(() => settings.value.experimental?.sidebarSendMessageReorder ?? 'disabled');
const toolConfigPersistence = computed(() => settings.value.experimental?.toolConfigPersistence ?? 'disabled');
const fakeLmDebugModeStatus = computed<FakeLmDebugModeStatus>(() => settings.value.experimental?.fakeLm ?? 'disabled');
const fakeLmToggleAvailability = computed(() => {
  switch (fakeLmDebugModeAvailability.value) {
  case 'available':
    return 'available';
  case 'unavailable_in_standalone':
    return 'unavailable';
  default: {
    const _ex: never = fakeLmDebugModeAvailability.value;
    throw new Error(`Unhandled fake LM debug mode availability: ${_ex}`);
  }
  }
});
const fakeLmDebugModeDetails = computed(() => {
  switch (fakeLmDebugModeAvailability.value) {
  case 'available':
    return `Use ${FAKE_LM_ENDPOINT_URL} as an OpenAI-compatible or Ollama endpoint.`;
  case 'unavailable_in_standalone':
    return 'Hosted build only. Standalone builds do not bundle fake LM.';
  default: {
    const _ex: never = fakeLmDebugModeAvailability.value;
    throw new Error(`Unhandled fake LM debug mode availability: ${_ex}`);
  }
  }
});

preloadFakeLmLanguagePacks();

async function handleFeatureToggle({ feature }: { feature: 'volume' | 'wesh_tool' }) {
  if (isFeatureEnabled({ feature })) {
    setFeatureEnabled({
      feature,
      enabled: false,
    });
    return;
  }

  const confirmed = await showConfirm({
    title: 'Enable Experimental Feature?',
    message: 'This feature is experimental. Future updates may include breaking changes or remove compatibility with the data and behavior introduced by this flag.',
    confirmButtonText: 'Enable',
    cancelButtonText: 'Cancel',
  });

  if (!confirmed) {
    return;
  }

  setFeatureEnabled({
    feature,
    enabled: true,
  });
}

async function handleToolConfigPersistenceToggle() {
  const next = (() => {
    switch (toolConfigPersistence.value) {
    case 'disabled':
      return 'enabled';
    case 'enabled':
      return 'disabled';
    default: {
      const _ex: never = toolConfigPersistence.value;
      throw new Error(`Unhandled tool config persistence setting: ${_ex}`);
    }
    }
  })();
  await save({ patch: {
    experimental: {
      ...settings.value.experimental,
      toolConfigPersistence: next,
    },
  } });
}

async function handleSidebarSendMessageReorderToggle() {
  const next = (() => {
    switch (sidebarSendMessageReorder.value) {
    case 'disabled':
      return 'move_sent_chat';
    case 'move_sent_chat':
      return 'disabled';
    default: {
      const _ex: never = sidebarSendMessageReorder.value;
      throw new Error(`Unhandled sidebar send reorder setting: ${_ex}`);
    }
    }
  })();
  await save({ patch: {
    experimental: {
      ...settings.value.experimental,
      sidebarSendMessageReorder: next,
    },
  } });
}

async function handleFakeLmDebugModeToggle() {
  switch (fakeLmToggleAvailability.value) {
  case 'available':
    break;
  case 'unavailable':
    return;
  default: {
    const _ex: never = fakeLmToggleAvailability.value;
    throw new Error(`Unhandled fake LM toggle availability: ${_ex}`);
  }
  }

  const next = (() => {
    switch (fakeLmDebugModeStatus.value) {
    case 'disabled':
      return 'enabled';
    case 'enabled':
      return 'disabled';
    default: {
      const _ex: never = fakeLmDebugModeStatus.value;
      throw new Error(`Unhandled fake LM debug mode status: ${_ex}`);
    }
    }
  })();

  await setFakeLmDebugModeStatus({ status: next });
}

defineExpose({
  TEST_ONLY: {
    handleFeatureToggle,
    handleToolConfigPersistenceToggle,
    handleSidebarSendMessageReorderToggle,
    handleFakeLmDebugModeToggle,
  }
});
</script>

<template>
  <div class="space-y-3" data-testid="feature-flags-settings">
    <div
      class="overflow-hidden rounded-2xl border border-gray-200/80 bg-white/60 shadow-sm divide-y divide-gray-200/80 dark:border-gray-800 dark:bg-gray-900/30 dark:divide-gray-800"
      data-testid="experimental-feature-list"
    >
      <ExperimentalFeatureRow
        id="feature-volume"
        title="Folders"
        summary="Shows the Folders tab in Settings."
        :details="isFeatureEnabled({ feature: 'volume' })
          ? 'Enabled by default for this browser profile. Disable it to hide the Folders tab without changing stored folder data.'
          : 'Disabled for this browser profile. Enable it to restore the Folders tab and access stored folders again.'"
        :status="isFeatureEnabled({ feature: 'volume' }) ? 'enabled' : 'disabled'"
        toggle-availability="available"
        :toggle-label="isFeatureEnabled({ feature: 'volume' }) ? 'Disable Folders' : 'Enable Folders'"
        toggle-test-id="feature-flag-volume-toggle"
        @toggle="handleFeatureToggle({ feature: 'volume' })"
      >
        <template #icon>
          <FolderIcon class="h-4 w-4" />
        </template>
      </ExperimentalFeatureRow>

      <ExperimentalFeatureRow
        id="feature-wesh-tool"
        title="Shell in browser"
        summary="Shows Shell in browser in the chat tools menu."
        :details="isFeatureEnabled({ feature: 'wesh_tool' })
          ? 'Enabled by default for this browser profile. Disable it to hide Shell in browser from the chat tools menu.'
          : 'Disabled for this browser profile. Enable it to restore Shell in browser to the chat tools menu.'"
        :status="isFeatureEnabled({ feature: 'wesh_tool' }) ? 'enabled' : 'disabled'"
        toggle-availability="available"
        :toggle-label="isFeatureEnabled({ feature: 'wesh_tool' }) ? 'Disable Shell in browser' : 'Enable Shell in browser'"
        toggle-test-id="feature-flag-wesh-tool-toggle"
        @toggle="handleFeatureToggle({ feature: 'wesh_tool' })"
      >
        <template #icon>
          <TerminalIcon class="h-4 w-4" />
        </template>
      </ExperimentalFeatureRow>

      <ExperimentalFeatureRow
        id="feature-sidebar-send-reorder"
        title="Move chat on send"
        summary="Moves the active chat after you send a message."
        :details="sidebarSendMessageReorder === 'move_sent_chat'
          ? 'When a message is sent, the chat moves to the top of its group. Top-level chats move just below chat groups.'
          : 'Disabled by default. Enable it if long chat lists make active conversations difficult to find.'"
        :status="sidebarSendMessageReorder === 'move_sent_chat' ? 'enabled' : 'disabled'"
        toggle-availability="available"
        :toggle-label="sidebarSendMessageReorder === 'move_sent_chat' ? 'Disable Move chat on send' : 'Enable Move chat on send'"
        toggle-test-id="feature-sidebar-send-reorder-toggle"
        @toggle="handleSidebarSendMessageReorderToggle"
      >
        <template #icon>
          <ListRestartIcon class="h-4 w-4" />
        </template>
      </ExperimentalFeatureRow>

      <ExperimentalFeatureRow
        id="feature-tool-config-persistence"
        title="Tool config persistence"
        summary="Saves Global, Chat Group, and Chat tool settings."
        :details="toolConfigPersistence === 'enabled'
          ? 'Global, Chat Group, and Chat overrides are persisted. Disable it to make new Chat changes runtime-only while keeping saved settings active.'
          : 'Saved settings remain active. Global and Chat Group settings are read-only, while new Chat changes last only for the current browser session.'"
        :status="toolConfigPersistence === 'enabled' ? 'enabled' : 'disabled'"
        toggle-availability="available"
        :toggle-label="toolConfigPersistence === 'enabled' ? 'Disable Tool config persistence' : 'Enable Tool config persistence'"
        toggle-test-id="feature-tool-config-persistence-toggle"
        @toggle="handleToolConfigPersistenceToggle"
      >
        <template #icon>
          <FlaskConicalIcon class="h-4 w-4" />
        </template>
      </ExperimentalFeatureRow>

      <ExperimentalFeatureRow
        id="feature-fake-lm"
        title="Fake LM Debug Mode"
        summary="Uses the bundled fake LM for endpoint testing."
        :details="fakeLmDebugModeDetails"
        :status="fakeLmDebugModeStatus"
        :toggle-availability="fakeLmToggleAvailability"
        :toggle-label="fakeLmDebugModeStatus === 'enabled' ? 'Disable Fake LM Debug Mode' : 'Enable Fake LM Debug Mode'"
        toggle-test-id="feature-fake-lm-toggle"
        @toggle="handleFakeLmDebugModeToggle"
      >
        <template #icon>
          <FlaskConicalIcon class="h-4 w-4" />
        </template>
      </ExperimentalFeatureRow>
    </div>

    <div
      class="rounded-xl border border-gray-200/80 bg-gray-50/70 px-4 py-2.5 dark:border-gray-800 dark:bg-gray-900/30"
      data-testid="experimental-feature-warning"
    >
      <div class="flex items-start gap-2.5">
        <AlertTriangleIcon class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <p class="text-[11px] font-medium leading-relaxed text-gray-600 dark:text-gray-300">
          Experimental features may change or be removed in future versions. Review the details before enabling them.
        </p>
      </div>
    </div>
  </div>
</template>
