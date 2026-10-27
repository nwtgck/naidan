<script setup lang="ts">
import { computed, onScopeDispose, ref, useId, useTemplateRef, watch } from 'vue';
import { CheckIcon, ChevronDownIcon, CopyIcon, ExternalLinkIcon, LinkIcon, Loader2Icon, UploadIcon } from 'lucide-vue-next';
import ActionButton from '@/components/ActionButton.vue';
import SettingsChoiceControl from '@/components/SettingsChoiceControl.vue';
import SettingsCollapse from '@/components/SettingsCollapse.vue';
import { useExportExclusions } from '@/features/import-export/composables/useExportExclusions';
import { useImportExportModal } from '@/features/import-export/composables/useImportExportModal';
import type { CspHintMessage } from '@/logic/csp-message-hints/types';
import { lazyStrings } from '@/strings';

type Deployment = CspHintMessage['suggestedDeployments'][number]['id'];
const props = defineProps<{ deployments: CspHintMessage['suggestedDeployments'] }>();
const { request: exportRequest, open: openImportExportModal } = useImportExportModal();
const ownExportRequestId = ref<number | undefined>(undefined);
const exportLoading = computed(() => exportRequest.value?.id === ownExportRequestId.value && exportRequest.value?.status === 'loading');
const exportLoadFailed = computed(() => exportRequest.value?.id === ownExportRequestId.value && exportRequest.value?.status === 'failed');
const { excludeChats, excludeChatHistory, excludeAttachments, excludeChatHistoryDisabled, buildExcludeList } = useExportExclusions();
const preparedUrls = ref<Record<Deployment, string | undefined>>({ standard: undefined, curated: undefined });
const copyStates = ref<Record<Deployment, 'idle' | 'copying' | 'copied' | 'failed'>>({ standard: 'idle', curated: 'idle' });
const activeAction = ref<{ deployment: Deployment, token: number }>();
const failure = ref(false);
const transferOpen = ref(true);
const transferId = useId();
const transferTrigger = useTemplateRef<HTMLButtonElement>('transfer-trigger');
const urlTransferOpen = ref(true);
const urlTransferId = useId();
const urlTransferTrigger = useTemplateRef<HTMLButtonElement>('url-transfer-trigger');
let revision = 0;
let disposed = false;

const copy = computed(() => {
  try {
    const messages = {
      connectionHelp: lazyStrings.CspDeploymentGuidance__how_to_ease_connection_restrictions(),
      tryOtherEditions: lazyStrings.CspDeploymentGuidance__try_other_public_editions(),
      policyBasis: lazyStrings.CspDeploymentGuidance__based_on_the_public_editions_connection_policies(),
      transfer: lazyStrings.CspDeploymentGuidance__take_your_data_with_you(),
      export: lazyStrings.CspDeploymentGuidance__export_data(),
      openingExport: lazyStrings.CspDeploymentGuidance__opening_export(),
      exportFailure: lazyStrings.CspDeploymentGuidance__could_not_open_export_use_storage_settings(),
      separateData: lazyStrings.CspDeploymentGuidance__each_site_keeps_its_own_data(),
      importInstructions: lazyStrings.CspDeploymentGuidance__import_your_exported_file_on_the_other_site(),
      openImportExport: lazyStrings.CspDeploymentGuidance__open_settings_storage_import_export(),
      selectExportedFile: lazyStrings.CspDeploymentGuidance__choose_import_and_select_your_exported_file(),
      savedDevelopmentCsp: lazyStrings.CspDeploymentGuidance__saved_development_csp_may_be_reapplied_after_restoring_settings(),
      smallState: lazyStrings.CspDeploymentGuidance__share_small_states_with_a_url(),
      urlTransfer: lazyStrings.CspDeploymentGuidance__use_a_transfer_url_for_small_data(),
      includedData: lazyStrings.CspDeploymentGuidance__url_includes_selected_data_and_connection_settings(),
      excludedData: lazyStrings.CspDeploymentGuidance__data_to_exclude(),
      excludeChats: lazyStrings.CspDeploymentGuidance__exclude_chats(),
      excludeHistory: lazyStrings.CspDeploymentGuidance__exclude_chat_history(),
      excludeAttachments: lazyStrings.CspDeploymentGuidance__exclude_attachments(),
      create: lazyStrings.CspDeploymentGuidance__create_transfer_url(),
      creating: lazyStrings.CspDeploymentGuidance__creating_transfer_url(),
      open: lazyStrings.CspDeploymentGuidance__open_with_selected_data(),
      copyUrl: lazyStrings.CspDeploymentGuidance__copy_url(),
      copied: lazyStrings.CspDeploymentGuidance__copied(),
      copyFailure: lazyStrings.CspDeploymentGuidance__could_not_copy_url(),
      failure: lazyStrings.CspDeploymentGuidance__could_not_create_url_use_storage_settings(),
    };
    if (Object.values(messages).some(message => message === undefined)) {
      return undefined;
    }
    return messages;
  } catch {
    return undefined;
  }
});

const targets = computed(() => {
  if (copy.value === undefined) {
    return [];
  }
  const result: { id: Deployment, baseUrl: string, displayUrl: string }[] = [];
  for (const target of [
    { id: 'standard' as const, baseUrl: 'https://naidan.pages.dev/' },
    { id: 'curated' as const, baseUrl: 'https://naidan-curated.pages.dev/' },
  ]) {
    try {
      const deployment = props.deployments.find(candidate => candidate.id === target.id);
      if (deployment === undefined) {
        continue;
      }
      const { id: _id, ...rest } = deployment;
      rest satisfies Record<PropertyKey, never>;
      result.push({ ...target, displayUrl: target.baseUrl.replace(/\/$/u, '') });
    } catch {
      // A broken candidate must not remove other independently known links.
    }
  }
  return result;
});

function toggleTransfer(): void {
  transferOpen.value = !transferOpen.value;
}

function openExport(): void {
  ownExportRequestId.value = openImportExportModal({ initialMode: 'export' });
}

function toggleUrlTransfer(): void {
  urlTransferOpen.value = !urlTransferOpen.value;
}

function resetCopyStates(): void {
  copyStates.value = { standard: 'idle', curated: 'idle' };
}

watch([excludeChats, excludeChatHistory, excludeAttachments, () => props.deployments], () => {
  revision++;
  preparedUrls.value = { standard: undefined, curated: undefined };
  resetCopyStates();
  failure.value = false;
}, { flush: 'sync' });

async function createTransferUrl({ deployment }: { deployment: Deployment }): Promise<void> {
  if (disposed || activeAction.value !== undefined) {
    return;
  }
  const target = targets.value.find(candidate => candidate.id === deployment);
  if (target === undefined) {
    return;
  }
  const token = ++revision;
  resetCopyStates();
  activeAction.value = { deployment, token };
  failure.value = false;
  preparedUrls.value = { ...preparedUrls.value, [deployment]: undefined };
  try {
    const exclude = buildExcludeList();
    // Creating a link is an explicit data export, never a hint-render side effect.
    const { urlImportExportLogic } = await import('@/features/import-export/url-logic');
    if (disposed || token !== revision) {
      return;
    }
    const url = await urlImportExportLogic.getExportURL({ exclude, baseUrl: target.baseUrl });
    if (!disposed && token === revision) {
      preparedUrls.value = { ...preparedUrls.value, [deployment]: url };
    }
  } catch {
    if (!disposed && token === revision) {
      failure.value = true;
    }
  } finally {
    if (activeAction.value?.token === token) {
      activeAction.value = undefined;
    }
  }
}

async function copyTransferUrl({ deployment }: { deployment: Deployment }): Promise<void> {
  const url = preparedUrls.value[deployment];
  if (disposed || url === undefined || copyStates.value[deployment] === 'copying') {
    return;
  }
  const token = revision;
  const isCurrent = () => !disposed && token === revision && preparedUrls.value[deployment] === url;
  copyStates.value = { ...copyStates.value, [deployment]: 'copying' };
  try {
    await navigator.clipboard.writeText(url);
    if (isCurrent()) {
      copyStates.value = { ...copyStates.value, [deployment]: 'copied' };
    }
  } catch {
    if (isCurrent()) {
      copyStates.value = { ...copyStates.value, [deployment]: 'failed' };
    }
  }
}

onScopeDispose(() => {
  disposed = true;
  revision++;
});

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <!-- Keep guidance opaque when a hint is embedded inside a colored error panel. -->
  <section v-if="copy !== undefined && targets.length !== 0" data-testid="csp-deployment-guidance" tw-class="space-y-3 rounded-lg border border-gray-200 bg-white p-3 text-xs leading-relaxed text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
    <h4 tw-class="border-b border-gray-200/70 pb-2 text-sm font-semibold leading-5 text-gray-800 dark:border-gray-700/70 dark:text-gray-100">{{ copy.connectionHelp }}</h4>
    <div tw-class="space-y-2">
      <p tw-class="text-xs font-medium text-gray-800 dark:text-gray-100">{{ copy.tryOtherEditions }}</p>
      <p tw-class="text-gray-500 dark:text-gray-400">{{ copy.policyBasis }}</p>
      <ul tw-class="list-disc space-y-1 pl-4">
        <li v-for="target in targets" :key="target.id" tw-class="min-w-0 max-w-full">
          <a :href="target.baseUrl" target="_blank" rel="noopener noreferrer" :data-testid="`csp-deployment-${target.id}`" tw-class="inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-sm py-0.5 text-xs font-medium text-blue-600 underline underline-offset-2 transition-colors hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:text-blue-400 dark:hover:text-blue-300">
            <span tw-class="min-w-0 break-all">{{ target.displayUrl }}</span><ExternalLinkIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />
          </a>
        </li>
      </ul>
    </div>
    <div data-testid="csp-data-transfer" tw-class="border-t border-gray-200/70 pt-1 dark:border-gray-700/60">
      <button ref="transfer-trigger" type="button" :aria-expanded="transferOpen" :aria-controls="transferId" data-testid="csp-transfer-toggle" tw-class="flex min-h-9 w-full items-center justify-between gap-2 rounded-md text-left text-sm font-semibold leading-5 text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:text-gray-100" @click="toggleTransfer"><span>{{ copy.transfer }}</span><ChevronDownIcon aria-hidden="true" :tw-class="['h-4 w-4 shrink-0 text-gray-400 transition-transform duration-150 motion-reduce:transition-none', transferOpen ? 'rotate-180' : '']" /></button>
      <SettingsCollapse :id="transferId" :open="transferOpen" :return-focus="transferTrigger ?? undefined">
        <div tw-class="mt-3 space-y-3 border-t border-gray-200/70 pt-3 dark:border-gray-700/60">
          <ActionButton appearance="primary" icon-tone="blue" :disabled="exportLoading || activeAction !== undefined" :aria-busy="exportLoading" data-testid="csp-transfer-export" @click="openExport">
            <Loader2Icon v-if="exportLoading" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 animate-spin" /><UploadIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />{{ exportLoading ? copy.openingExport : copy.export }}
          </ActionButton>
          <p v-if="exportLoadFailed" role="alert" data-testid="csp-transfer-export-error">{{ copy.exportFailure }}</p>
          <div data-testid="csp-transfer-import-instructions" tw-class="space-y-2">
            <p>{{ copy.separateData }}</p>
            <p>{{ copy.importInstructions }}</p>
            <ul tw-class="list-disc space-y-1 pl-4">
              <li>{{ copy.openImportExport }}</li>
              <li>{{ copy.selectExportedFile }}</li>
            </ul>
          </div>
          <p data-testid="csp-transfer-saved-development-csp" tw-class="text-gray-500 dark:text-gray-400">{{ copy.savedDevelopmentCsp }}</p>
          <div tw-class="border-t border-gray-200/70 pt-3 dark:border-gray-700/60">
            <button ref="url-transfer-trigger" type="button" :aria-expanded="urlTransferOpen" :aria-controls="urlTransferId" data-testid="csp-url-transfer-toggle" tw-class="flex min-h-9 w-full items-center justify-between gap-2 rounded-md text-left text-sm font-semibold leading-5 text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:text-gray-100" @click="toggleUrlTransfer"><span>{{ copy.urlTransfer }}</span><ChevronDownIcon aria-hidden="true" :tw-class="['h-4 w-4 shrink-0 text-gray-400 transition-transform duration-150 motion-reduce:transition-none', urlTransferOpen ? 'rotate-180' : '']" /></button>
            <SettingsCollapse :id="urlTransferId" :open="urlTransferOpen" :return-focus="urlTransferTrigger ?? undefined">
              <div tw-class="mt-3 space-y-3">
                <p>{{ copy.smallState }}</p>
                <p tw-class="text-gray-500 dark:text-gray-400">{{ copy.includedData }}</p>
                <fieldset :disabled="activeAction !== undefined" tw-class="space-y-2">
                  <legend tw-class="mb-1 text-xs font-medium text-gray-700 dark:text-gray-200">{{ copy.excludedData }}</legend>
                  <div tw-class="flex flex-wrap gap-x-4 gap-y-2">
                    <label tw-class="inline-flex items-center gap-1.5"><SettingsChoiceControl presentation="checkbox"><input v-model="excludeChats" type="checkbox" data-testid="csp-transfer-exclude-chats" /></SettingsChoiceControl>{{ copy.excludeChats }}</label>
                    <label :tw-class="['inline-flex items-center gap-1.5', excludeChatHistoryDisabled ? 'opacity-50' : '']"><SettingsChoiceControl presentation="checkbox"><input v-model="excludeChatHistory" :disabled="excludeChatHistoryDisabled" type="checkbox" data-testid="csp-transfer-exclude-history" /></SettingsChoiceControl>{{ copy.excludeHistory }}</label>
                    <label tw-class="inline-flex items-center gap-1.5"><SettingsChoiceControl presentation="checkbox"><input v-model="excludeAttachments" type="checkbox" data-testid="csp-transfer-exclude-attachments" /></SettingsChoiceControl>{{ copy.excludeAttachments }}</label>
                  </div>
                </fieldset>
                <div tw-class="space-y-2">
                  <div v-for="target in targets" :key="target.id" tw-class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200/70 px-2.5 py-2 dark:border-gray-700/60">
                    <span :data-testid="`csp-transfer-destination-${target.id}`" tw-class="min-w-0 break-all text-xs font-medium text-gray-700 dark:text-gray-200">{{ target.displayUrl }}</span>
                    <div v-if="preparedUrls[target.id] !== undefined" tw-class="flex flex-wrap items-center gap-2">
                      <a :href="preparedUrls[target.id]" target="_blank" rel="noopener noreferrer" :data-testid="`csp-transfer-open-${target.id}`" tw-class="inline-flex min-h-8 items-center gap-1.5 rounded text-xs font-medium text-blue-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:text-blue-400">{{ copy.open }}<ExternalLinkIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" /></a>
                      <ActionButton appearance="primary" icon-tone="blue" :disabled="copyStates[target.id] === 'copying'" :aria-busy="copyStates[target.id] === 'copying'" :data-testid="`csp-transfer-copy-${target.id}`" @click="copyTransferUrl({ deployment: target.id })">
                        <Loader2Icon v-if="copyStates[target.id] === 'copying'" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 animate-spin" /><CheckIcon v-else-if="copyStates[target.id] === 'copied'" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" /><CopyIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />{{ copyStates[target.id] === 'copied' ? copy.copied : copy.copyUrl }}
                      </ActionButton>
                    </div>
                    <ActionButton v-else appearance="primary" icon-tone="blue" :disabled="activeAction !== undefined" :aria-busy="activeAction?.deployment === target.id" :data-testid="`csp-transfer-create-${target.id}`" @click="createTransferUrl({ deployment: target.id })">
                      <Loader2Icon v-if="activeAction?.deployment === target.id" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 animate-spin" /><LinkIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />{{ activeAction?.deployment === target.id ? copy.creating : copy.create }}
                    </ActionButton>
                    <p v-if="copyStates[target.id] === 'failed'" role="status" :data-testid="`csp-transfer-copy-error-${target.id}`" tw-class="w-full text-xs text-gray-600 dark:text-gray-300">{{ copy.copyFailure }}</p>
                  </div>
                </div>
                <p v-if="failure" role="alert" data-testid="csp-transfer-error" tw-class="text-xs text-gray-600 dark:text-gray-300">{{ copy.failure }}</p>
              </div>
            </SettingsCollapse>
          </div>
        </div>
      </SettingsCollapse>
    </div>
  </section>
</template>
