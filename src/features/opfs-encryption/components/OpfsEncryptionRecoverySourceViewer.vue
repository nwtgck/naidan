<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { CheckIcon, ClipboardIcon, DownloadIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';

const language = ref<'node' | 'go'>('node');
const copied = ref(false);
const source = ref('');
const loading = ref(false);
const filename = computed(() => {
  const value = language.value;
  switch (value) {
  case 'node':
    return 'naidan-recover.mjs';
  case 'go':
    return 'naidan-recover.go';
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled recovery source language: ${String(_ex)}`);
  }
  }
});

async function loadSource(): Promise<void> {
  loading.value = true;
  copied.value = false;
  try {
    const value = language.value;
    switch (value) {
    case 'node': {
      const module = await import('@/00-storage/service/opfs-encryption/recovery/naidan-recover.mjs?raw');
      source.value = module.default;
      break;
    }
    case 'go': {
      const module = await import('@/00-storage/service/opfs-encryption/recovery/naidan-recover.go?raw');
      source.value = module.default;
      break;
    }
    default: {
      const _ex: never = value;
      throw new Error(`Unhandled recovery source language: ${String(_ex)}`);
    }
    }
  } finally {
    loading.value = false;
  }
}

async function copySource(): Promise<void> {
  await navigator.clipboard.writeText(source.value);
  copied.value = true;
}

function saveSource(): void {
  const blob = new Blob([source.value], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename.value;
  anchor.click();
  URL.revokeObjectURL(url);
}

watch(language, () => {
  void loadSource();
});

onMounted(() => {
  void loadSource();
});

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      loadSource,
    },
  }) || {}),
});
</script>

<template>
  <section tw-class="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
    <header tw-class="px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex flex-wrap items-center justify-between gap-3">
      <div tw-class="inline-flex p-1 bg-gray-100 dark:bg-gray-800 rounded-lg">
        <button type="button" tw-class="px-3 py-1.5 rounded-md text-[11px] font-bold" :class="language === 'node' ? 'bg-white dark:bg-gray-700 shadow-sm' : 'text-gray-500'" @click="language = 'node'">Node.js</button>
        <button type="button" tw-class="px-3 py-1.5 rounded-md text-[11px] font-bold" :class="language === 'go' ? 'bg-white dark:bg-gray-700 shadow-sm' : 'text-gray-500'" @click="language = 'go'">Go</button>
      </div>
      <div tw-class="flex gap-2">
        <button type="button" tw-class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800" :title="lazyStrings.opfsEncryption__copy_source()" @click="copySource">
          <CheckIcon v-if="copied" tw-class="w-4 h-4" />
          <ClipboardIcon v-else tw-class="w-4 h-4" />
        </button>
        <button type="button" tw-class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800" :title="lazyStrings.opfsEncryption__save_source()" @click="saveSource"><DownloadIcon tw-class="w-4 h-4" /></button>
      </div>
    </header>
    <div v-if="loading" tw-class="h-40 flex items-center justify-center bg-gray-950 text-xs text-gray-400">
      {{ lazyStrings.opfsEncryption__loading_recovery_source() }}
    </div>
    <pre v-else tw-class="max-h-80 overflow-auto bg-gray-950 text-gray-200 p-4 text-[10px] leading-relaxed"><code>{{ source }}</code></pre>
  </section>
</template>
