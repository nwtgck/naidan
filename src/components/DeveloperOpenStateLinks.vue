<script setup lang="ts">
import { ref } from 'vue';
import { CopyIcon, ExternalLinkIcon, Loader2Icon } from 'lucide-vue-next';
import { urlImportExportLogic } from '@/features/import-export/url-logic';
import { useToast } from '@/composables/useToast';
import { useExportExclusions } from '@/features/import-export/composables/useExportExclusions';
import { lazyStrings, ensureStrings } from '@/strings';
import SettingsChoiceControl from './SettingsChoiceControl.vue';

type DeploymentTarget = {
  readonly kind: 'Standard' | 'Local only' | 'Curated',
  readonly host: string,
  readonly baseUrl: string,
};

type DeploymentGroup = {
  readonly id: 'production' | 'develop',
  readonly label: 'Production' | 'develop branch',
  readonly targets: readonly DeploymentTarget[],
};

const DEPLOYMENT_GROUPS = [
  {
    id: 'production',
    label: 'Production',
    targets: [
      { kind: 'Standard', host: 'naidan.pages.dev', baseUrl: 'https://naidan.pages.dev' },
      { kind: 'Local only', host: 'naidan-local-only.pages.dev', baseUrl: 'https://naidan-local-only.pages.dev' },
      { kind: 'Curated', host: 'naidan-curated.pages.dev', baseUrl: 'https://naidan-curated.pages.dev' },
    ],
  },
  {
    id: 'develop',
    label: 'develop branch',
    targets: [
      { kind: 'Standard', host: 'develop.naidan.pages.dev', baseUrl: 'https://develop.naidan.pages.dev' },
      { kind: 'Local only', host: 'develop.naidan-local-only.pages.dev', baseUrl: 'https://develop.naidan-local-only.pages.dev' },
      { kind: 'Curated', host: 'develop.naidan-curated.pages.dev', baseUrl: 'https://develop.naidan-curated.pages.dev' },
    ],
  },
] as const satisfies readonly DeploymentGroup[];

const DEPLOYMENT_TARGETS: readonly DeploymentTarget[] = DEPLOYMENT_GROUPS.flatMap(
  group => [...group.targets],
);

function deploymentGroupLabel({ label }: { label: DeploymentGroup['label'] }): string | undefined {
  switch (label) {
  case 'Production':
    return lazyStrings.DeveloperOpenStateLinks__production();
  case 'develop branch':
    return lazyStrings.DeveloperOpenStateLinks__develop_branch();
  default: {
    const _ex: never = label;
    throw new Error(`Unhandled deployment group label: ${_ex}`);
  }
  }
}

function deploymentTargetKindLabel({ kind }: { kind: DeploymentTarget['kind'] }): string | undefined {
  switch (kind) {
  case 'Standard':
    return lazyStrings.DeveloperOpenStateLinks__standard();
  case 'Local only':
    return lazyStrings.DeveloperOpenStateLinks__local_only();
  case 'Curated':
    return lazyStrings.DeveloperOpenStateLinks__curated();
  default: {
    const _ex: never = kind;
    throw new Error(`Unhandled deployment target kind: ${_ex}`);
  }
  }
}

const { addToast } = useToast();
const activeAction = ref<{ type: 'copy' | 'open', host: string } | null>(null);
const {
  excludeChats,
  excludeChatHistory,
  excludeAttachments,
  excludeChatHistoryDisabled,
  buildExcludeList,
} = useExportExclusions();

async function createCurrentStateURL({ target }: { target: DeploymentTarget }) {
  return await urlImportExportLogic.getExportURL({
    exclude: buildExcludeList(),
    baseUrl: target.baseUrl,
  });
}

async function copyCurrentStateURL({ target }: { target: DeploymentTarget }) {
  if (activeAction.value) {
    return;
  }

  activeAction.value = { type: 'copy', host: target.host };
  try {
    const url = await createCurrentStateURL({ target });
    await navigator.clipboard.writeText(url);
    addToast({ message: await ensureStrings.DeveloperOpenStateLinks__copied_url_for_host({ host: target.host }), duration: 3000 });
  } catch (err) {
    console.error('Failed to copy current state URL:', err);
    addToast({
      message: await ensureStrings.DeveloperOpenStateLinks__failed_to_copy_state_url({ errorMessage: err instanceof Error ? err.message : String(err) }),
      duration: 5000,
    });
  } finally {
    activeAction.value = null;
  }
}

async function openCurrentState({ target }: { target: DeploymentTarget }) {
  if (activeAction.value) {
    return;
  }

  activeAction.value = { type: 'open', host: target.host };
  try {
    const url = await createCurrentStateURL({ target });
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (err) {
    console.error('Failed to open current state URL:', err);
    addToast({
      message: await ensureStrings.DeveloperOpenStateLinks__failed_to_open_state_url({ errorMessage: err instanceof Error ? err.message : String(err) }),
      duration: 5000,
    });
  } finally {
    activeAction.value = null;
  }
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      DEPLOYMENT_GROUPS,
      DEPLOYMENT_TARGETS,
      buildExcludeList,
      copyCurrentStateURL,
      openCurrentState,
    },
  }) || {}),
});
</script>

<template>
  <section tw-class="space-y-4 border-t border-gray-200/70 pt-5 dark:border-gray-800" data-testid="developer-open-state-links">
    <div>
      <h3 tw-class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.DeveloperOpenStateLinks__open_current_state() }}</h3>
      <p tw-class="mt-1.5 max-w-2xl text-xs leading-relaxed text-gray-500 dark:text-gray-400">
        {{ lazyStrings.DeveloperOpenStateLinks__open_state_description() }}
      </p>
    </div>

    <div tw-class="space-y-3 rounded-xl border border-gray-200/80 bg-gray-50/60 p-3 dark:border-gray-800 dark:bg-gray-900/30">
      <div>
        <h4 tw-class="text-xs font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.DeveloperOpenStateLinks__state_contents() }}</h4>
        <p tw-class="mt-1 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
          {{ lazyStrings.DeveloperOpenStateLinks__choose_data_to_omit() }}
        </p>
      </div>
      <fieldset tw-class="flex min-w-0 flex-wrap gap-x-5 gap-y-3">
        <legend tw-class="sr-only">{{ lazyStrings.DeveloperOpenStateLinks__excluded_data() }}</legend>
        <label tw-class="inline-flex cursor-pointer items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
          <SettingsChoiceControl presentation="checkbox">
            <input
              v-model="excludeChats"
              type="checkbox"
              data-testid="open-current-state-exclude-chats"
            />
          </SettingsChoiceControl>
          {{ lazyStrings.DeveloperOpenStateLinks__exclude_chats() }}
        </label>
        <label :tw-class="['inline-flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300', excludeChatHistoryDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer']">
          <SettingsChoiceControl presentation="checkbox">
            <input
              v-model="excludeChatHistory"
              :disabled="excludeChatHistoryDisabled"
              type="checkbox"
              data-testid="open-current-state-exclude-chat-history"
            />
          </SettingsChoiceControl>
          {{ lazyStrings.DeveloperOpenStateLinks__exclude_chat_history() }}
        </label>
        <label tw-class="inline-flex cursor-pointer items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
          <SettingsChoiceControl presentation="checkbox">
            <input
              v-model="excludeAttachments"
              type="checkbox"
              data-testid="open-current-state-exclude-attachments"
            />
          </SettingsChoiceControl>
          {{ lazyStrings.DeveloperOpenStateLinks__exclude_attachments() }}
        </label>
      </fieldset>
    </div>

    <div tw-class="grid grid-cols-1 gap-5 @3xl:grid-cols-2 @3xl:gap-6" data-testid="open-current-state-groups">
      <section
        v-for="group in DEPLOYMENT_GROUPS"
        :key="group.id"
        tw-class="min-w-0"
        :data-testid="`open-current-state-group-${group.id}`"
      >
        <h4 tw-class="mb-2 text-xs font-medium text-gray-700 dark:text-gray-200">
          {{ deploymentGroupLabel({ label: group.label }) }}
        </h4>
        <div tw-class="divide-y divide-gray-200/70 border-y border-gray-200/70 dark:divide-gray-800 dark:border-gray-800">
          <div
            v-for="target in group.targets"
            :key="target.host"
            tw-class="flex min-h-14 min-w-0 items-center justify-between gap-2 py-2"
            :data-testid="`open-current-state-row-${target.host}`"
          >
            <div tw-class="min-w-0 space-y-0.5">
              <span tw-class="block text-[11px] text-gray-500 dark:text-gray-400">{{ deploymentTargetKindLabel({ kind: target.kind }) }}</span>
              <span tw-class="block break-all font-mono text-[11px] leading-relaxed text-gray-700 dark:text-gray-200">{{ target.host }}</span>
            </div>
            <div tw-class="flex shrink-0 items-center gap-1">
              <button
                type="button"
                :disabled="activeAction !== null"
                tw-class="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition-colors enabled:hover:bg-gray-100 enabled:hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-400 dark:enabled:hover:bg-gray-800 dark:enabled:hover:text-gray-200 motion-reduce:transition-none"
                :title="lazyStrings.DeveloperOpenStateLinks__copy_url_for_host({ host: target.host })"
                :aria-label="lazyStrings.DeveloperOpenStateLinks__copy_url_for_host({ host: target.host })"
                :data-testid="`copy-current-state-${target.host}`"
                @click="copyCurrentStateURL({ target })"
              >
                <Loader2Icon v-if="activeAction?.type === 'copy' && activeAction.host === target.host" aria-hidden="true" tw-class="h-4 w-4 animate-spin motion-reduce:animate-none" />
                <CopyIcon v-else aria-hidden="true" tw-class="h-4 w-4" />
              </button>
              <button
                type="button"
                :disabled="activeAction !== null"
                tw-class="inline-flex h-8 w-8 items-center justify-center rounded-lg text-blue-500 transition-colors enabled:hover:bg-blue-50 enabled:hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-50 dark:text-blue-400 dark:enabled:hover:bg-blue-500/10 dark:enabled:hover:text-blue-300 motion-reduce:transition-none"
                :title="lazyStrings.DeveloperOpenStateLinks__open_host({ host: target.host })"
                :aria-label="lazyStrings.DeveloperOpenStateLinks__open_host({ host: target.host })"
                :data-testid="`open-current-state-${target.host}`"
                @click="openCurrentState({ target })"
              >
                <Loader2Icon v-if="activeAction?.type === 'open' && activeAction.host === target.host" aria-hidden="true" tw-class="h-4 w-4 animate-spin motion-reduce:animate-none" />
                <ExternalLinkIcon v-else aria-hidden="true" tw-class="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>
