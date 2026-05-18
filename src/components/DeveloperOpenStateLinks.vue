<script setup lang="ts">
import { ref } from 'vue';
import { CopyIcon, ExternalLinkIcon, Loader2Icon } from 'lucide-vue-next';
import { urlImportExportLogic } from '@/services/import-export/url-logic';
import { useToast } from '@/composables/useToast';

const DEPLOYMENT_TARGETS = [
  { host: 'naidan.pages.dev', baseUrl: 'https://naidan.pages.dev' },
  { host: 'naidan-only-local.pages.dev', baseUrl: 'https://naidan-only-local.pages.dev' },
  { host: 'develop.naidan.pages.dev', baseUrl: 'https://develop.naidan.pages.dev' },
  { host: 'develop.naidan-only-local.pages.dev', baseUrl: 'https://develop.naidan-only-local.pages.dev' },
] as const;

const { addToast } = useToast();
const activeAction = ref<{ type: 'copy' | 'open'; host: string } | null>(null);
const excludeChats = ref(false);
const excludeAttachments = ref(false);

function buildExcludeList() {
  const exclude: Array<'chat' | 'binary_object'> = [];
  if (excludeChats.value) exclude.push('chat');
  if (excludeAttachments.value) exclude.push('binary_object');
  return exclude;
}

async function createCurrentStateURL({ target }: { target: typeof DEPLOYMENT_TARGETS[number] }) {
  return await urlImportExportLogic.getExportURL({
    exclude: buildExcludeList(),
    baseUrl: target.baseUrl,
  });
}

async function copyCurrentStateURL({ target }: { target: typeof DEPLOYMENT_TARGETS[number] }) {
  if (activeAction.value) return;

  activeAction.value = { type: 'copy', host: target.host };
  try {
    const url = await createCurrentStateURL({ target });
    await navigator.clipboard.writeText(url);
    addToast({ message: `Copied URL for ${target.host}`, duration: 3000 });
  } catch (err) {
    console.error('Failed to copy current state URL:', err);
    addToast({
      message: `Failed to copy current state URL: ${err instanceof Error ? err.message : String(err)}`,
      duration: 5000,
    });
  } finally {
    activeAction.value = null;
  }
}

async function openCurrentState({ target }: { target: typeof DEPLOYMENT_TARGETS[number] }) {
  if (activeAction.value) return;

  activeAction.value = { type: 'open', host: target.host };
  try {
    const url = await createCurrentStateURL({ target });
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (err) {
    console.error('Failed to open current state URL:', err);
    addToast({
      message: `Failed to open current state URL: ${err instanceof Error ? err.message : String(err)}`,
      duration: 5000,
    });
  } finally {
    activeAction.value = null;
  }
}

defineExpose({
  TEST_ONLY: {
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
      <h3 class="text-sm font-bold text-gray-500 uppercase tracking-widest ml-1">Open Current State</h3>
      <p class="mt-2 text-[11px] font-medium text-gray-400 ml-1 leading-relaxed">
        Open this storage state in another deployment using the same URL import format as Share via URL.
      </p>
    </div>

    <div class="flex flex-wrap gap-4">
      <label class="flex items-center gap-2 cursor-pointer group">
        <input
          v-model="excludeChats"
          type="checkbox"
          class="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 dark:bg-gray-700"
          data-testid="open-current-state-exclude-chats"
        />
        <span class="text-xs font-bold text-gray-600 dark:text-gray-400 group-hover:text-gray-800 dark:group-hover:text-gray-200 transition-colors">Exclude Chats</span>
      </label>
      <label class="flex items-center gap-2 cursor-pointer group">
        <input
          v-model="excludeAttachments"
          type="checkbox"
          class="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 dark:bg-gray-700"
          data-testid="open-current-state-exclude-attachments"
        />
        <span class="text-xs font-bold text-gray-600 dark:text-gray-400 group-hover:text-gray-800 dark:group-hover:text-gray-200 transition-colors">Exclude Attachments</span>
      </label>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div
        v-for="target in DEPLOYMENT_TARGETS"
        :key="target.host"
        class="min-w-0 flex items-center justify-between gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-2xl text-sm font-bold shadow-sm"
        :data-testid="`open-current-state-row-${target.host}`"
      >
        <span class="truncate">{{ target.host }}</span>
        <div class="flex items-center gap-1 shrink-0">
          <button
            type="button"
            :disabled="activeAction !== null"
            class="p-2 rounded-xl hover:bg-white dark:hover:bg-gray-700 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            :title="`Copy URL for ${target.host}`"
            :data-testid="`copy-current-state-${target.host}`"
            @click="copyCurrentStateURL({ target })"
          >
            <Loader2Icon v-if="activeAction?.type === 'copy' && activeAction.host === target.host" class="w-4 h-4 animate-spin" />
            <CopyIcon v-else class="w-4 h-4" />
          </button>
          <button
            type="button"
            :disabled="activeAction !== null"
            class="p-2 rounded-xl hover:bg-white dark:hover:bg-gray-700 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            :title="`Open ${target.host}`"
            :data-testid="`open-current-state-${target.host}`"
            @click="openCurrentState({ target })"
          >
            <Loader2Icon v-if="activeAction?.type === 'open' && activeAction.host === target.host" class="w-4 h-4 animate-spin" />
            <ExternalLinkIcon v-else class="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
