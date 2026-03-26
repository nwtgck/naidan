<script setup lang="ts">
import { ref, onMounted, watch, nextTick } from 'vue';
import mermaid from 'mermaid';
import { Check, Copy, Code, Layout, Columns } from 'lucide-vue-next';

const props = defineProps<{
  code: string;
}>();

const containerRef = ref<HTMLElement | null>(null);
const renderRef = ref<HTMLElement | null>(null);
const mode = ref<'preview' | 'code' | 'both'>('preview');
const copied = ref(false);

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
});

async function render() {
  if (!containerRef.value || !renderRef.value) return;

  // Clear previous render
  renderRef.value.innerHTML = props.code;
  renderRef.value.removeAttribute('data-processed');

  try {
    await mermaid.run({
      nodes: [renderRef.value],
    });
  } catch (e) {
    console.error('Mermaid render error:', e);
    if (renderRef.value) {
      renderRef.value.innerHTML = `<div class="text-red-500 text-xs p-2">Failed to render mermaid diagram</div>`;
    }
  }
}

watch(() => props.code, () => {
  switch (mode.value) {
  case 'preview':
  case 'both':
    render();
    break;
  case 'code':
    break;
  default: {
    const _ex: never = mode.value;
    throw new Error(`Unhandled mode: ${_ex}`);
  }
  }
}, { flush: 'post' });

onMounted(() => {
  switch (mode.value) {
  case 'preview':
  case 'both':
    render();
    break;
  case 'code':
    break;
  default: {
    const _ex: never = mode.value;
    throw new Error(`Unhandled mode: ${_ex}`);
  }
  }
});

watch(mode, (newMode) => {
  switch (newMode) {
  case 'preview':
  case 'both':
    nextTick(render);
    break;
  case 'code':
    break;
  default: {
    const _ex: never = newMode;
    throw new Error(`Unhandled mode: ${_ex}`);
  }
  }
});

async function copyCode() {
  try {
    await navigator.clipboard.writeText(props.code);
    copied.value = true;
    setTimeout(() => copied.value = false, 2000);
  } catch (e) {
    console.error(e);
  }
}


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="mermaid-block relative group/mermaid my-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden" ref="containerRef">
    <!-- Toolbar -->
    <div class="flex items-center justify-between p-2 border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/50 backdrop-blur-sm">
      <div class="flex items-center gap-1 bg-gray-200/50 dark:bg-gray-700/50 p-1 rounded-lg">
        <button
          @click="mode = 'preview'"
          class="p-1.5 rounded-md transition-all"
          :class="mode === 'preview' ? 'bg-white dark:bg-gray-600 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
          title="Preview"
        >
          <Layout class="w-4 h-4" />
        </button>
        <button
          @click="mode = 'code'"
          class="p-1.5 rounded-md transition-all"
          :class="mode === 'code' ? 'bg-white dark:bg-gray-600 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
          title="Code"
        >
          <Code class="w-4 h-4" />
        </button>
        <button
          @click="mode = 'both'"
          class="p-1.5 rounded-md transition-all"
          :class="mode === 'both' ? 'bg-white dark:bg-gray-600 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
          title="Split View"
        >
          <Columns class="w-4 h-4" />
        </button>
      </div>

      <button
        @click="copyCode"
        class="p-1.5 rounded-md transition-all text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
        :title="copied ? 'Copied' : 'Copy Source'"
      >
        <Check v-if="copied" class="w-4 h-4 text-green-500" />
        <Copy v-else class="w-4 h-4" />
      </button>
    </div>

    <div class="relative">
      <!-- Preview Area -->
      <div
        v-show="mode !== 'code'"
        class="p-4 overflow-auto flex justify-center bg-white dark:bg-[#0d1117]"
        :class="{ 'border-b border-gray-100 dark:border-gray-800': mode === 'both' }"
      >
        <div ref="renderRef" class="mermaid"></div>
      </div>

      <!-- Code Area -->
      <div v-show="mode !== 'preview'" class="bg-[#0d1117] p-4 overflow-auto max-h-[300px]">
        <pre class="!m-0 !p-0 !bg-transparent text-xs font-mono text-gray-300 whitespace-pre"><code>{{ code }}</code></pre>
      </div>
    </div>
  </div>
</template>
