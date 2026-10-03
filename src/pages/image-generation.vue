<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ImageGenerationLab from '@/features/stable-diffusion-cpp-browser/components/ImageGenerationLab.vue';

// All workspace URLs share one owner so navigation preserves models, running work and results.
const route = useRoute(), router = useRouter();
const tab = computed<'generate' | 'models' | 'history' | 'measure'>({
  get() {
    switch (route.path.replace(/\/+$/, '')) {
    case '/image-generation/models': return 'models';
    case '/image-generation/diagnostics': return 'measure';
    default: return 'generate';
    }
  },
  set(value) {
    if (value === tab.value) return;
    // Aliases share a route record; force navigation so its different URL is not
    // discarded as a duplicate while the component instance stays mounted.
    switch (value) {
    case 'generate': void router.push({ path: '/image-generation', query: route.query, force: true }); break;
    case 'models': void router.push({ path: '/image-generation/models', query: route.query, force: true }); break;
    case 'history': break; // The experimental Workspace has no legacy-history surface.
    case 'measure': void router.push({ path: '/image-generation/diagnostics', query: route.query, force: true }); break;
    default: { const exhaustive: never = value; throw new Error(String(exhaustive)); }
    }
  },
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<route lang="json">
{ "alias": ["/image-generation/diagnostics", "/image-generation/models"] }
</route>
<template><ImageGenerationLab v-model:tab="tab" workspace /></template>
