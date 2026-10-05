<script setup lang="ts">
import { computed, watch } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import { idToRaw, toImageGenerationSessionId } from '@/01-models/ids';
import { useImageGenerationWorkspaceNavigation } from '@/features/image-generation/session/navigation';
import ImageGenerationLab from '@/features/image-generation/components/ImageGenerationLab.vue';

// Nested locations share this parent: models and running work never remount.
const route = useRoute(), router = useRouter();
const { active: navigation } = useImageGenerationWorkspaceNavigation();
const sessionId = computed(() => {
  const params = route.params;
  const raw = 'sessionId' in params ? params.sessionId : undefined;
  return typeof raw === 'string' ? toImageGenerationSessionId({ raw }) : undefined;
});
const tab = computed<'generate' | 'models' | 'history' | 'measure'>({
  get() {
    switch (route.path.replace(/\/+$/, '')) {
    case '/image-generation/models': return 'models';
    case '/image-generation/diagnostics': return 'measure';
    default: return 'generate';
    }
  },
  set(value) {
    let path: string;
    switch (value) {
    case 'generate': {
      const selected = navigation.value?.view?.selectedSessionId.value;
      path = selected ? `/image-generation/session/${idToRaw({ id: selected })}` : '/image-generation'; break;
    }
    case 'models': path = '/image-generation/models'; break;
    case 'history': return;
    case 'measure': path = '/image-generation/diagnostics'; break;
    default: { const exhaustive: never = value; throw new Error(String(exhaustive)); }
    }
    if (path !== route.path.replace(/\/+$/, '')) void router.push({ path, query: route.query });
  },
});
watch(() => [route.path, navigation.value?.view?.currentSession.value?.id] as const, ([path, selected]) => {
  // Initial/default selection and the first Generate receive a shareable URL.
  // Explicit session URLs, including missing IDs, are never redirected elsewhere.
  if (path.replace(/\/+$/, '') === '/image-generation' && selected) {
    void router.replace({ path: `/image-generation/session/${idToRaw({ id: selected })}`, query: route.query });
  }
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template><ImageGenerationLab v-model:tab="tab" :session-id="sessionId" @open-generation="tab = 'generate'" workspace /><RouterView /></template>
