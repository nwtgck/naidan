<script setup lang="ts">
import { usePortableAppDownload } from '@/features/file-protocol-standalone/composables/usePortableAppDownload';
import { BookOpenIcon, InfoIcon, GithubIcon, DownloadIcon, ExternalLinkIcon } from 'lucide-vue-next';
import Logo from './Logo.vue';
import OpenSourceLicenses from './OpenSourceLicenses.vue';
import { lazyStrings } from '@/strings';

const props = defineProps<{
  visibility: 'visible' | 'hidden',
}>();

const isStandalone = __BUILD_MODE_IS_STANDALONE__;
const appVersion = __APP_VERSION__;
const portableAppDownload = usePortableAppDownload({ version: appVersion });
const documentationUrl = 'https://naidan.pages.dev/docs';
const isDocumentationExternal = location.origin !== new URL(documentationUrl).origin;

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div data-testid="about-section" class="animate-in fade-in slide-in-from-bottom-2" tw-class="@container space-y-7 duration-300">
    <section tw-class="space-y-5">
      <div tw-class="flex items-center gap-2.5 border-b border-gray-200/70 pb-4 dark:border-gray-800">
        <InfoIcon aria-hidden="true" tw-class="h-5 w-5 shrink-0 text-blue-500 dark:text-blue-400" />
        <h2 tw-class="text-lg font-semibold tracking-tight text-gray-800 dark:text-gray-100">{{ lazyStrings.AboutTab__about_naidan() }}</h2>
      </div>

      <div tw-class="flex flex-col items-center space-y-4 rounded-2xl border border-gray-200/80 bg-gray-50/60 px-5 py-7 text-center dark:border-gray-800 dark:bg-gray-900/30 sm:py-8">
        <div tw-class="flex h-20 w-20 items-center justify-center rounded-2xl border border-gray-200/80 bg-white shadow-sm dark:border-gray-700/70 dark:bg-gray-800/45">
          <Logo :size="48" />
        </div>
        <div>
          <h3 tw-class="text-2xl font-bold tracking-tight text-gray-800 dark:text-gray-100">Naidan</h3>
          <p tw-class="mt-1 break-all text-sm font-medium text-blue-600 dark:text-blue-400">{{ lazyStrings.AboutTab__version({ version: appVersion }) }}</p>
        </div>
        <p tw-class="max-w-md text-sm leading-relaxed text-gray-600 dark:text-gray-300">{{ lazyStrings.AboutTab__privacy_focused_local_lm_interface() }}</p>
      </div>

      <div :tw-class="['grid grid-cols-1 gap-3 @lg:grid-cols-2', !isStandalone && '@2xl:grid-cols-3']">
        <a
          :href="documentationUrl"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="documentation-link"
          tw-class="flex min-w-0 items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 no-underline transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:border-slate-700/70 dark:bg-slate-800/45 dark:hover:border-slate-600 dark:hover:bg-slate-800 motion-reduce:transition-none @2xl:gap-2 @2xl:p-3"
        >
          <span tw-class="flex h-10 w-10 shrink-0 @2xl:h-8 @2xl:w-8 items-center justify-center rounded-lg bg-blue-50 text-blue-500 dark:bg-blue-500/10 dark:text-blue-400">
            <BookOpenIcon aria-hidden="true" tw-class="h-5 w-5" />
          </span>
          <div tw-class="min-w-0 flex-1">
            <div tw-class="flex items-center justify-between gap-2 text-sm font-medium text-gray-700 dark:text-gray-200">
              <span>{{ lazyStrings.AboutTab__documentation() }}</span>
              <ExternalLinkIcon v-if="isDocumentationExternal" data-testid="documentation-external-icon" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
            </div>
            <p tw-class="mt-1 text-sm leading-relaxed @2xl:text-xs text-gray-600 dark:text-gray-300">{{ lazyStrings.AboutTab__learn_how_to_use_naidan() }}</p>
          </div>
        </a>

        <a
          href="https://github.com/nwtgck/naidan"
          target="_blank"
          rel="noopener noreferrer"
          tw-class="flex min-w-0 items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 no-underline transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:border-slate-700/70 dark:bg-slate-800/45 dark:hover:border-slate-600 dark:hover:bg-slate-800 motion-reduce:transition-none @2xl:gap-2 @2xl:p-3"
        >
          <span tw-class="flex h-10 w-10 shrink-0 @2xl:h-8 @2xl:w-8 items-center justify-center rounded-lg bg-gray-50 text-gray-500 dark:bg-gray-900/50 dark:text-gray-400">
            <GithubIcon aria-hidden="true" tw-class="h-5 w-5" />
          </span>
          <div tw-class="min-w-0 flex-1">
            <div tw-class="flex items-center justify-between gap-2 text-sm font-medium text-gray-700 dark:text-gray-200">
              <span>{{ lazyStrings.AboutTab__github_repository() }}</span>
              <ExternalLinkIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
            </div>
            <p tw-class="mt-1 text-sm leading-relaxed @2xl:text-xs text-gray-600 dark:text-gray-300">{{ lazyStrings.AboutTab__view_source_code() }}</p>
          </div>
        </a>

        <a
          v-if="!isStandalone"
          :href="portableAppDownload.href"
          :download="portableAppDownload.fileName"
          :aria-label="lazyStrings.SHARED__download_portable_html_edition()"
          data-testid="portable-html-download"
          tw-class="flex min-w-0 items-start gap-3 rounded-xl border border-green-200 bg-green-50/70 p-4 no-underline transition-colors hover:border-green-300 hover:bg-green-100/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500/40 dark:border-green-900/40 dark:bg-green-900/10 dark:hover:border-green-800 dark:hover:bg-green-900/20 motion-reduce:transition-none @2xl:gap-2 @2xl:p-3"
        >
          <span tw-class="flex h-10 w-10 shrink-0 @2xl:h-8 @2xl:w-8 items-center justify-center rounded-lg bg-green-100/80 text-green-600 dark:bg-green-500/15 dark:text-green-400">
            <DownloadIcon aria-hidden="true" tw-class="h-5 w-5" />
          </span>
          <div tw-class="min-w-0 flex-1">
            <div tw-class="flex flex-wrap items-center gap-2 text-sm font-medium text-green-800 dark:text-green-300">
              <span>{{ lazyStrings.SHARED__portable_html_edition() }}</span>
              <span tw-class="rounded border border-green-300/60 px-1.5 py-0.5 text-xs leading-none text-green-700 dark:border-green-700/60 dark:text-green-400">ZIP</span>
            </div>
            <p tw-class="mt-1 text-sm leading-relaxed @2xl:text-xs text-green-700 dark:text-green-300">{{ lazyStrings.SHARED__extract_the_zip_and_open_index_html_no_http_server_required() }}</p>
          </div>
        </a>
      </div>
    </section>

    <OpenSourceLicenses v-if="props.visibility === 'visible'" />
  </div>
</template>
