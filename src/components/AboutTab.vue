<script setup lang="ts">
import type { NaidanLicense } from '@/01-models/naidan-license';
import { ref, onMounted } from 'vue';
import { InfoIcon, ShieldCheckIcon, Loader2Icon, GithubIcon, DownloadIcon, ExternalLinkIcon } from 'lucide-vue-next';
import Logo from './Logo.vue';
import { lazyStrings } from '@/strings';

const isStandalone = __BUILD_MODE_IS_STANDALONE__;
const appVersion = __APP_VERSION__;

const ossLicenses = ref<readonly NaidanLicense[]>([]);
const isLoadingLicenses = ref(false);

async function loadLicenses(): Promise<void> {
  if (ossLicenses.value.length > 0) return;
  isLoadingLicenses.value = true;
  try {
    // Dynamic import to keep initial bundle small
    const data = await import('virtual:naidan-licenses');
    ossLicenses.value = data.default;
  } catch (error) {
    console.error('Failed to load licenses:', error);
  } finally {
    isLoadingLicenses.value = false;
  }
}

onMounted(() => {
  loadLicenses();
});

defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <div data-testid="about-section" class="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-400">
    <section class="space-y-6">
      <div class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
        <InfoIcon class="w-5 h-5 text-blue-500" />
        <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.AboutTab__about_naidan() }}</h2>
      </div>

      <div class="bg-gray-50 dark:bg-gray-800/30 rounded-3xl p-8 border border-gray-100 dark:border-gray-700 flex flex-col items-center text-center space-y-4">
        <div class="w-20 h-20 bg-white dark:bg-gray-800 rounded-2xl shadow-xl border border-gray-100 dark:border-gray-700 flex items-center justify-center mb-2">
          <Logo :size="48" />
        </div>
        <div>
          <h3 class="text-2xl font-black text-gray-800 dark:text-white tracking-tight">Naidan</h3>
          <p class="text-xs font-bold text-blue-600 dark:text-blue-400 uppercase tracking-widest mt-1">{{ lazyStrings.AboutTab__version({ version: appVersion }) }}</p>
        </div>
        <p class="text-sm font-medium text-gray-500 dark:text-gray-400 max-w-md leading-relaxed">
          {{ lazyStrings.AboutTab__privacy_focused_local_lm_interface() }}
        </p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <a
          href="https://github.com/nwtgck/naidan"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-4 p-4 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-3xl hover:bg-gray-50 dark:hover:bg-gray-750 transition-all group no-underline shadow-sm"
        >
          <div class="p-3 bg-gray-50 dark:bg-gray-900 rounded-2xl text-gray-400 group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
            <GithubIcon class="w-6 h-6" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-bold text-gray-800 dark:text-white flex items-center gap-2">
              {{ lazyStrings.AboutTab__github_repository() }}
              <ExternalLinkIcon class="w-3 h-3 opacity-50" />
            </div>
            <div class="text-xs text-gray-500 dark:text-gray-400 font-medium">{{ lazyStrings.AboutTab__view_source_code_and_contribute() }}</div>
          </div>
        </a>

        <a
          v-if="!isStandalone"
          href="./naidan-standalone.zip"
          :download="'naidan-standalone-v' + appVersion + '.zip'"
          class="flex items-center gap-4 p-4 bg-green-50 dark:bg-green-900/10 hover:bg-green-100 dark:hover:bg-green-900/20 border border-green-200 dark:border-green-900/30 rounded-3xl transition-all group no-underline"
        >
          <div class="p-3 bg-green-100 dark:bg-green-800/50 rounded-2xl text-green-600 dark:text-green-400 group-hover:scale-110 transition-transform">
            <DownloadIcon class="w-6 h-6" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-bold text-green-800 dark:text-green-300">{{ lazyStrings.AboutTab__standalone_app() }}</div>
            <div class="text-xs text-green-600/70 dark:text-green-400/60 font-medium">{{ lazyStrings.AboutTab__runs_locally_via_file_protocol() }}</div>
          </div>
        </a>
      </div>
    </section>

    <section class="space-y-6">
      <div class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
        <ShieldCheckIcon class="w-5 h-5 text-blue-500" />
        <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.AboutTab__open_source_licenses() }}</h2>
      </div>

      <p class="text-sm font-medium text-gray-500 dark:text-gray-400">
        {{ lazyStrings.AboutTab__built_with_open_source_software() }}
      </p>

      <div data-testid="oss-license-list" class="border border-gray-100 dark:border-gray-800 rounded-3xl overflow-hidden bg-white dark:bg-gray-900 min-h-[100px] flex flex-col items-center justify-center">
        <div v-if="isLoadingLicenses" data-testid="oss-license-loading" class="p-12 flex flex-col items-center gap-3">
          <Loader2Icon class="w-6 h-6 text-blue-500 animate-spin" />
          <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{{ lazyStrings.AboutTab__loading_licenses() }}</p>
        </div>
        <div v-else class="w-full max-h-[400px] overflow-y-auto p-2 space-y-1 overscroll-contain">
          <div
            v-for="license in ossLicenses"
            :key="`${license.name}@${license.version}`"
            data-testid="oss-license-item"
            class="p-4 hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-2xl transition-colors group"
          >
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-bold text-gray-800 dark:text-white truncate">{{ license.name || lazyStrings.AboutTab__unknown_package() }}</span>
                  <span class="text-[10px] font-bold text-gray-400">v{{ license.version }}</span>
                </div>
                <div class="text-[10px] font-bold text-blue-600/70 dark:text-blue-400/60 uppercase tracking-tight mt-0.5">{{ license.license }}</div>
              </div>
            </div>
            <details class="mt-3">
              <summary class="text-[10px] font-bold text-gray-400 cursor-pointer hover:text-gray-600 dark:hover:text-gray-200 transition-colors list-none flex items-center gap-1">
                {{ lazyStrings.AboutTab__view_license_text() }}
              </summary>
              <pre class="mt-4 p-4 bg-gray-50 dark:bg-black/20 rounded-xl text-[10px] font-mono text-gray-500 dark:text-gray-400 overflow-x-auto whitespace-pre-wrap leading-relaxed border border-gray-100/50 dark:border-gray-800/50">{{ license.licenseText }}</pre>
            </details>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
