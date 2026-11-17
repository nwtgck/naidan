<script setup lang="ts">
import { computed } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import AudioTranscriptionWorkspace from '@/features/audio-transcription/components/AudioTranscriptionWorkspace.vue';

const route = useRoute(), router = useRouter();
const source = computed(() => route.path.replace(/\/+$/, '') === '/audio-transcription/files' ? 'file' as const : 'microphone' as const);

function changeSource({ source }: { source: 'microphone' | 'file' }): void {
  const path = (() => {
    switch (source) {
    case 'file': return '/audio-transcription/files';
    case 'microphone': return '/audio-transcription';
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
    }
  })();
  void router.push({ path, query: route.query });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <AudioTranscriptionWorkspace :source="source" @change-source="changeSource({ source: $event })" />
  <RouterView />
</template>
