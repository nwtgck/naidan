<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ImageGenerationLab from '@/features/stable-diffusion-cpp-browser/components/ImageGenerationLab.vue';

// All workspace URLs share one owner so navigation preserves models, running work and results.
const route = useRoute(), router = useRouter();
const tab = computed<'generate' | 'models' | 'history' | 'measure'>({
  get() {
    switch (route.path.replace(/\/+$/, '')) {
    case '/image-generation-lab/models': return 'models';
    case '/image-generation-lab/history': return 'history';
    case '/image-generation-lab/diagnostics': return 'measure';
    default: return 'generate';
    }
  },
  set(value) {
    if (value === tab.value) return;
    // Aliases share a route record; force navigation so its different URL is not
    // discarded as a duplicate while the component instance stays mounted.
    switch (value) {
    case 'generate': void router.push({ path: '/image-generation-lab', force: true }); break;
    case 'models': void router.push({ path: '/image-generation-lab/models', force: true }); break;
    case 'history': void router.push({ path: '/image-generation-lab/history', force: true }); break;
    case 'measure': void router.push({ path: '/image-generation-lab/diagnostics', force: true }); break;
    default: { const exhaustive: never = value; throw new Error(String(exhaustive)); }
    }
  },
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<route lang="json">
{ "alias": ["/image-generation-lab/diagnostics", "/image-generation-lab/models", "/image-generation-lab/history"] }
</route>
<template><ImageGenerationLab v-model:tab="tab" /></template>
