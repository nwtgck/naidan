<script setup lang="ts">
import { ref } from 'vue';
import { CopyIcon, ExternalLinkIcon, Loader2Icon } from 'lucide-vue-next';
import { urlImportExportLogic } from '@/services/import-export/url-logic';
import { useToast } from '@/composables/useToast';
import { useExportExclusions } from '@/composables/useExportExclusions';
import { lazyStrings, ensureStrings } from '@/strings';

type DeploymentTarget = {
  readonly kind: 'Standard' | 'Local only' | 'Curated',
  readonly host: string,
  readonly baseUrl: string,
};

type DeploymentGroup = {
  readonly id: 'production' | 'develop',
  readonly label: 'Production' | 'develop branch',
  readonly dotClass: string,
  readonly targets: readonly DeploymentTarget[],
};

const DEPLOYMENT_GROUPS = [
  {
    id: 'production',
    label: 'Production',
    dotClass: 'bg-emerald-600/60 dark:bg-emerald-400/60',
    targets: [
      { kind: 'Standard', host: 'naidan.pages.dev', baseUrl: 'https://naidan.pages.dev' },
      { kind: 'Local only', host: 'naidan-only-local.pages.dev', baseUrl: 'https://naidan-only-local.pages.dev' },
      { kind: 'Curated', host: 'naidan-curated.pages.dev', baseUrl: 'https://naidan-curated.pages.dev' },
    ],
  },
  {
    id: 'develop',
    label: 'develop branch',
    dotClass: 'bg-violet-500/50 dark:bg-violet-300/60',
    targets: [
      { kind: 'Standard', host: 'develop.naidan.pages.dev', baseUrl: 'https://develop.naidan.pages.dev' },
      { kind: 'Local only', host: 'develop.naidan-only-local.pages.dev', baseUrl: 'https://develop.naidan-only-local.pages.dev' },
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
  if (activeAction.value) return;

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
  if (activeAction.value) return;

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
  TEST_ONLY: {
    DEPLOYMENT_GROUPS,
    DEPLOYMENT_TARGETS,
    buildExcludeList,
    copyCurrentStateURL,
    openCurrentState,
  },
});
</script>

<template>
  <div class="space-y-4" data-testid="developer-open-state-links">
    <div>
      <h3 class="ml-1 text-sm font-bold uppercase tracking-widest text-gray-500">{{ lazyStrings.DeveloperOpenStateLinks__open_current_state() }}</h3>
      <p class="ml-1 mt-2 text-[11px] font-medium leading-relaxed text-gray-400">
        {{ lazyStrings.DeveloperOpenStateLinks__open_state_description() }}
      </p>
    </div>

    <div class="overflow-hidden rounded-2xl border border-gray-200/80 bg-white/60 shadow-sm dark:border-gray-800 dark:bg-gray-900/30">
      <div class="flex flex-col gap-3 border-b border-gray-200/80 bg-gray-50/70 px-4 py-3 dark:border-gray-800 dark:bg-gray-900/30 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <h4 class="text-xs font-bold text-gray-800 dark:text-gray-200">{{ lazyStrings.DeveloperOpenStateLinks__state_contents() }}</h4>
          <p class="mt-0.5 text-[10px] font-medium leading-relaxed text-gray-500 dark:text-gray-400">
            {{ lazyStrings.DeveloperOpenStateLinks__choose_data_to_omit() }}
          </p>
        </div>

        <fieldset class="flex shrink-0 flex-wrap gap-1.5">
          <legend class="sr-only">{{ lazyStrings.DeveloperOpenStateLinks__excluded_data() }}</legend>
          <label class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 text-[10px] font-bold text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-200">
            <input
              v-model="excludeChats"
              type="checkbox"
              class="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
              data-testid="open-current-state-exclude-chats"
            />
            {{ lazyStrings.DeveloperOpenStateLinks__exclude_chats() }}
          </label>
          <label
            class="flex h-7 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 text-[10px] font-bold text-gray-600 transition-colors dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400"
            :class="excludeChatHistoryDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-gray-300 hover:text-gray-800 dark:hover:border-gray-600 dark:hover:text-gray-200'"
          >
            <input
              v-model="excludeChatHistory"
              :disabled="excludeChatHistoryDisabled"
              type="checkbox"
              class="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:cursor-not-allowed dark:border-gray-600 dark:bg-gray-700"
              data-testid="open-current-state-exclude-chat-history"
            />
            {{ lazyStrings.DeveloperOpenStateLinks__exclude_chat_history() }}
          </label>
          <label class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 text-[10px] font-bold text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-200">
            <input
              v-model="excludeAttachments"
              type="checkbox"
              class="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
              data-testid="open-current-state-exclude-attachments"
            />
            {{ lazyStrings.DeveloperOpenStateLinks__exclude_attachments() }}
          </label>
        </fieldset>
      </div>

      <div class="grid grid-cols-1 divide-y divide-gray-200/80 dark:divide-gray-800 sm:grid-cols-2 sm:divide-x sm:divide-y-0" data-testid="open-current-state-groups">
        <section
          v-for="group in DEPLOYMENT_GROUPS"
          :key="group.id"
          class="min-w-0 p-3.5"
          :data-testid="`open-current-state-group-${group.id}`"
        >
          <h4 class="mb-2 flex items-center gap-1.5 text-xs font-bold text-gray-800 dark:text-gray-200">
            <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="group.dotClass" aria-hidden="true"></span>
            {{ deploymentGroupLabel({ label: group.label }) }}
          </h4>

          <div class="space-y-1.5">
            <div
              v-for="target in group.targets"
              :key="target.host"
              class="flex min-h-12 min-w-0 items-center justify-between gap-2 rounded-xl border border-gray-200/80 bg-gray-50/70 py-1.5 pl-2.5 pr-1.5 transition-colors hover:border-gray-300 hover:bg-gray-100/70 dark:border-gray-800 dark:bg-gray-900/40 dark:hover:border-gray-700 dark:hover:bg-gray-800/70"
              :data-testid="`open-current-state-row-${target.host}`"
            >
              <div class="min-w-0">
                <span class="block text-[8px] font-extrabold uppercase leading-tight tracking-wider text-gray-400 dark:text-gray-500">
                  {{ deploymentTargetKindLabel({ kind: target.kind }) }}
                </span>
                <span class="mt-0.5 block truncate font-mono text-[10px] font-semibold leading-snug text-gray-700 dark:text-gray-300">
                  {{ target.host }}
                </span>
              </div>

              <div class="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  :disabled="activeAction !== null"
                  class="inline-flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                  :title="lazyStrings.DeveloperOpenStateLinks__copy_url_for_host({ host: target.host })"
                  :data-testid="`copy-current-state-${target.host}`"
                  @click="copyCurrentStateURL({ target })"
                >
                  <Loader2Icon v-if="activeAction?.type === 'copy' && activeAction.host === target.host" class="h-3.5 w-3.5 animate-spin" />
                  <CopyIcon v-else class="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  :disabled="activeAction !== null"
                  class="inline-flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                  :title="lazyStrings.DeveloperOpenStateLinks__open_host({ host: target.host })"
                  :data-testid="`open-current-state-${target.host}`"
                  @click="openCurrentState({ target })"
                >
                  <Loader2Icon v-if="activeAction?.type === 'open' && activeAction.host === target.host" class="h-3.5 w-3.5 animate-spin" />
                  <ExternalLinkIcon v-else class="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
