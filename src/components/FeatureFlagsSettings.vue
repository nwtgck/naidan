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
import { lazyStrings, ensureStrings } from '@/strings';

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
    return lazyStrings.FeatureFlagsSettings__use_fake_lm_endpoint({ endpointUrl: FAKE_LM_ENDPOINT_URL });
  case 'unavailable_in_standalone':
    return lazyStrings.FeatureFlagsSettings__hosted_build_only();
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

  const [title, message, confirmButtonText, cancelButtonText] = await Promise.all([
    ensureStrings.FeatureFlagsSettings__enable_experimental_feature(),
    ensureStrings.FeatureFlagsSettings__experimental_feature_warning(),
    ensureStrings.FeatureFlagsSettings__enable(),
    ensureStrings.FeatureFlagsSettings__cancel(),
  ]);
  const confirmed = await showConfirm({ title, message, confirmButtonText, cancelButtonText });

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
  await save({
    patch: {
      experimental: {
        ...settings.value.experimental,
        toolConfigPersistence: next,
      },
    },
    modelRefresh: 'await',
  });
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
  await save({
    patch: {
      experimental: {
        ...settings.value.experimental,
        sidebarSendMessageReorder: next,
      },
    },
    modelRefresh: 'await',
  });
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
  },
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
        :title="lazyStrings.FeatureFlagsSettings__folders()"
        :summary="lazyStrings.FeatureFlagsSettings__shows_folders_tab()"
        :details="isFeatureEnabled({ feature: 'volume' })
          ? lazyStrings.FeatureFlagsSettings__folders_enabled_details()
          : lazyStrings.FeatureFlagsSettings__folders_disabled_details()"
        :status="isFeatureEnabled({ feature: 'volume' }) ? 'enabled' : 'disabled'"
        toggle-availability="available"
        :toggle-label="isFeatureEnabled({ feature: 'volume' }) ? lazyStrings.FeatureFlagsSettings__disable_folders() : lazyStrings.FeatureFlagsSettings__enable_folders()"
        toggle-test-id="feature-flag-volume-toggle"
        @toggle="handleFeatureToggle({ feature: 'volume' })"
      >
        <template #icon>
          <FolderIcon class="h-4 w-4" />
        </template>
      </ExperimentalFeatureRow>

      <ExperimentalFeatureRow
        id="feature-wesh-tool"
        :title="lazyStrings.FeatureFlagsSettings__shell_in_browser()"
        :summary="lazyStrings.FeatureFlagsSettings__shows_shell_in_chat_tools()"
        :details="isFeatureEnabled({ feature: 'wesh_tool' })
          ? lazyStrings.FeatureFlagsSettings__shell_enabled_details()
          : lazyStrings.FeatureFlagsSettings__shell_disabled_details()"
        :status="isFeatureEnabled({ feature: 'wesh_tool' }) ? 'enabled' : 'disabled'"
        toggle-availability="available"
        :toggle-label="isFeatureEnabled({ feature: 'wesh_tool' }) ? lazyStrings.FeatureFlagsSettings__disable_shell() : lazyStrings.FeatureFlagsSettings__enable_shell()"
        toggle-test-id="feature-flag-wesh-tool-toggle"
        @toggle="handleFeatureToggle({ feature: 'wesh_tool' })"
      >
        <template #icon>
          <TerminalIcon class="h-4 w-4" />
        </template>
      </ExperimentalFeatureRow>

      <ExperimentalFeatureRow
        id="feature-sidebar-send-reorder"
        :title="lazyStrings.FeatureFlagsSettings__move_chat_on_send()"
        :summary="lazyStrings.FeatureFlagsSettings__moves_active_chat_after_send()"
        :details="sidebarSendMessageReorder === 'move_sent_chat'
          ? lazyStrings.FeatureFlagsSettings__move_chat_enabled_details()
          : lazyStrings.FeatureFlagsSettings__move_chat_disabled_details()"
        :status="sidebarSendMessageReorder === 'move_sent_chat' ? 'enabled' : 'disabled'"
        toggle-availability="available"
        :toggle-label="sidebarSendMessageReorder === 'move_sent_chat' ? lazyStrings.FeatureFlagsSettings__disable_move_chat_on_send() : lazyStrings.FeatureFlagsSettings__enable_move_chat_on_send()"
        toggle-test-id="feature-sidebar-send-reorder-toggle"
        @toggle="handleSidebarSendMessageReorderToggle"
      >
        <template #icon>
          <ListRestartIcon class="h-4 w-4" />
        </template>
      </ExperimentalFeatureRow>

      <ExperimentalFeatureRow
        id="feature-tool-config-persistence"
        :title="lazyStrings.FeatureFlagsSettings__tool_config_persistence()"
        :summary="lazyStrings.FeatureFlagsSettings__saves_tool_settings()"
        :details="toolConfigPersistence === 'enabled'
          ? lazyStrings.FeatureFlagsSettings__tool_persistence_enabled_details()
          : lazyStrings.FeatureFlagsSettings__tool_persistence_disabled_details()"
        :status="toolConfigPersistence === 'enabled' ? 'enabled' : 'disabled'"
        toggle-availability="available"
        :toggle-label="toolConfigPersistence === 'enabled' ? lazyStrings.FeatureFlagsSettings__disable_tool_config_persistence() : lazyStrings.FeatureFlagsSettings__enable_tool_config_persistence()"
        toggle-test-id="feature-tool-config-persistence-toggle"
        @toggle="handleToolConfigPersistenceToggle"
      >
        <template #icon>
          <FlaskConicalIcon class="h-4 w-4" />
        </template>
      </ExperimentalFeatureRow>

      <ExperimentalFeatureRow
        id="feature-fake-lm"
        :title="lazyStrings.FeatureFlagsSettings__fake_lm_debug_mode()"
        :summary="lazyStrings.FeatureFlagsSettings__uses_bundled_fake_lm()"
        :details="fakeLmDebugModeDetails"
        :status="fakeLmDebugModeStatus"
        :toggle-availability="fakeLmToggleAvailability"
        :toggle-label="fakeLmDebugModeStatus === 'enabled' ? lazyStrings.FeatureFlagsSettings__disable_fake_lm() : lazyStrings.FeatureFlagsSettings__enable_fake_lm()"
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
          {{ lazyStrings.FeatureFlagsSettings__features_may_change() }}
        </p>
      </div>
    </div>
  </div>
</template>
