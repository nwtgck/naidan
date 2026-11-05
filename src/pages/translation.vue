<script setup lang="ts">
import { computed } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import TranslationWorkspace from '@/features/translation/components/TranslationWorkspace.vue';
const route = useRoute(), router = useRouter();
const tab = computed(() => route.path.replace(/\/+$/, '') === '/translation/models' ? 'models' as const : 'workspace' as const);

function open({ path }: { path: '/translation' | '/translation/models' }): void {
  if (route.path.replace(/\/+$/, '') !== path) {
    void router.push({ path, query: route.query });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template><TranslationWorkspace :tab="tab" @open-workspace="open({ path: '/translation' })" @open-models="open({ path: '/translation/models' })" /><RouterView /></template>
