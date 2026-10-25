<script setup lang="ts">
import { usePortableAppDownload } from '@/features/file-protocol-standalone/composables/usePortableAppDownload';
import { InfoIcon, GithubIcon, DownloadIcon, ExternalLinkIcon } from 'lucide-vue-next';
import Logo from './Logo.vue';
import OpenSourceLicenses from './OpenSourceLicenses.vue';
import { lazyStrings } from '@/strings';

const props = defineProps<{
  visibility: 'visible' | 'hidden',
}>();

const isStandalone = __BUILD_MODE_IS_STANDALONE__;
const appVersion = __APP_VERSION__;
const portableAppDownload = usePortableAppDownload({ version: appVersion });

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div data-testid="about-section" class="animate-in fade-in slide-in-from-bottom-2" tw-class="space-y-10 duration-400">
    <section tw-class="space-y-6">
      <div tw-class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
        <InfoIcon tw-class="w-5 h-5 text-blue-500" />
        <h2 tw-class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.AboutTab__about_naidan() }}</h2>
      </div>

      <div tw-class="bg-gray-50 dark:bg-gray-800/30 rounded-3xl p-8 border border-gray-100 dark:border-gray-700 flex flex-col items-center text-center space-y-4">
        <div tw-class="w-20 h-20 bg-white dark:bg-gray-800 rounded-2xl shadow-xl border border-gray-100 dark:border-gray-700 flex items-center justify-center mb-2">
          <Logo :size="48" />
        </div>
        <div>
          <h3 tw-class="text-2xl font-black text-gray-800 dark:text-white tracking-tight">Naidan</h3>
          <p tw-class="text-xs font-bold text-blue-600 dark:text-blue-400 uppercase tracking-widest mt-1">{{ lazyStrings.AboutTab__version({ version: appVersion }) }}</p>
        </div>
        <p tw-class="text-sm font-medium text-gray-500 dark:text-gray-400 max-w-md leading-relaxed">
          {{ lazyStrings.AboutTab__privacy_focused_local_lm_interface() }}
        </p>
      </div>

      <div tw-class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-4">
        <a
          href="https://github.com/nwtgck/naidan"
          target="_blank"
          rel="noopener noreferrer"
          tw-class="flex items-center gap-4 p-4 bg-white dark:bg-gray-800 dark:hover:bg-gray-700 border border-gray-100 dark:border-gray-700 rounded-3xl hover:bg-gray-50 transition-all group no-underline shadow-sm"
        >
          <div tw-class="shrink-0 p-3 bg-gray-50 dark:bg-gray-900 rounded-2xl text-gray-400 group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
            <GithubIcon tw-class="w-6 h-6" />
          </div>
          <div tw-class="flex-1 min-w-0">
            <div tw-class="text-sm font-bold text-gray-800 dark:text-white flex items-center gap-2">
              {{ lazyStrings.AboutTab__github_repository() }}
              <ExternalLinkIcon tw-class="w-3 h-3 shrink-0 opacity-50" />
            </div>
            <div tw-class="text-xs text-gray-500 dark:text-gray-400 font-medium">{{ lazyStrings.AboutTab__view_source_code_and_contribute() }}</div>
          </div>
        </a>

        <a
          v-if="!isStandalone"
          :href="portableAppDownload.href"
          :download="portableAppDownload.fileName"
          :aria-label="lazyStrings.SHARED__download_portable_html_edition()"
          data-testid="portable-html-download"
          tw-class="flex items-center gap-4 p-4 bg-green-50 dark:bg-green-900/10 hover:bg-green-100 dark:hover:bg-green-900/20 border border-green-200 dark:border-green-900/30 rounded-3xl transition-all group no-underline"
        >
          <div tw-class="shrink-0 p-3 bg-green-100 dark:bg-green-800/50 rounded-2xl text-green-600 dark:text-green-400 group-hover:scale-110 transition-transform">
            <DownloadIcon tw-class="w-6 h-6" />
          </div>
          <div tw-class="flex-1 min-w-0">
            <div tw-class="flex flex-wrap items-center gap-2 text-sm font-bold text-green-800 dark:text-green-300"><span>{{ lazyStrings.SHARED__portable_html_edition() }}</span><span tw-class="rounded border border-green-300/50 px-1 py-0.5 text-[9px] font-medium leading-none text-green-600/80 dark:border-green-600/40 dark:text-green-400/80">ZIP</span></div>
            <div tw-class="mt-1 text-xs font-medium leading-relaxed text-green-700/75 dark:text-green-300/70">{{ lazyStrings.SHARED__extract_the_zip_and_open_index_html_no_http_server_required() }}</div>
          </div>
        </a>
      </div>
    </section>

    <OpenSourceLicenses v-if="props.visibility === 'visible'" />
  </div>
</template>
