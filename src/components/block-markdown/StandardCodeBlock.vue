<script setup lang="ts">
import { ref, computed, onBeforeUpdate, onUpdated } from 'vue';
import { highlightCode } from './useMarkdown';
import { Check, Copy, Terminal, WrapText } from 'lucide-vue-next';
import { useCodeBlockSettings } from '@/composables/useCodeBlockSettings';

const props = defineProps<{
  code: string;
  lang: string;
}>();

const { isLineWrapEnabled, toggleLineWrap } = useCodeBlockSettings();

const preRef = ref<HTMLElement | null>(null);
const scrollState = ref({ top: 0, left: 0 });

const highlightedCode = computed(() => {
  return highlightCode({ code: props.code, lang: props.lang });
});

// Scroll preservation logic
onBeforeUpdate(() => {
  if (preRef.value) {
    scrollState.value = {
      top: preRef.value.scrollTop,
      left: preRef.value.scrollLeft
    };
  }
});

onUpdated(() => {
  if (preRef.value) {
    preRef.value.scrollTop = scrollState.value.top;
    preRef.value.scrollLeft = scrollState.value.left;
  }
});

const copied = ref(false);

async function copyCode() {
  try {
    await navigator.clipboard.writeText(props.code);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch (err) {
    console.error('Failed to copy code:', err);
  }
}


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="code-block-wrapper my-4 rounded-lg overflow-hidden border border-gray-700/50 bg-[#0d1117] group/code shadow-sm">
    <div class="flex items-center justify-between px-3 py-1.5 bg-gray-800/50 border-b border-gray-700/50 text-xs text-gray-400">
      <div class="flex items-center gap-2">
        <Terminal class="w-3 h-3 opacity-50" />
        <span class="font-mono font-medium">{{ lang || 'text' }}</span>
      </div>
      <div class="flex items-center gap-2.5">
        <button
          @click="toggleLineWrap"
          class="flex items-center hover:text-white transition-colors cursor-pointer"
          :class="isLineWrapEnabled ? 'text-indigo-400' : 'text-gray-400'"
          title="Toggle line wrap"
        >
          <WrapText class="w-3.5 h-3.5" />
        </button>
        <button
          @click="copyCode"
          class="flex items-center hover:text-white transition-colors cursor-pointer"
          :class="copied ? 'text-green-400' : 'text-gray-400'"
          :title="copied ? 'Copied' : 'Copy code'"
        >
          <Check v-if="copied" class="w-3.5 h-3.5" />
          <Copy v-else class="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
    <pre
      ref="preRef"
      class="!m-0 !p-4 !bg-transparent scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent"
      :class="isLineWrapEnabled ? 'whitespace-pre-wrap break-words overflow-x-hidden' : 'whitespace-pre overflow-x-auto'"
    ><code
      ref="codeRef"
      class="!bg-transparent !p-0 !border-none !text-sm font-mono leading-relaxed !text-gray-200"
      v-html="highlightedCode"
    ></code></pre>
  </div>
</template>
