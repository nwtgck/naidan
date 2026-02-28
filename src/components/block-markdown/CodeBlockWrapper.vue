<script setup lang="ts">
import { computed } from 'vue';
import { IMAGE_BLOCK_LANG } from '../../utils/image-generation';
import MermaidBlock from './MermaidBlock.vue';
import GeneratedImageBlock from './GeneratedImageBlock.vue';
import StandardCodeBlock from './StandardCodeBlock.vue';

const props = defineProps<{
  code: string;
  lang: string;
}>();

const isMermaid = computed(() => props.lang === 'mermaid');
const isGeneratedImage = computed(() => props.lang === IMAGE_BLOCK_LANG);


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <MermaidBlock
    v-if="isMermaid"
    :code="code"
  />
  <GeneratedImageBlock
    v-else-if="isGeneratedImage"
    :json="code"
  />
  <StandardCodeBlock
    v-else
    :code="code"
    :lang="lang"
  />
</template>
