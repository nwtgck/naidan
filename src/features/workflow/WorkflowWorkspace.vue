<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { RouterView, useRoute, useRouter, onBeforeRouteUpdate } from 'vue-router';
import { ArrowLeftIcon, RefreshCwIcon } from 'lucide-vue-next';
import { createWorkflowDocumentStore } from '@/00-storage/service/workflow-document';
import { storageService } from '@/00-storage/service';
import { lazyStrings } from '@/strings';
import { useWorkflowWorkspace } from './composables/use-workflow-workspace';
import { workflowLocation, workflowDocumentPath } from './logic/locations';
import WorkflowView from './WorkflowView.vue';
import WorkflowRunHistory from './components/WorkflowRunHistory.vue';

const workspace = useWorkflowWorkspace();
const route = useRoute(), router = useRouter();
const location = computed(() => workflowLocation({ path: route.path }));
const loading = ref(false), loadError = ref('');
let request = 0;
let permittedPath: string | undefined;

onBeforeRouteUpdate(async to => {
  const target = workflowLocation({ path: to.path });
  if (target.type === 'editor' && target.id !== undefined && target.id !== workspace.saved.value?.document.id) {
    if (workspace.busy.value || !await workspace.confirmDiscard()) {
      return false;
    }
    permittedPath = to.path;
    return true;
  }
  return true;
});

async function loadLocation(): Promise<void> {
  const token = ++request;
  const target = location.value;
  loadError.value = '';
  loading.value = false;
  switch (target.type) {
  case 'other':
    loadError.value = 'Invalid Workflow location.';
    return;
  case 'history': return;
  case 'editor':
    if (target.id === undefined || workspace.saved.value?.document.id === target.id) {
      return;
    }
    break;
  default: {
    const exhaustive: never = target;
    throw new Error(String(exhaustive));
  }
  }
  loading.value = true;
  try {
    if (permittedPath !== route.path && !await workspace.confirmDiscard()) {
      if (request === token) {
        const id = workspace.saved.value?.document.id;
        await router.replace({ path: id ? workflowDocumentPath({ id }) : '/workflows', query: route.query });
      }
      return;
    }
    permittedPath = undefined;
    if (request !== token) {
      return;
    }
    const snapshot = await createWorkflowDocumentStore({ storageType: storageService.getCurrentType() }).load({ id: target.id });
    // A slow deep-link load must not replace a later route or a newly selected document.
    if (request === token) {
      workspace.adoptDocument({ snapshot });
    }
  } catch (reason) {
    if (request === token) {
      loadError.value = reason instanceof Error ? reason.message : String(reason);
    }
  } finally {
    if (request === token) {
      loading.value = false;
    }
  }
}

watch(() => route.path, () => {
  void loadLocation().then(() => workspace.refresh());
}, { immediate: true });
watch(() => [route.path, workspace.saved.value?.document.id] as const, ([_path, id]) => {
  // Save/copy/delete updates the location. History links and failed explicit
  // deep links must never be redirected to whichever draft is still in memory.
  if (loading.value || loadError.value || location.value.type !== 'editor') {
    return;
  }
  const path = id === undefined ? '/workflows' : workflowDocumentPath({ id });
  if (route.path !== path) {
    void router.replace({ path, query: route.query });
  }
});
onBeforeUnmount(() => {
  request++;
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="flex flex-col flex-1 min-w-0 min-h-0 h-full">
    <section v-if="loading || loadError" tw-class="flex-1 flex flex-col items-center justify-center gap-4 p-8 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200" aria-live="polite">
      <RefreshCwIcon v-if="loading" tw-class="w-5 h-5 text-blue-500 motion-safe:animate-spin" />
      <p v-if="loading">{{ lazyStrings.workflow__loading() }}</p>
      <p v-else role="alert" tw-class="max-w-xl text-sm break-words">{{ loadError }}</p>
      <button v-if="loadError" type="button" @click="loadLocation" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.workflow__refresh() }}</button>
      <button type="button" @click="router.push('/workflows')" tw-class="inline-flex gap-2 items-center rounded-xl px-3 py-2 text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"><ArrowLeftIcon tw-class="w-4 h-4" />{{ lazyStrings.workflow__back_to_editor() }}</button>
    </section>
    <!-- Keep drafts and selection mounted when viewing history; only the view changes. -->
    <WorkflowView :refresh-on-mount="false" v-show="location.type === 'editor' && !loading && !loadError" />
    <WorkflowRunHistory v-if="location.type === 'history'" :run-id="location.id" />
    <RouterView />
  </div>
</template>
