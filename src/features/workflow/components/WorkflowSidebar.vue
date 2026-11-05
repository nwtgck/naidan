<script setup lang="ts">
import { RouterLink, useRouter, useRoute } from 'vue-router';
import { HistoryIcon, WorkflowIcon, SquarePenIcon, ArrowLeftIcon, SettingsIcon, PackageIcon, RefreshCwIcon, PlusIcon } from 'lucide-vue-next';
import SidebarHeader from '@/components/SidebarHeader.vue';
import SidebarDebugControls from '@/components/SidebarDebugControls.vue';
import { useLayout } from '@/composables/useLayout';
import { useWorkflowWorkspace } from '@/features/workflow/composables/use-workflow-workspace';
import { idToRaw, type WorkflowId } from '@/01-models/ids';
import { workflowDocumentPath, workflowRunPath } from '@/features/workflow/logic/locations';
import { lazyStrings } from '@/strings';
const workspace = useWorkflowWorkspace();
const { isSidebarOpen, toggleSidebar } = useLayout();
const router = useRouter(), route = useRoute();

function dragPart({ event, id }: { event: DragEvent, id: WorkflowId }): void {
  if (!event.dataTransfer) {
    return;
  }
  event.dataTransfer.setData('application/x-naidan-workflow-part', idToRaw({ id }));
  event.dataTransfer.effectAllowed = 'copy';
}

async function createDocument({ kind }: { kind: 'workflow' | 'part' }): Promise<void> {
  const previous = workspace.definition.value;
  await workspace.create({ documentKind: kind });
  if (previous !== workspace.definition.value) {
    await router.push({ path: '/workflows', query: route.query });
  }
}

async function createSample(): Promise<void> {
  const previous = workspace.definition.value;
  await workspace.sample();
  if (previous !== workspace.definition.value) {
    await router.push({ path: '/workflows', query: route.query });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <nav tw-class="flex flex-col h-full bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100" :aria-label="lazyStrings.workflow__workflows()" data-testid="workflow-sidebar">
    <SidebarHeader :expanded="isSidebarOpen" @toggle="toggleSidebar" />
    <div :tw-class="['space-y-2 py-3', isSidebarOpen ? 'px-3' : 'px-1']">
      <button type="button" :disabled="workspace.busy.value" @click="createDocument({ kind: 'workflow' })" :title="lazyStrings.workflow__new_workflow()" tw-class="flex w-full items-center justify-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-2 py-2.5 text-xs font-medium hover:border-blue-400 disabled:opacity-40"><SquarePenIcon tw-class="h-4 w-4 text-blue-500" /><span v-if="isSidebarOpen">{{ lazyStrings.workflow__new_workflow() }}</span></button>
      <button v-if="isSidebarOpen" type="button" :disabled="workspace.busy.value" @click="createSample" tw-class="w-full text-left text-xs px-3 py-2 rounded-xl text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">{{ lazyStrings.workflow__new_sample() }}</button>
    </div>
    <div v-if="isSidebarOpen" tw-class="min-h-0 flex-1 overflow-y-auto px-2 pb-3 space-y-4">
      <div v-for="documentKind in (['workflow', 'part'] as const)" :key="documentKind">
        <div tw-class="flex items-center justify-between px-2 pb-2 text-xs font-semibold text-gray-500 dark:text-gray-400"><span>{{ documentKind === 'workflow' ? lazyStrings.workflow__workflows() : lazyStrings.workflow__parts() }}</span><button v-if="documentKind === 'part'" type="button" @click="createDocument({ kind: 'part' })" :disabled="workspace.busy.value" :aria-label="lazyStrings.workflow__new_part()" tw-class="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800"><PlusIcon tw-class="w-3 h-3" /></button></div>
        <div v-for="item in workspace.library.value.items.filter(item => item.kind === documentKind)" :key="idToRaw({ id: item.id })" :tw-class="['flex items-center rounded-xl border mb-1', route.path === workflowDocumentPath({ id: item.id }) ? 'border-gray-200 bg-gray-100 dark:bg-gray-800 dark:border-gray-700' : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50']">
          <button type="button" :draggable="documentKind === 'part'" @dragstart="dragPart({ event: $event, id: item.id })" :disabled="workspace.busy.value" @click="router.push({ path: workflowDocumentPath({ id: item.id }), query: route.query })" tw-class="min-w-0 flex-1 flex gap-2 items-center text-left rounded-xl p-2.5 focus-visible:ring-2 focus-visible:ring-blue-500">
            <WorkflowIcon v-if="documentKind === 'workflow'" tw-class="h-4 w-4 shrink-0 text-blue-500" /><PackageIcon v-else tw-class="h-4 w-4 shrink-0 text-gray-400" />
            <span tw-class="min-w-0"><span tw-class="block text-xs font-medium truncate">{{ item.name }}</span><span tw-class="block text-[10px] text-gray-400 mt-0.5">{{ new Date(item.updatedAt).toLocaleDateString() }}</span></span>
          </button>
          <button v-if="documentKind === 'part'" type="button" :disabled="workspace.navigationLocked.value" @click="workspace.insertPart({ id: item.id, target: { parentId: undefined, branch: 'root', index: workspace.definition.value.steps.length } })" :title="lazyStrings.workflow__insert_part()" :aria-label="lazyStrings.workflow__insert_part()" tw-class="p-2 rounded-lg text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-40"><PlusIcon tw-class="w-3.5 h-3.5" /></button>
        </div>
      </div>
      <p v-if="!workspace.library.value.items.length" tw-class="text-xs text-gray-400 px-2">{{ lazyStrings.workflow__no_documents() }}</p>
      <RouterLink to="/workflows/runs" tw-class="flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors" data-testid="workflow-history-link"><HistoryIcon tw-class="h-4 w-4" />{{ lazyStrings.workflow__run_history() }}</RouterLink>
      <RouterLink v-if="workspace.activeRunId.value" :to="workflowRunPath({ id: workspace.activeRunId.value })" tw-class="block rounded-xl px-3 py-2 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20">{{ lazyStrings.workflow__latest_run() }}</RouterLink>
      <p v-if="workspace.runState.value === 'running'" tw-class="rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-300 p-2 text-xs">{{ workspace.pending.value ? lazyStrings.workflow__waiting() : lazyStrings.workflow__running() }}</p>
    </div>
    <div v-else tw-class="flex-1 px-1">
      <RouterLink to="/workflows/runs" :title="lazyStrings.workflow__run_history()" :aria-label="lazyStrings.workflow__run_history()" tw-class="flex justify-center rounded-xl p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500"><HistoryIcon tw-class="w-4 h-4" /></RouterLink>
    </div>
    <div :tw-class="['border-t border-gray-100 dark:border-gray-800 space-y-1', isSidebarOpen ? 'p-3' : 'p-1']">
      <button type="button" :disabled="workspace.busy.value" @click="workspace.refresh" :title="lazyStrings.workflow__refresh()" tw-class="flex w-full gap-2 items-center p-2 rounded-xl text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"><RefreshCwIcon tw-class="w-4 h-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.workflow__refresh() }}</span></button>
      <RouterLink to="/" :title="lazyStrings.workflow__back_to_chats()" tw-class="flex items-center gap-2 rounded-xl p-2 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"><ArrowLeftIcon tw-class="w-4 h-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.workflow__back_to_chats() }}</span></RouterLink>
      <div :tw-class="['flex gap-2', !isSidebarOpen && 'flex-col items-center']"><button type="button" @click="router.push({ query: { ...route.query, settings: 'connection' } })" :title="lazyStrings.Sidebar__settings()" tw-class="flex items-center gap-2 rounded-xl p-2 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"><SettingsIcon tw-class="h-4 w-4" /><span v-if="isSidebarOpen">{{ lazyStrings.Sidebar__settings() }}</span></button><SidebarDebugControls :is-sidebar-open="isSidebarOpen" /></div>
    </div>
  </nav>
</template>
