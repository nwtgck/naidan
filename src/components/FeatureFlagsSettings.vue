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


type FeatureRowCopy = {
  readonly title: string,
  readonly summary: string,
  readonly details: string,
  readonly toggleLabel: string,
};

function resolveFeatureRowCopy({
  title,
  summary,
  details,
  toggleLabel,
}: {
  readonly title: string | undefined,
  readonly summary: string | undefined,
  readonly details: string | undefined,
  readonly toggleLabel: string | undefined,
}): FeatureRowCopy | undefined {
  if (
    title === undefined ||
    summary === undefined ||
    details === undefined ||
    toggleLabel === undefined
  ) {
    return undefined;
  }
  return { title, summary, details, toggleLabel };
}

function resolveDetailsAndToggleLabel({
  details,
  toggleLabel,
}: {
  readonly details: string | undefined,
  readonly toggleLabel: string | undefined,
}): Pick<FeatureRowCopy, 'details' | 'toggleLabel'> | undefined {
  if (details === undefined || toggleLabel === undefined) return undefined;
  return { details, toggleLabel };
}

function sidebarSendMessageReorderCopy(): Pick<FeatureRowCopy, 'details' | 'toggleLabel'> | undefined {
  switch (sidebarSendMessageReorder.value) {
  case 'disabled':
    return resolveDetailsAndToggleLabel({
      details: lazyStrings.FeatureFlagsSettings__move_chat_disabled_details(),
      toggleLabel: lazyStrings.FeatureFlagsSettings__enable_move_chat_on_send(),
    });
  case 'move_sent_chat':
    return resolveDetailsAndToggleLabel({
      details: lazyStrings.FeatureFlagsSettings__move_chat_enabled_details(),
      toggleLabel: lazyStrings.FeatureFlagsSettings__disable_move_chat_on_send(),
    });
  default: {
    const _ex: never = sidebarSendMessageReorder.value;
    throw new Error(`Unhandled sidebar send reorder setting: ${_ex}`);
  }
  }
}

function toolConfigPersistenceCopy(): Pick<FeatureRowCopy, 'details' | 'toggleLabel'> | undefined {
  switch (toolConfigPersistence.value) {
  case 'disabled':
    return resolveDetailsAndToggleLabel({
      details: lazyStrings.FeatureFlagsSettings__tool_persistence_disabled_details(),
      toggleLabel: lazyStrings.FeatureFlagsSettings__enable_tool_config_persistence(),
    });
  case 'enabled':
    return resolveDetailsAndToggleLabel({
      details: lazyStrings.FeatureFlagsSettings__tool_persistence_enabled_details(),
      toggleLabel: lazyStrings.FeatureFlagsSettings__disable_tool_config_persistence(),
    });
  default: {
    const _ex: never = toolConfigPersistence.value;
    throw new Error(`Unhandled tool config persistence setting: ${_ex}`);
  }
  }
}

function fakeLmToggleLabel(): string | undefined {
  switch (fakeLmDebugModeStatus.value) {
  case 'disabled':
    return lazyStrings.FeatureFlagsSettings__enable_fake_lm();
  case 'enabled':
    return lazyStrings.FeatureFlagsSettings__disable_fake_lm();
  default: {
    const _ex: never = fakeLmDebugModeStatus.value;
    throw new Error(`Unhandled fake LM debug mode status: ${_ex}`);
  }
  }
}

const volumeFeatureCopy = computed(() => resolveFeatureRowCopy({
  title: lazyStrings.FeatureFlagsSettings__folders(),
  summary: lazyStrings.FeatureFlagsSettings__shows_folders_tab(),
  details: isFeatureEnabled({ feature: 'volume' })
    ? lazyStrings.FeatureFlagsSettings__folders_enabled_details()
    : lazyStrings.FeatureFlagsSettings__folders_disabled_details(),
  toggleLabel: isFeatureEnabled({ feature: 'volume' })
    ? lazyStrings.FeatureFlagsSettings__disable_folders()
    : lazyStrings.FeatureFlagsSettings__enable_folders(),
}));

const weshToolFeatureCopy = computed(() => resolveFeatureRowCopy({
  title: lazyStrings.FeatureFlagsSettings__shell_in_browser(),
  summary: lazyStrings.FeatureFlagsSettings__shows_shell_in_chat_tools(),
  details: isFeatureEnabled({ feature: 'wesh_tool' })
    ? lazyStrings.FeatureFlagsSettings__shell_enabled_details()
    : lazyStrings.FeatureFlagsSettings__shell_disabled_details(),
  toggleLabel: isFeatureEnabled({ feature: 'wesh_tool' })
    ? lazyStrings.FeatureFlagsSettings__disable_shell()
    : lazyStrings.FeatureFlagsSettings__enable_shell(),
}));

const sidebarSendMessageReorderFeatureCopy = computed(() => {
  const copy = sidebarSendMessageReorderCopy();
  return resolveFeatureRowCopy({
    title: lazyStrings.FeatureFlagsSettings__move_chat_on_send(),
    summary: lazyStrings.FeatureFlagsSettings__moves_active_chat_after_send(),
    details: copy?.details,
    toggleLabel: copy?.toggleLabel,
  });
});

const toolConfigPersistenceFeatureCopy = computed(() => {
  const copy = toolConfigPersistenceCopy();
  return resolveFeatureRowCopy({
    title: lazyStrings.FeatureFlagsSettings__tool_config_persistence(),
    summary: lazyStrings.FeatureFlagsSettings__saves_tool_settings(),
    details: copy?.details,
    toggleLabel: copy?.toggleLabel,
  });
});

const fakeLmFeatureCopy = computed(() => resolveFeatureRowCopy({
  title: lazyStrings.FeatureFlagsSettings__fake_lm_debug_mode(),
  summary: lazyStrings.FeatureFlagsSettings__uses_bundled_fake_lm(),
  details: fakeLmDebugModeDetails.value,
  toggleLabel: fakeLmToggleLabel(),
}));

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
    title: await ensureStrings.FeatureFlagsSettings__enable_experimental_feature(),
    message: await ensureStrings.FeatureFlagsSettings__experimental_feature_warning(),
    confirmButtonText: await ensureStrings.FeatureFlagsSettings__enable(),
    cancelButtonText: await ensureStrings.FeatureFlagsSettings__cancel(),
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
        v-if="volumeFeatureCopy"
        id="feature-volume"
        :title="volumeFeatureCopy.title"
        :summary="volumeFeatureCopy.summary"
        :details="volumeFeatureCopy.details"
        :status="isFeatureEnabled({ feature: 'volume' }) ? 'enabled' : 'disabled'"
        toggle-availability="available"
        :toggle-label="volumeFeatureCopy.toggleLabel"
        toggle-test-id="feature-flag-volume-toggle"
        @toggle="handleFeatureToggle({ feature: 'volume' })"
      >
        <template #icon>
          <FolderIcon class="h-4 w-4" />
        </template>
      </ExperimentalFeatureRow>

      <ExperimentalFeatureRow
        v-if="weshToolFeatureCopy"
        id="feature-wesh-tool"
        :title="weshToolFeatureCopy.title"
        :summary="weshToolFeatureCopy.summary"
        :details="weshToolFeatureCopy.details"
        :status="isFeatureEnabled({ feature: 'wesh_tool' }) ? 'enabled' : 'disabled'"
        toggle-availability="available"
        :toggle-label="weshToolFeatureCopy.toggleLabel"
        toggle-test-id="feature-flag-wesh-tool-toggle"
        @toggle="handleFeatureToggle({ feature: 'wesh_tool' })"
      >
        <template #icon>
          <TerminalIcon class="h-4 w-4" />
        </template>
      </ExperimentalFeatureRow>

      <ExperimentalFeatureRow
        v-if="sidebarSendMessageReorderFeatureCopy"
        id="feature-sidebar-send-reorder"
        :title="sidebarSendMessageReorderFeatureCopy.title"
        :summary="sidebarSendMessageReorderFeatureCopy.summary"
        :details="sidebarSendMessageReorderFeatureCopy.details"
        :status="sidebarSendMessageReorder === 'move_sent_chat' ? 'enabled' : 'disabled'"
        toggle-availability="available"
        :toggle-label="sidebarSendMessageReorderFeatureCopy.toggleLabel"
        toggle-test-id="feature-sidebar-send-reorder-toggle"
        @toggle="handleSidebarSendMessageReorderToggle"
      >
        <template #icon>
          <ListRestartIcon class="h-4 w-4" />
        </template>
      </ExperimentalFeatureRow>

      <ExperimentalFeatureRow
        v-if="toolConfigPersistenceFeatureCopy"
        id="feature-tool-config-persistence"
        :title="toolConfigPersistenceFeatureCopy.title"
        :summary="toolConfigPersistenceFeatureCopy.summary"
        :details="toolConfigPersistenceFeatureCopy.details"
        :status="toolConfigPersistence === 'enabled' ? 'enabled' : 'disabled'"
        toggle-availability="available"
        :toggle-label="toolConfigPersistenceFeatureCopy.toggleLabel"
        toggle-test-id="feature-tool-config-persistence-toggle"
        @toggle="handleToolConfigPersistenceToggle"
      >
        <template #icon>
          <FlaskConicalIcon class="h-4 w-4" />
        </template>
      </ExperimentalFeatureRow>

      <ExperimentalFeatureRow
        v-if="fakeLmFeatureCopy"
        id="feature-fake-lm"
        :title="fakeLmFeatureCopy.title"
        :summary="fakeLmFeatureCopy.summary"
        :details="fakeLmFeatureCopy.details"
        :status="fakeLmDebugModeStatus"
        :toggle-availability="fakeLmToggleAvailability"
        :toggle-label="fakeLmFeatureCopy.toggleLabel"
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
