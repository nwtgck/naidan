<script setup lang="ts">
import { ref, computed } from 'vue';
import { Copy, Check, Download, ExternalLink } from 'lucide-vue-next';

const detectOS = () => {
  if (typeof window === 'undefined' || !window.navigator) return 'windows';
  const platform = (window.navigator.platform || '').toLowerCase();
  const ua = (window.navigator.userAgent || '').toLowerCase();
  if (platform.includes('mac') || ua.includes('mac')) return 'mac';
  if (platform.includes('linux') || ua.includes('linux')) return 'linux';
  return 'windows';
};

const activeOs = ref<'windows' | 'mac' | 'linux'>(detectOS());
const activeServer = ref<'ollama' | 'llama-server'>('ollama');
const copiedCommand = ref<string | null>(null);

const isFileProtocol = typeof window !== 'undefined' && window.location.protocol === 'file:';

const ollamaServeCommand = computed(() => {
  const base = 'ollama serve';
  if (isFileProtocol) {
    // Show the environment variable for CORS when on file://
    switch (activeOs.value) {
    case 'windows':
      return '$env:OLLAMA_ORIGINS="*"; ollama serve';
    case 'mac':
      return 'brew services stop ollama\nOLLAMA_ORIGINS="*" ollama serve';
    case 'linux':
      return 'OLLAMA_ORIGINS="*" ollama serve';
    default: {
      const _ex: never = activeOs.value;
      throw new Error(`Unhandled OS: ${_ex}`);
    }
    }
  }
  return base;
});

const copyToClipboard = async (text: string, id: string) => {
  await navigator.clipboard.writeText(text);
  copiedCommand.value = id;
  setTimeout(() => {
    if (copiedCommand.value === id) copiedCommand.value = null;
  }, 2000);
};

interface GuideStep {
  install: string;
  downloadUrl?: string;
  installCommand?: string;
  serveCommand?: string;
  runCommand: string;
}

const guides: {
  ollama: Record<'windows' | 'mac' | 'linux', GuideStep>;
  'llama-server': { all: GuideStep };
} = {
  ollama: {
    windows: {
      install: 'Download the installer from the official website.',
      downloadUrl: 'https://ollama.com/download/windows',
      serveCommand: 'ollama serve',
      runCommand: 'ollama run gemma3n:e2b',
    },
    mac: {
      install: 'Install using Homebrew:',
      installCommand: 'brew install ollama',
      serveCommand: 'ollama serve',
      runCommand: 'ollama run gemma3n:e2b',
    },
    linux: {
      install: 'Run the installation script:',
      installCommand: 'curl -fsSL https://ollama.com/install.sh | sh',
      serveCommand: 'ollama serve',
      runCommand: 'ollama run gemma3n:e2b',
    },
  },
  'llama-server': {
    all: {
      install: 'Download the latest binary from the llama.cpp releases page or build from source.',
      downloadUrl: 'https://github.com/ggerganov/llama.cpp/releases',
      runCommand: './llama-server -hf ggml-org/gemma-3n-E2B-it-GGUF',
    },
  },
};


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="bg-gray-50 dark:bg-gray-800/50 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
    <div class="flex border-b border-gray-200 dark:border-gray-700">
      <button
        @click="activeServer = 'ollama'"
        class="flex-1 py-3 text-sm font-semibold transition-colors"
        :class="activeServer === 'ollama' ? 'bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
      >
        Ollama
      </button>
      <button
        @click="activeServer = 'llama-server'"
        class="flex-1 py-3 text-sm font-semibold transition-colors"
        :class="activeServer === 'llama-server' ? 'bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
      >
        llama-server
      </button>
    </div>

    <div class="p-3 space-y-3">
      <div v-if="activeServer === 'ollama'" class="flex flex-wrap gap-1 p-0.5 bg-gray-100 dark:bg-gray-900 rounded-lg w-fit">
        <button
          v-for="os in (['windows', 'mac', 'linux'] as const)"
          :key="os"
          @click="activeOs = os"
          class="px-2 py-1 text-[10px] font-medium rounded-md transition-all capitalize"
          :class="activeOs === os ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
        >
          {{ os }}
        </button>
      </div>

      <div class="space-y-3">
        <div v-if="activeServer === 'ollama'">
          <div class="space-y-3">
            <div class="flex items-start gap-2">
              <div class="w-5 h-5 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center text-blue-600 dark:text-blue-400 shrink-0 mt-0.5">
                <span class="text-[10px] font-bold">1</span>
              </div>
              <div class="flex-1 min-w-0">
                <p class="text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 leading-tight">
                  {{ guides.ollama[activeOs].install }}
                </p>
                <a
                  v-if="guides.ollama[activeOs].downloadUrl"
                  :href="guides.ollama[activeOs].downloadUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-[11px] font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors max-w-full overflow-hidden"
                >
                  <Download class="w-3.5 h-3.5 shrink-0" />
                  <span class="truncate">Ollama <span class="text-[9px] opacity-80 font-bold uppercase tracking-tighter bg-amber-50 dark:bg-amber-900/20 px-1 rounded text-amber-600 dark:text-amber-400 ml-1">External</span></span>
                  <ExternalLink class="w-3 h-3 opacity-50 shrink-0" />
                </a>
                <div v-else-if="guides.ollama[activeOs].installCommand" class="relative group">
                  <pre class="bg-gray-900 text-gray-300 p-2 rounded-lg text-[10px] overflow-x-auto whitespace-pre border border-gray-800 scrollbar-none"><code>{{ guides.ollama[activeOs].installCommand }}</code></pre>
                  <button
                    @click="copyToClipboard(guides.ollama[activeOs].installCommand!, 'ollama-install')"
                    class="absolute top-1 right-1 p-1 text-gray-400 hover:text-white transition-colors bg-gray-900/80 rounded"
                  >
                    <Check v-if="copiedCommand === 'ollama-install'" class="w-3 h-3 text-white" />
                    <Copy v-else class="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>

            <div class="flex items-start gap-2">
              <div class="w-5 h-5 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center text-blue-600 dark:text-blue-400 shrink-0 mt-0.5">
                <span class="text-[10px] font-bold">2</span>
              </div>
              <div class="flex-1 min-w-0 space-y-2">
                <div>
                  <p class="text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 leading-tight">
                    Start Server:
                  </p>
                  <div class="relative group">
                    <pre class="bg-gray-900 text-gray-300 p-2 rounded-lg text-[10px] overflow-x-auto whitespace-pre border border-gray-800 scrollbar-none"><code>{{ ollamaServeCommand }}</code></pre>
                    <button
                      @click="copyToClipboard(ollamaServeCommand, 'ollama-serve')"
                      class="absolute top-1 right-1 p-1 text-gray-400 hover:text-white transition-colors bg-gray-900/80 rounded"
                    >
                      <Check v-if="copiedCommand === 'ollama-serve'" class="w-3 h-3 text-white" />
                      <Copy v-else class="w-3 h-3" />
                    </button>
                  </div>
                </div>
                <div>
                  <p class="text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 leading-tight">
                    Run Gemma 3n:
                  </p>
                  <div class="relative group">
                    <pre class="bg-gray-900 text-gray-300 p-2 rounded-lg text-[10px] overflow-x-auto whitespace-pre border border-gray-800 scrollbar-none"><code>{{ guides.ollama[activeOs].runCommand }}</code></pre>
                    <button
                      @click="copyToClipboard(guides.ollama[activeOs].runCommand, 'ollama-run')"
                      class="absolute top-1 right-1 p-1 text-gray-400 hover:text-white transition-colors bg-gray-900/80 rounded"
                    >
                      <Check v-if="copiedCommand === 'ollama-run'" class="w-3 h-3 text-white" />
                      <Copy v-else class="w-3 h-3" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-else class="space-y-3">
          <div class="flex items-start gap-2">
            <div class="w-5 h-5 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center text-blue-600 dark:text-blue-400 shrink-0 mt-0.5">
              <span class="text-[10px] font-bold">1</span>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 leading-tight">
                {{ guides['llama-server'].all.install }}
              </p>
              <a
                :href="guides['llama-server'].all.downloadUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-[11px] font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors max-w-full overflow-hidden"
              >
                <Download class="w-3.5 h-3.5 shrink-0" />
                <span class="truncate">Releases <span class="text-[9px] opacity-80 font-bold uppercase tracking-tighter bg-amber-50 dark:bg-amber-900/20 px-1 rounded text-amber-600 dark:text-amber-400 ml-1">External</span></span>
                <ExternalLink class="w-3 h-3 opacity-50 shrink-0" />
              </a>
            </div>
          </div>

          <div class="flex items-start gap-2">
            <div class="w-5 h-5 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center text-blue-600 dark:text-blue-400 shrink-0 mt-0.5">
              <span class="text-[10px] font-bold">2</span>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 leading-tight">
                Run Gemma 3n:
              </p>
              <div class="relative group">
                <pre class="bg-gray-900 text-gray-300 p-2 rounded-lg text-[10px] overflow-x-auto whitespace-pre border border-gray-800 scrollbar-none"><code>{{ guides['llama-server'].all.runCommand }}</code></pre>
                <button
                  @click="copyToClipboard(guides['llama-server'].all.runCommand, 'llama-run')"
                  class="absolute top-1 right-1 p-1 text-gray-400 hover:text-white transition-colors bg-gray-900/80 rounded"
                >
                  <Check v-if="copiedCommand === 'llama-run'" class="w-3 h-3 text-white" />
                  <Copy v-else class="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
