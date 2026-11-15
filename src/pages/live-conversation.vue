<script setup lang="ts">
import { computed } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import LiveConversationView from '@/features/live-conversation/components/LiveConversationView.vue';
const route = useRoute(), router = useRouter();
const panel = computed(() => route.path.replace(/\/+$/, '') === '/live-conversation/diagnostics' ? 'diagnostics' as const : 'conversation' as const);

function open({ path }: { path: '/live-conversation' | '/live-conversation/diagnostics' }): void {
  if (route.path.replace(/\/+$/, '') !== path) {
    void router.push({ path, query: route.query, hash: route.hash });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <LiveConversationView :panel="panel" @open-conversation="open({ path: '/live-conversation' })" @open-diagnostics="open({ path: '/live-conversation/diagnostics' })" /><RouterView />
</template>
