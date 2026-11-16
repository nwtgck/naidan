<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import LiveConversationView from '@/features/live-conversation/components/LiveConversationView.vue';
import type { LiveInvestigationTask } from '@/features/live-conversation/navigation';
// TODO: Revisit where standalone audio tools such as transcription belong;
// they currently live under live conversation but do not require a live session.
const route = useRoute(), router = useRouter();
const path = computed(() => route.path.replace(/\/+$/, ''));
const panel = computed(() => path.value === '/live-conversation/diagnostics' || path.value.startsWith('/live-conversation/diagnostics/') ? 'diagnostics' as const : 'conversation' as const);
const task = computed<LiveInvestigationTask>(() => path.value === '/live-conversation/diagnostics/transcription' ? 'transcription' : 'response');
const lastTask = ref<LiveInvestigationTask>('response');
watch([panel, task], ([location, value]) => {
  switch (location) {
  case 'diagnostics': lastTask.value = value;
    break;
  case 'conversation': break;
  default: {
    const exhaustive: never = location;
    throw new Error(String(exhaustive));
  }
  }
}, { immediate: true });

function open({ path }: { path: '/live-conversation' | '/live-conversation/diagnostics' | '/live-conversation/diagnostics/transcription' }): void {
  if (route.path.replace(/\/+$/, '') !== path) {
    void router.push({ path, query: route.query, hash: route.hash });
  }
}

function openTask({ task }: { task: LiveInvestigationTask }): void {
  switch (task) {
  case 'response': open({ path: '/live-conversation/diagnostics' });
    break;
  case 'transcription': open({ path: '/live-conversation/diagnostics/transcription' });
    break;
  default: {
    const exhaustive: never = task;
    throw new Error(String(exhaustive));
  }
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <LiveConversationView :panel="panel" :task="task" @open-conversation="open({ path: '/live-conversation' })" @open-diagnostics="openTask({ task: lastTask })" @investigation-task="openTask({ task: $event })" /><RouterView />
</template>
