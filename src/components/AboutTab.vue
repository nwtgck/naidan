<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Info, ShieldCheck, Loader2 } from 'lucide-vue-next';
import Logo from './Logo.vue';

interface OssLicense {
  name: string;
  version: string;
  license: string | null;
  licenseText: string | null;
}

const isStandalone = __BUILD_MODE_IS_STANDALONE__;
const appVersion = __APP_VERSION__;

const ossLicenses = ref<OssLicense[]>([]);
const isLoadingLicenses = ref(false);

async function loadLicenses() {
  if (isStandalone || ossLicenses.value.length > 0) return;
  isLoadingLicenses.value = true;
  try {
    // Dynamic import to keep initial bundle small
    const data = await import('../assets/licenses.json');
    ossLicenses.value = data.default;
  } catch (err) {
    console.error('Failed to load licenses:', err);
  } finally {
    isLoadingLicenses.value = false;
  }
}

onMounted(() => {
  loadLicenses();
});
</script>

<template>
  <div data-testid="about-section" class="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-400">
    <section class="space-y-6">
      <div class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
        <Info class="w-5 h-5 text-blue-500" />
        <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">About Naidan</h2>
      </div>

      <div class="bg-gray-50 dark:bg-gray-800/30 rounded-3xl p-8 border border-gray-100 dark:border-gray-700 flex flex-col items-center text-center space-y-4">
        <div class="w-20 h-20 bg-white dark:bg-gray-800 rounded-2xl shadow-xl border border-gray-100 dark:border-gray-700 flex items-center justify-center mb-2">
          <Logo :size="48" />
        </div>
        <div>
          <h3 class="text-2xl font-black text-gray-800 dark:text-white tracking-tight">Naidan</h3>
          <p class="text-xs font-bold text-blue-600 dark:text-blue-400 uppercase tracking-widest mt-1">Version {{ appVersion }}</p>
        </div>
        <p class="text-sm font-medium text-gray-500 dark:text-gray-400 max-w-md leading-relaxed">
          A privacy-focused LLM interface for local use, designed to run directly from a portable directory.
        </p>
      </div>
    </section>

    <section class="space-y-6">
      <div class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
        <ShieldCheck class="w-5 h-5 text-blue-500" />
        <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Open Source Licenses</h2>
      </div>
    
      <p class="text-sm font-medium text-gray-500 dark:text-gray-400">
        Naidan is built with incredible open-source software. We are grateful to the community for their contributions.
      </p>

      <!-- Standalone Mode Info -->
      <div v-if="isStandalone" class="p-6 bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/20 rounded-3xl space-y-3">
        <div class="flex items-center gap-2 text-blue-800 dark:text-blue-300 font-bold text-sm">
          <Info class="w-4 h-4" />
          Offline License Information
        </div>
        <p class="text-xs text-blue-600 dark:text-blue-400 leading-relaxed">
          Full license texts for all third-party dependencies are included in the <strong>THIRD_PARTY_LICENSES.txt</strong> file within this application package.
        </p>
      </div>

      <!-- Hosted Mode License List -->
      <div v-else class="border border-gray-100 dark:border-gray-800 rounded-3xl overflow-hidden bg-white dark:bg-gray-900 min-h-[100px] flex flex-col items-center justify-center">
        <div v-if="isLoadingLicenses" class="p-12 flex flex-col items-center gap-3">
          <Loader2 class="w-6 h-6 text-blue-500 animate-spin" />
          <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Loading licenses...</p>
        </div>
        <div v-else class="w-full max-h-[400px] overflow-y-auto p-2 space-y-1">
          <div 
            v-for="license in ossLicenses" 
            :key="license.name"
            class="p-4 hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-2xl transition-colors group"
          >
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-bold text-gray-800 dark:text-white truncate">{{ license.name || 'Unknown Package' }}</span>
                  <span class="text-[10px] font-bold text-gray-400">v{{ license.version }}</span>
                </div>
                <div class="text-[10px] font-bold text-blue-600/70 dark:text-blue-400/60 uppercase tracking-tight mt-0.5">{{ license.license }}</div>
              </div>
            </div>
            <details class="mt-3">
              <summary class="text-[10px] font-bold text-gray-400 cursor-pointer hover:text-gray-600 dark:hover:text-gray-200 transition-colors list-none flex items-center gap-1">
                View License Text
              </summary>
              <pre class="mt-4 p-4 bg-gray-50 dark:bg-black/20 rounded-xl text-[10px] font-mono text-gray-500 dark:text-gray-400 overflow-x-auto whitespace-pre-wrap leading-relaxed border border-gray-100/50 dark:border-gray-800/50">{{ license.licenseText }}</pre>
            </details>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
